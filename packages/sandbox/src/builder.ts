import { spawn } from "node:child_process";
import { mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { cacheDir } from "@isolade/shared/node/xdg";
import { Destination, type ExecHandle, type NetworkPolicy, Rule, Sandbox } from "microsandbox";
import {
  deleteManifestByTag,
  parseImageRef,
  runMicrosandboxGc,
  runRegistryGarbageCollect,
} from "./builds";
import {
  detectHostIp,
  getLocalRegistryLoopbackEndpoint,
  getLocalRegistryPort,
} from "./host-network";
import { msbBinDir } from "./msb-home";
import { getHostCpuCount, getVmMemoryMib } from "./vms";

const DEFAULT_BUILDKIT_IMAGE =
  process.env.ISOLADE_BUILDKIT_IMAGE || "docker.io/moby/buildkit:v0.16.0";
// Short names: microsandbox creates `<HOME>/.microsandbox/sandboxes/<name>/
// runtime/agent.sock` and macOS caps UNIX socket paths at 104 bytes (SUN_LEN).
const BUILDER_NAME = "gcb-builder";
const DISK_INIT_SANDBOX_NAME = "gcb-disk-init";

// buildkit's content store and snapshot tree live on a virtio-blk disk
// formatted ext4, mounted at /var/lib/buildkit. The win is virtio-blk vs
// virtio-fs (named volumes): virtio-fs routes every metadata op (open,
// stat, mkdir, rename, unlink) through a userspace passthroughfs daemon.
// buildkit's CAS layout + snapshotter does *millions* of these per build,
// and the daemon hop dominates wall-clock time. virtio-blk hands raw
// blocks. The guest's own ext4 runs in-kernel with normal page/dentry
// caches. ext4 (vs btrfs) because the kernel overlayfs snapshotter handles
// CoW itself. The underlying fs just needs to be fast for small-file
// I/O, and ext4 wins that microbenchmark (no per-extent checksums, no CoW
// bookkeeping, simpler journal).
// Disk file is sparse (allocates on write), so the 30 GiB ceiling is a cap,
// not a reservation. Cache survives across `bun run dev` restarts. Delete
// the file to reset.
//
// Resolved lazily so test setup (which re-roots $HOME via libc setenv after
// import) gets the rerouted path rather than the original HOME captured at
// module load.
function resolveCacheDiskPath(): string {
  return process.env.ISOLADE_BUILDKIT_CACHE_DISK || join(cacheDir(), "buildkit.ext4");
}

const CACHE_DISK_SIZE_GIB = 160;
// Tell buildkit to GC down to ~62% of disk capacity. That leaves ~60 GiB headroom
// so a fat in-flight RUN step (e.g. nix-built derivations with thousands of
// npm deps) doesn't hit ENOSPC on the overlay upper layer before pruning
// kicks in. Sparse host file, so the disk size cap doesn't cost real bytes
// until used.
const CACHE_GC_KEEP_MIB = 100 * 1024;
// Per-stage budgets for the custom GC policy below. The default policy is
// uniform across record types. Under disk pressure it evicts cache mounts
// (which hold our nix binary cache) just as readily as ephemeral RUN-result
// layers. We instead carve out an explicit budget per type so the persistent
// caches survive the next round of pruning.
//   * exec.cachemount: --mount=type=cache content (nix-cache, apt, npm…).
//     45 GiB fits a populated nix dev shell plus apt + npm caches without
//     dominating the disk.
//   * layer cache (RUN results, FROM image extracts): 45 GiB. Sized to
//     match cachemount so a fat layer build doesn't trigger evictions
//     mid-build under realistic workspace sizes.
//   * internal / source records (build context, dockerfile, frontend):
//     tiny in practice, and 5 GiB is generous.
// Sum of typed budgets (95 GiB) sits just under the 100 GiB catch-all
// ceiling defined by CACHE_GC_KEEP_MIB.
const CACHE_GC_CACHEMOUNT_GIB = 45;
const CACHE_GC_LAYERS_GIB = 45;
const CACHE_GC_INTERNAL_GIB = 5;
// macOS doesn't ship mkfs.ext4, so we delegate the one-time format step to
// a small helper VM. The image must ship mkfs.ext4. We don't install it at
// runtime, so the APK/APT package mirrors don't need to be reachable when
// the cache disk is first provisioned. Default is Ubuntu's official base,
// which has e2fsprogs preinstalled (it's Priority:required, so even the
// minimal image ships it). Override if you've baked e2fsprogs somewhere
// else (must still have mkfs.ext4 on PATH).
const DISK_INIT_IMAGE = process.env.ISOLADE_DISK_INIT_IMAGE || "docker.io/library/ubuntu:26.04";

// Generous: a cold microsandbox boot plus first-time pull of moby/buildkit can
// take a while on slow networks. Cached subsequent boots are seconds.
const BUILDKIT_READY_TIMEOUT_MS = 60_000;

export interface BuilderManagerOpts {
  buildkitImage?: string;
}

// Drives image builds in a microsandbox VM running buildkitd. The VM is
// booted on demand for each runBuild and torn down when the build finishes,
// so we don't hold a multi-GB VM resident in the gaps between builds. The
// buildkit layer cache (FROM image content store, RUN-step layer outputs,
// mount caches) lives on a host-side ext4 disk image (see
// resolveCacheDiskPath) that's re-attached on every boot, so cache hits
// survive across builds, across workspaces, and across process restarts.
// Delete that file for a fresh slate.
export class BuilderManager {
  private sandbox: Sandbox | null = null;
  private buildkitHandle: ExecHandle | null = null;
  private starting: Promise<{
    sandbox: Sandbox;
    buildkitHandle: ExecHandle;
  }> | null = null;
  private hostIp: string | null = null;
  private registry: string | null = null;
  // Single async chain that serializes builds and registry GC. GC is
  // destructive (deletes manifests + reclaims blobs) and the registry docs
  // require no concurrent writes during `garbage-collect`. Builds also push
  // through this chain so a GC in front of them blocks until they finish, and
  // a build in front of GC blocks GC until the push completes.
  private opChain: Promise<unknown> = Promise.resolve();

  constructor(private opts: BuilderManagerOpts = {}) {}

  // The registry endpoint as seen from inside microsandbox VMs (and from the
  // host, since the bridge IP resolves on both sides). Image refs we hand out use
  // this prefix so the same string works for the build push and for later
  // microsandbox image pulls.
  registryEndpoint(): string {
    this.ensureConfig();
    return this.registry!;
  }

  // Resolve hostIp + registry once per BuilderManager instance. Synchronous
  // (detectHostIp is sync), so safe to call from the constructor of behavior
  // that depends on these values. If hostIp has been set out-of-band (e.g.
  // bootBuilder() asked the running guest for its default gateway), that
  // value is preferred over host-side interface parsing.
  private ensureConfig() {
    if (this.registry) return;
    const ip = this.hostIp ?? detectHostIp();
    if (!ip) {
      throw new Error(
        "BuilderManager: could not detect host bridge IP. " +
          "Set SANDBOX_HOST in your environment.",
      );
    }
    this.hostIp = ip;
    // The in-process registry binds on the host (0.0.0.0:<dynamic-port>).
    // Refs we hand out use the host bridge IP so the same string works for
    // both the BuildKit push (from inside the build VM) and the later guest-
    // side pull (from inside workspace VMs).
    this.registry = `${ip}:${getLocalRegistryPort()}`;
  }

  // Ask the running guest VM for its default gateway IPv4. That gateway IS
  // the host as seen from inside the VM (libkrun bridge on macOS, virtio-net
  // bridge on Linux), which is exactly the address other VMs need to reach
  // our in-process registry. Authoritative regardless of the host-side
  // interface name and works as soon as the VM has finished booting.
  private async resolveGatewayIpFromGuest(sandbox: Sandbox): Promise<string> {
    const out = await sandbox.shell("ip -4 route show default | awk '{print $3; exit}'");
    if (out.code !== 0) {
      throw new Error(
        `failed to query guest default gateway: ${out.stderr().trim() || `exit ${out.code}`}`,
      );
    }
    const ip = out.stdout().trim();
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
      throw new Error(`guest reported non-IPv4 gateway: ${JSON.stringify(ip)}`);
    }
    return ip;
  }

  // Returns the shared running builder, booting it on first call. Concurrent
  // callers race-free: the second one awaits the same `starting` promise the
  // first one created.
  private async ensureBuilder(): Promise<{
    sandbox: Sandbox;
    buildkitHandle: ExecHandle;
  }> {
    if (this.sandbox && this.buildkitHandle) {
      return { sandbox: this.sandbox, buildkitHandle: this.buildkitHandle };
    }
    if (this.starting) return this.starting;
    this.starting = this.bootBuilder();
    try {
      const result = await this.starting;
      this.sandbox = result.sandbox;
      this.buildkitHandle = result.buildkitHandle;
      return result;
    } finally {
      this.starting = null;
    }
  }

  private async bootBuilder(): Promise<{
    sandbox: Sandbox;
    buildkitHandle: ExecHandle;
  }> {
    // We can't call ensureConfig() until microsandbox has brought up its
    // libkrun bridge (e.g. bridge100 on macOS), which only happens once the
    // first VM is being created. So we defer registry-URL resolution: boot
    // the VM with a minimal toml (no per-registry section), then write the
    // full toml via shell after .create() returns. The network policy at
    // create time also has to be IP-agnostic, so we relax the deny-private
    // rule for the builder. Its only "private" target is our own host
    // registry, and the builder runs nothing the user supplies until we
    // hand it a buildctl invocation.
    const image = this.opts.buildkitImage || DEFAULT_BUILDKIT_IMAGE;
    const networkPolicy = this.buildBuilderNetworkPolicy();
    const cacheDiskPath = resolveCacheDiskPath();
    await ensureCacheDisk(cacheDiskPath, CACHE_DISK_SIZE_GIB);

    console.log(`[builder] booting ${image}`);
    const sandbox = await Sandbox.builder(BUILDER_NAME)
      .image(image)
      // Match workspace VM sizing: all host CPUs, 3/4 host memory. The
      // builder is a long-lived process running buildkitd + transient
      // RUN containers. Smaller caps left RUN steps OOMing on real-world
      // Dockerfiles (claude install, npm global installs).
      .cpus(getHostCpuCount())
      .memory(getVmMemoryMib())
      .envs({ TERM: "xterm-256color" })
      // Replace any leftover sandbox of the same name from a prior process
      // run that didn't shut down cleanly.
      .replace()
      .network((n) => n.policy(networkPolicy))
      // virtio-blk + ext4 for the buildkit cache. See resolveCacheDiskPath
      // for the rationale. fstype must match what mkfs.ext4 wrote into the
      // disk image during ensureCacheDisk(). agentd mounts the device with
      // exactly this filesystem driver.
      .volume("/var/lib/buildkit", (m) => m.disk(cacheDiskPath).format("raw").fstype("ext4"))
      .patch((p) => p.mkdir("/etc/buildkit").mkdir("/build"))
      .create();
    let buildkitHandle: ExecHandle | null = null;
    try {
      // Mount a tmpfs at /build for build-context extraction. The
      // microsandbox rootfs (virtio-fs-backed) refuses symlink creation, so
      // tarballs that ship symlinks error out at extract time. tmpfs handles
      // symlinks normally, starts fresh on each boot (no stale leftovers), and
      // only consumes RAM proportional to its contents.
      const mount = await sandbox.shell("mount -t tmpfs -o size=8G,mode=755 tmpfs /build");
      if (mount.code !== 0) {
        throw new Error(
          `tmpfs mount on /build failed: ${mount.stderr().trim() || `exit ${mount.code}`}`,
        );
      }
      // Replace busybox tar with GNU tar. busybox tar's extract path refuses
      // to create symlinks whose targets contain `..`, even when they'd
      // resolve back inside the destination. GNU tar checks the resolved path
      // instead, so the same symlink extracts fine. `tar` from apk lands in
      // /usr/bin and wins PATH precedence over /bin/tar (busybox).
      const apkTar = await sandbox.shell("apk add --no-cache tar");
      if (apkTar.code !== 0) {
        throw new Error(
          `installing GNU tar failed: ${apkTar.stderr().trim() || `exit ${apkTar.code}`}`,
        );
      }
      // Resolve the host's libkrun-bridge IP by asking the running guest for
      // its default gateway. That gateway IS the host as seen from inside
      // the VM. This is more reliable than parsing host-side `ifconfig
      // bridge100`, which may not show an `inet` address on every macOS
      // setup. Once we have the IP we plumb it through ensureConfig() so
      // subsequent callers (registryEndpoint, runRegistryGc) share the same
      // resolved value without re-querying.
      this.hostIp = await this.resolveGatewayIpFromGuest(sandbox);
      this.ensureConfig();
      const registry = this.registry!;
      console.log(`[builder] registry ${registry}`);
      // buildkitd config:
      //   - overlayfs snapshotter: kernel-native CoW. Used to fail with runc
      //     "invalid argument" on libkrun (TODO.md); switching the cache fs
      //     onto a virtio-blk-backed disk unblocked it. If it ever regresses,
      //     fall back to "fuse-overlayfs" (needs apk-add of the userspace
      //     binary, not bundled in stock moby/buildkit:v0.16.0).
      //   - GC keepstorage at ~80% of disk capacity, leaving headroom so
      //     in-flight builds don't ENOSPC before pruning catches up.
      //   - registry HTTP carve-out: TOML section key is the host:port literal.
      //     Matching is exact, not glob. Only `http = true` here. Do NOT also
      //     set `insecure = true`. In buildkit's fillInsecureOpts (v0.16.0
      //     util/resolver/resolver.go), `insecure` takes precedence: it keeps
      //     Scheme="https" and wraps the transport in an httpFallback that only
      //     falls back to HTTP on tls.RecordHeaderError / TLS-handshake-timeout
      //     / ECONNREFUSED-with-no-port. Our registry is plain-HTTP on a
      //     :port URL, so the TLS handshake closes with EOF, which isn't any
      //     of those, and the push fails outright. With only `http = true`,
      //     the resolver sets Scheme="http" directly and skips TLS entirely.
      const buildkitdToml =
        `[worker.oci]\n` +
        `  snapshotter = "overlayfs"\n` +
        `  gc = true\n` +
        `  gckeepstorage = ${CACHE_GC_KEEP_MIB}\n` +
        `\n` +
        // Explicit GC policy. Each stage runs in order. A record matching a
        // stage's filter and exceeding its keepBytes becomes eligible. The
        // default (implicit) policy treats all record types uniformly, which
        // means a single oversized RUN step can evict the entire nix binary
        // cache. The stages below carve out a stable budget per type:
        //   1. Cache mounts (nix-cache, apt, npm caches): protected first.
        //   2. Source records (build context, dockerfile, frontend): cheap.
        //   3. Layer cache (RUN results, FROM images).
        //   4. Catch-all at the overall ceiling.
        // IMPORTANT unit gotcha: `gckeepstorage` is the legacy integer field
        // (interpreted as MB), but `keepBytes` is the newer DiskSpace field
        // where a bare integer means BYTES. Use a unit-suffixed string here so
        // the values aren't silently truncated to KB.
        `[[worker.oci.gcpolicy]]\n` +
        `  filters = ["type==exec.cachemount"]\n` +
        `  keepBytes = "${CACHE_GC_CACHEMOUNT_GIB}GB"\n` +
        `\n` +
        `[[worker.oci.gcpolicy]]\n` +
        `  filters = ["type==source.local", "type==source.git.checkout", "type==frontend", "type==internal"]\n` +
        `  keepBytes = "${CACHE_GC_INTERNAL_GIB}GB"\n` +
        `\n` +
        `[[worker.oci.gcpolicy]]\n` +
        `  filters = ["type==regular"]\n` +
        `  keepBytes = "${CACHE_GC_LAYERS_GIB}GB"\n` +
        `\n` +
        `[[worker.oci.gcpolicy]]\n` +
        `  all = true\n` +
        `  keepBytes = "${Math.round(CACHE_GC_KEEP_MIB / 1024)}GB"\n` +
        `\n` +
        `[registry."${registry}"]\n` +
        `  http = true\n`;
      await sandbox.fs().write("/etc/buildkit/buildkitd.toml", Buffer.from(buildkitdToml));
      buildkitHandle = await this.startBuildkit(sandbox);
      await this.waitForBuildkit(sandbox);
    } catch (err) {
      if (buildkitHandle) await killHandle(buildkitHandle);
      await sandbox.stop().catch((e) => {
        console.warn("[builder] bootBuilder cleanup: stop failed:", e);
      });
      await Sandbox.remove(sandbox.name).catch((e) => {
        console.warn("[builder] bootBuilder cleanup: Sandbox.remove failed:", e);
      });
      throw err;
    }
    console.log("[builder] ready");
    return { sandbox, buildkitHandle: buildkitHandle! };
  }

  // Launches buildkitd as a background process. The caller holds the handle to
  // keep the daemon alive for the lifetime of the build.
  private async startBuildkit(sandbox: Sandbox): Promise<ExecHandle> {
    await sandbox.shell("mkdir -p /run/buildkit");
    const handle = await sandbox.shellStream(
      "exec buildkitd --addr unix:///run/buildkit/buildkitd.sock",
    );
    void (async () => {
      try {
        while (true) {
          const ev = await handle.recv();
          if (!ev) break;
          if (ev.kind === "stderr") {
            const line = Buffer.from(ev.data).toString("utf8").trim();
            if (line) console.log(`[buildkitd] ${line}`);
          }
        }
      } catch {}
    })();
    return handle;
  }

  private buildBuilderNetworkPolicy(): NetworkPolicy {
    // The builder needs to reach the host's in-process registry on the libkrun
    // bridge gateway, which falls inside RFC 1918 private space. We don't
    // know the exact gateway IP yet at create time (microsandbox hasn't booted
    // the VM that would bring the bridge up), so we can't write a narrow
    // allow-rule. Leaving private egress fully open is acceptable here: the
    // builder runs nothing but buildkitd + the buildctl invocations we hand
    // it, so the broader allow doesn't expose any user-controlled code.
    return {
      defaultEgress: "allow",
      defaultIngress: "allow",
      rules: [
        Rule.denyEgress(Destination.group("loopback")),
        Rule.denyEgress(Destination.group("link-local")),
        Rule.denyEgress(Destination.group("metadata")),
      ],
    };
  }

  // Polls `buildctl debug workers` directly. It returns 0 once buildkitd is
  // accepting connections on its socket. We surface stdout+stderr from the
  // last attempt so timeouts are diagnosable rather than just "exit 0".
  private async waitForBuildkit(sandbox: Sandbox): Promise<void> {
    const deadline = Date.now() + BUILDKIT_READY_TIMEOUT_MS;
    let lastOut = "";
    let lastErr = "";
    let lastCode = -1;
    while (Date.now() < deadline) {
      const out = await sandbox.shell("buildctl debug workers");
      if (out.code === 0) return;
      lastOut = out.stdout().trim();
      lastErr = out.stderr().trim();
      lastCode = out.code;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(
      `buildkitd did not become ready within ${BUILDKIT_READY_TIMEOUT_MS}ms ` +
        `(last exit ${lastCode}; stdout: ${lastOut || "(empty)"}; stderr: ${lastErr || "(empty)"})`,
    );
  }

  // Yields log lines, returns the final image ref. The server ships a fully
  // assembled Dockerfile at the tar root plus any number of named contexts
  // under `repos/` (one per workspace repo) and an optional `context/` for
  // the main buildctl context. Builder responsibilities are mechanical:
  // extract the tar, register the buildctl `--local`s in lockstep with the
  // user Dockerfile's `COPY --from=<name>` lines, push.
  async *runBuild(tarStream: ReadableStream): AsyncGenerator<string, string> {
    let release!: () => void;
    const next = new Promise<void>((r) => {
      release = r;
    });
    const prev = this.opChain;
    this.opChain = next;
    try {
      await prev.catch(() => {});
      try {
        return yield* this.doRunBuild(tarStream);
      } finally {
        // Shut the builder VM down between builds. The cache disk is a
        // host-side ext4 image that survives the VM's lifetime, so the next
        // runBuild just pays a cold-boot cost (image pull is cached) and
        // re-mounts the same cache. Awaited *before* releasing the opChain
        // slot so the next build's ensureBuilder() doesn't race with the
        // shutdown in progress.
        await this.shutdown();
      }
    } finally {
      release();
    }
  }

  private async *doRunBuild(tarStream: ReadableStream): AsyncGenerator<string, string> {
    // ensureBuilder() boots the VM if needed, which is what brings up the
    // libkrun bridge interface. Only after that can ensureConfig() detect
    // the host IP and resolve the registry endpoint.
    yield "=== Booting builder VM ===";
    const { sandbox } = await this.ensureBuilder();
    this.ensureConfig();
    const registry = this.registry!;

    const uid = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    // Extraction root. The server's tar shape is:
    //   ./Dockerfile                  (final, server-assembled)
    //   ./context/...                 (optional buildctl main context)
    //   ./repos/<slug>/...            (one named context per workspace repo)
    const extractDir = `/build/${uid}`;
    // BuildKit-inside-VM pushes to the bridge-IP ref (the only host endpoint
    // it can reach). Microsandbox-on-host pulls under a loopback ref because
    // macOS won't reliably loopback connect(2) to its own bridge100 IP. The
    // packets get routed out the bridge and the pull errors with a connect
    // failure. Our in-process registry binds 0.0.0.0 and keys storage on the
    // repo path only, so the same image can be pushed under one host:port
    // prefix and pulled under another against this same listener. The cache
    // ref is what callers receive (it's the cache key for later VM spawns
    // with pullPolicy="never"). The push ref is purely internal to the build.
    const finalRefPush = `${registry}/isolade/${uid}:latest`;
    const cacheRegistry = getLocalRegistryLoopbackEndpoint();
    const finalRefCache = `${cacheRegistry}/isolade/${uid}:latest`;

    console.log(`[builder] build ${uid} → ${finalRefCache}`);

    yield "=== Setting up build context ===";
    {
      const out = await sandbox.shell(`mkdir -p ${extractDir}`);
      if (out.code !== 0) {
        throw new Error(`mkdir failed: ${out.stderr().trim() || `exit ${out.code}`}`);
      }
    }

    yield "=== Receiving build context ===";
    // Spool the tar to a host tempfile, ship it across via copyFromHost,
    // then extract inside. The exec stdin channel loses bytes for
    // multi-megabyte cumulative writes (tar reports "short read" even when
    // every chunk is well under microsandbox's 4 MiB per-frame cap), so we
    // route the tar through the fs API instead.
    let spoolBytes = 0;
    const spoolPromise = spoolToTempfile(tarStream, (n) => {
      spoolBytes = n;
    });
    yield* heartbeat(spoolPromise, 5000, () => `  received ${formatMiB(spoolBytes)}`);
    const tarPath = await spoolPromise;
    yield `  received ${formatMiB(spoolBytes)} total`;
    try {
      const guestTar = `${extractDir}.tar`;
      yield `=== Copying ${formatMiB(spoolBytes)} build context to VM ===`;
      const copyPromise = sandbox.fs().copyFromHost(tarPath, guestTar);
      // Poll the guest-side file size while copyFromHost runs. The
      // microsandbox API is opaque, but `stat` against the in-progress
      // destination shows real bytes-on-disk progress.
      yield* progressBytes(
        copyPromise,
        5000,
        async () => {
          const probe = await sandbox.shell(`stat -c %s ${guestTar} 2>/dev/null || echo 0`);
          const n = Number(probe.stdout().trim());
          return Number.isFinite(n) ? n : 0;
        },
        (bytes) => `  copied ${formatMiB(bytes)} / ${formatMiB(spoolBytes)}`,
      );
      await copyPromise;
      yield "=== Extracting build context inside VM ===";
      // Run tar with the archive piped via stdin (fd 0). That gives us a
      // stable, well-known fd whose read offset reflects exactly how much
      // of the archive has been consumed. Read it from /proc/<pid>/fdinfo/0
      // on each poll. This beats `du` on every axis: O(1) per probe (no
      // tree walk), accurate against a known denominator (the tar size),
      // and works on busybox/alpine (no GNU coreutils required).
      const pidFile = `${extractDir}.tarpid`;
      const extractPromise = sandbox.shell(
        `set -e; tar -xf - -C ${extractDir} < ${guestTar} & ` +
          `echo $! > ${pidFile}; wait $!; status=$?; ` +
          `rm -f ${guestTar} ${pidFile}; exit $status`,
      );
      yield* progressBytes(
        extractPromise,
        5000,
        async () => {
          const probe = await sandbox.shell(
            `pid=$(cat ${pidFile} 2>/dev/null) && ` +
              `awk '/^pos:/ {print $2}' /proc/$pid/fdinfo/0 2>/dev/null || echo 0`,
          );
          const n = Number(probe.stdout().trim());
          return Number.isFinite(n) ? n : 0;
        },
        (bytes) => `  extracted ${formatMiB(bytes)} / ${formatMiB(spoolBytes)}`,
      );
      const extract = await extractPromise;
      if (extract.code !== 0) {
        throw new Error(`tar extract failed: ${extract.stderr().trim() || `exit ${extract.code}`}`);
      }
    } finally {
      await rm(tarPath, { force: true }).catch((e) => {
        console.warn(`[builder] rm spool tar ${tarPath} failed:`, e);
      });
    }

    // Discover the server-supplied layout. The Dockerfile is mandatory.
    // ./context/ and ./repos/<slug>/ are optional and drive buildctl
    // `--local` flags. Names are server-controlled, and we just plumb them
    // through verbatim.
    const dfProbe = await sandbox.shell(`test -f ${extractDir}/Dockerfile`);
    if (dfProbe.code !== 0) {
      throw new Error("build context tar missing top-level ./Dockerfile");
    }
    const hasContext = (await sandbox.shell(`test -d ${extractDir}/context`)).code === 0;
    const reposList = await sandbox.shell(
      `[ -d ${extractDir}/repos ] && ls -1 ${extractDir}/repos || true`,
    );
    const repoSlugs = reposList
      .stdout()
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    console.log(
      `[builder] reposList stdout=${JSON.stringify(reposList.stdout())} ` +
        `stderr=${JSON.stringify(reposList.stderr())} code=${reposList.code}`,
    );
    console.log(`[builder] repoSlugs=${JSON.stringify(repoSlugs)}`);

    yield "";
    yield "=== Building image ===";
    const args = [
      "buildctl",
      "build",
      "--frontend",
      "dockerfile.v0",
      "--local",
      `dockerfile=${extractDir}`,
    ];
    if (hasContext) {
      args.push("--local", `context=${extractDir}/context`);
    }
    for (const slug of repoSlugs) {
      // The repo's name IS the named context, with no prefix. The server's
      // repo-name validation reserves the names that would collide here
      // (`context`, `dockerfile`, the injected stages), so `slug` is safe to
      // use verbatim as both the buildctl `--local` and the context name the
      // user Dockerfile COPYs from.
      args.push("--local", `${slug}=${extractDir}/repos/${slug}`);
      args.push("--opt", `context:${slug}=local:${slug}`);
    }
    // Publish layers as zstd, not buildkit's default gzip. microsandbox's tar
    // ingestion has an O(N²) blowup decoding large incompressible files in
    // gzip layers (flate2 zeroes the whole output buffer on each inflate step,
    // see microsandbox#790). zstd goes through libzstd and avoids it entirely.
    // force-compression recompresses FROM/base layers too (otherwise the fat
    // CUDA/model base layers stay gzip and still hit the bug). oci-mediatypes
    // is required so layers carry the tar+zstd media type microsandbox detects.
    args.push(
      "--output",
      `type=image,name=${finalRefPush},push=true,registry.insecure=true,compression=zstd,force-compression=true,oci-mediatypes=true`,
      "--progress=plain",
    );
    console.log(`[builder] buildctl argv: ${JSON.stringify(args)}`);
    try {
      yield* this.runStreaming(sandbox, args);
    } finally {
      // Trim freed blocks back to the host before shutting the VM down.
      // ext4 reuses freed blocks internally, so the cache image only sheds
      // bytes at quiescent points like end-of-build. Without fstrim the
      // raw image file grows monotonically to the high-water mark of
      // allocations even though live usage stays much lower. Errors are
      // swallowed: a failed trim shouldn't abort the build, and the next
      // build's trim will reclaim whatever this one missed.
      try {
        const trim = await sandbox.shell("fstrim /var/lib/buildkit");
        if (trim.code !== 0) {
          console.error(`[builder] fstrim exited ${trim.code}: ${trim.stderr().trim()}`);
        }
      } catch (err) {
        console.error(
          `[builder] fstrim failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      // Image is in the in-process registry. Nothing below this point
      // needs buildkit. Free the VM (~few GiB RAM, host CPU shares) so
      // it doesn't sit idle while microsandbox ingests + the registry
      // GC runs. The outer runBuild finally calls shutdown() again as
      // an idempotent safety net for paths that bail before this point.
      // We don't bother removing the per-build extract dir under
      // /build, since it's on a tmpfs that's freed with the VM.
      await this.shutdown();
    }

    // Seed microsandbox's local cache from the registry copy we just pushed.
    // Once this succeeds, the workspace image (VMDK + EROFS layers + DB
    // rows) lives entirely in `~/.microsandbox/` and is independent of the
    // in-process registry's endpoint, which won't survive a sandbox restart
    // (OS-assigned port, bridge-IP that can change). VMs are created with
    // pullPolicy: "never", so the ref string is just an opaque cache key
    // from here on.
    yield "";
    yield "=== Ingesting image into microsandbox cache ===";
    // `microsandbox pull` only renders its progress bar on a TTY; under our
    // pipe it stays quiet either way. Its per-layer ingest events (manifest
    // resolve, download, tar ingest, EROFS write) are debug-level and too
    // chatty to stream into the build log, so run at `--info`: any WARN/ERROR
    // diagnostics still surface — a failing ingest is reported rather than
    // silently swallowed — while the per-layer trace is dropped.
    // `msb` is the canonical binary (`microsandbox` is just a symlink to it).
    // It inherits MSB_HOME/MSB_PATH from this process, so the pull lands in
    // isolade's isolated cache.
    for await (const line of this.runHostStreaming([
      join(msbBinDir(), "msb"),
      "pull",
      "--insecure",
      "--info",
      finalRefCache,
    ])) {
      yield line;
    }

    // With the image safely materialized in microsandbox's cache, the
    // registry blob copy is redundant. Drop it now (under the same opChain
    // slot the build holds) so the registry doesn't accumulate per-build
    // copies.
    yield "";
    yield "=== Reclaiming registry storage ===";
    {
      const parsed = parseImageRef(finalRefPush);
      if (!parsed) {
        yield `(skip: unparseable ref ${finalRefPush})`;
      } else {
        try {
          await deleteManifestByTag(`127.0.0.1:${getLocalRegistryPort()}`, parsed.name, parsed.tag);
          yield `deleted ${parsed.name}:${parsed.tag}`;
        } catch (err) {
          // Non-fatal: the periodic GC will catch leftovers. Don't fail an
          // otherwise-successful build because cleanup hit a transient.
          yield `(warn: delete ${parsed.name}:${parsed.tag} failed: ${err instanceof Error ? err.message : String(err)})`;
        }
      }
    }

    yield "";
    yield "=== Build complete ===";
    return finalRefCache;
  }

  // Run a command in the builder VM, yielding stdout/stderr line-by-line.
  // Throws on non-zero exit. The child sees stdin EOF immediately. Large
  // payloads go through fs().copyFromHost instead.
  private async *runStreaming(sandbox: Sandbox, argv: string[]): AsyncGenerator<string> {
    const [cmd, ...args] = argv;
    if (!cmd) throw new Error("runStreaming: empty argv");

    const handle: ExecHandle = await sandbox.execStreamWith(cmd, (b) => b.args(args).stdinNull());

    const lines: string[] = [];
    const state = { done: false, exit: 0, error: null as Error | null };
    let wakeup: (() => void) | null = null;
    const signal = () => {
      const w = wakeup;
      wakeup = null;
      if (w) w();
    };

    let stdoutBuf = "";
    let stderrBuf = "";
    const push = (line: string) => {
      lines.push(line);
      signal();
    };
    const flushPartial = (which: "out" | "err") => {
      const buf = which === "out" ? stdoutBuf : stderrBuf;
      if (buf) push(buf);
      if (which === "out") stdoutBuf = "";
      else stderrBuf = "";
    };

    void (async () => {
      try {
        const dec = new TextDecoder();
        while (true) {
          const ev = await handle.recv();
          if (!ev) break;
          if (ev.kind === "stdout") {
            stdoutBuf += dec.decode(ev.data, { stream: true });
            const parts = stdoutBuf.split("\n");
            stdoutBuf = parts.pop()!;
            for (const line of parts) push(line);
          } else if (ev.kind === "stderr") {
            stderrBuf += dec.decode(ev.data, { stream: true });
            const parts = stderrBuf.split("\n");
            stderrBuf = parts.pop()!;
            for (const line of parts) push(line);
          } else if (ev.kind === "exited") {
            state.exit = ev.code;
          }
        }
        flushPartial("out");
        flushPartial("err");
      } catch (err) {
        state.error = err instanceof Error ? err : new Error(String(err));
      } finally {
        state.done = true;
        signal();
      }
    })();

    while (!state.done || lines.length > 0) {
      while (lines.length > 0) yield lines.shift()!;
      if (!state.done) {
        await new Promise<void>((r) => {
          wakeup = r;
          if (lines.length > 0 || state.done) {
            wakeup = null;
            r();
          }
        });
      }
    }

    if (state.error) throw state.error;
    if (state.exit !== 0) {
      throw new Error(`${cmd} exited with code ${state.exit}`);
    }
  }

  // Same shape as runStreaming but for a host child process, used for the
  // post-push `microsandbox pull` that seeds the local image cache.
  private async *runHostStreaming(argv: string[]): AsyncGenerator<string> {
    const [cmd, ...args] = argv;
    if (!cmd) throw new Error("runHostStreaming: empty argv");

    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const lines: string[] = [];
    const state = { done: false, exit: 0, error: null as Error | null };
    let wakeup: (() => void) | null = null;
    const signal = () => {
      const w = wakeup;
      wakeup = null;
      if (w) w();
    };

    let stdoutBuf = "";
    let stderrBuf = "";
    const consume = (which: "out" | "err", chunk: Buffer) => {
      if (which === "out") {
        stdoutBuf += chunk.toString("utf8");
        const parts = stdoutBuf.split("\n");
        stdoutBuf = parts.pop()!;
        for (const line of parts) {
          lines.push(line);
        }
      } else {
        stderrBuf += chunk.toString("utf8");
        const parts = stderrBuf.split("\n");
        stderrBuf = parts.pop()!;
        for (const line of parts) {
          lines.push(line);
        }
      }
      signal();
    };

    child.stdout.on("data", (c: Buffer) => consume("out", c));
    child.stderr.on("data", (c: Buffer) => consume("err", c));
    child.on("error", (err) => {
      state.error = err;
      state.done = true;
      signal();
    });
    child.on("close", (code) => {
      if (stdoutBuf) lines.push(stdoutBuf);
      if (stderrBuf) lines.push(stderrBuf);
      state.exit = code ?? 0;
      state.done = true;
      signal();
    });

    while (!state.done || lines.length > 0) {
      while (lines.length > 0) yield lines.shift()!;
      if (!state.done) {
        await new Promise<void>((r) => {
          wakeup = r;
          if (lines.length > 0 || state.done) {
            wakeup = null;
            r();
          }
        });
      }
    }

    if (state.error) throw state.error;
    if (state.exit !== 0) {
      throw new Error(`${cmd} exited with code ${state.exit}`);
    }
  }

  // Reclaim both layers of image storage:
  //   1) the in-process OCI registry's manifests + blobs (BuildKit pushes
  //      every workspace build here).
  //   2) microsandbox's local image cache at ~/.microsandbox/cache/ (rows in
  //      msb.db + the per-layer .erofs / per-manifest fsmeta+vmdk files).
  // Both share the keep set (full image refs like `<host:port>/isolade/
  // <uid>:latest`) and need the same serialization (the registry forbids
  // concurrent pushes during garbage-collect, and msb.db musn't be touched
  // mid-pull). opChain handles the latter.
  async runRegistryGc(keep: string[], log: (line: string) => void = () => {}): Promise<void> {
    let release!: () => void;
    const next = new Promise<void>((r) => {
      release = r;
    });
    const prev = this.opChain;
    this.opChain = next;
    try {
      await prev.catch(() => {});
      // GC only needs to talk to the local in-process registry, which is
      // reachable via loopback regardless of whether the libkrun bridge IP
      // exists yet (on macOS, bridge100 only appears once the first VM has
      // booted, and the startup-reconcile GC runs before any VM exists).
      // We therefore avoid ensureConfig() and address the registry directly
      // through 127.0.0.1. Keep refs may carry any bridge IP since the
      // underlying storage is the same.
      const registry = `127.0.0.1:${getLocalRegistryPort()}`;
      const keepTags = new Set<string>();
      for (const ref of keep) {
        const parsed = parseImageRef(ref);
        if (!parsed) {
          log(`skipping unparseable keep ref: ${ref}`);
          continue;
        }
        keepTags.add(`${parsed.name}:${parsed.tag}`);
      }
      await runRegistryGarbageCollect(registry, keepTags, log);

      // Microsandbox cache pruning. Non-fatal if it throws, since the registry
      // half already succeeded and the next GC pass will retry. Skipping it
      // entirely on error is safer than leaving the cache in a half-pruned
      // state.
      try {
        await runMicrosandboxGc(keep, log);
      } catch (err) {
        log(`microsandbox gc failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      release();
    }
  }

  // Returns a handle to the live builder VM if it has been booted, otherwise
  // null. The stats endpoint uses this to include builder metrics without
  // forcing a boot just for observability.
  currentBuilderHandle(): { id: string; sandbox: Sandbox } | null {
    if (!this.sandbox) return null;
    return { id: BUILDER_NAME, sandbox: this.sandbox };
  }

  // Tears down the builder VM. Called between builds (from runBuild's
  // finally) and on process exit (from index.ts's SIGTERM hook). Future
  // runBuild calls lazy-boot a new VM and re-attach the same cache disk.
  // We clear hostIp / registry too: the libkrun bridge could come up with
  // a different IP on the next boot, and ensureConfig() would otherwise
  // short-circuit on the stale cached value.
  async shutdown() {
    const sb = this.sandbox;
    const handle = this.buildkitHandle;
    this.sandbox = null;
    this.buildkitHandle = null;
    this.hostIp = null;
    this.registry = null;
    if (handle) await killHandle(handle);
    if (!sb) return;
    // Force the guest to flush the page cache before we halt it. `sb.stop()`
    // hard-kills the VM with no clean shutdown (no `sync`, no fs unmount, no
    // writeback timer firing), so any dir creates / file writes still buffered
    // by the guest kernel evaporate. Containerd's overlay snapshotter fsyncs
    // its metadata DB but does NOT fsync the parent directory after creating
    // a new `snapshots/<id>/` subdir, so without this the DB persists a record
    // for a snapshot whose on-disk dir was never durably written. Next boot
    // then errors out the first time it tries to walk that dir.
    try {
      await withTimeout(sb.shell("sync"), 15_000, "sandbox.sync");
    } catch (err) {
      console.warn("[builder] shutdown: sync failed:", err);
    }
    try {
      await withTimeout(sb.stop(), 10_000, "sandbox.stop");
    } catch (err) {
      console.warn("[builder] shutdown: stop failed:", err);
    }
    try {
      await withTimeout(Sandbox.remove(sb.name), 10_000, "Sandbox.remove");
    } catch (err) {
      console.warn("[builder] shutdown: Sandbox.remove failed:", err);
    }
  }
}

async function killHandle(handle: ExecHandle): Promise<void> {
  // kill() can block waiting on the exec session, and we don't need that, so
  // race it with a short timeout. Stopping the sandbox tears down anything
  // still running anyway.
  await withTimeout(handle.kill(), 3_000, "exec kill").catch((err) => {
    console.warn("[builder] killHandle:", err);
  });
}

// Idempotent: ensure the host-side ext4 disk image exists and is formatted.
// First call creates a sparse file and runs mkfs.ext4 from inside a one-
// shot helper VM (macOS lacks mkfs.ext4). Subsequent calls early-return
// after verifying the existing file is actually ext4 (size-only checks
// missed the case where the file was truncated but mkfs never ran, so the
// builder VM then refused to mount it and exited mid-boot). On any failure
// during provisioning, the partial file is removed so the next call
// retries cleanly.
async function ensureCacheDisk(diskPath: string, sizeGib: number): Promise<void> {
  if (await isExt4(diskPath)) {
    // fstrim from inside the VM can shrink this file on macOS: imago's
    // virtio-blk DISCARD path (try_discard_by_truncate in imago/src/file.rs)
    // treats a discard range that reaches end-of-file as ftruncate, physically
    // shortening the host raw image by the trailing free run. The ext4
    // superblock still records the original block count, so the next mount(2)
    // returns EINVAL ("block count > device size") and the builder VM exits
    // before agentd's relay socket comes up. That surfaces on the host as the
    // baffling "[BootStart] sandbox exited (exit status: 0) before agent
    // relay became available". Linux's discard path is fallocate(PUNCH_HOLE
    // | KEEP_SIZE) and preserves length, so this branch is effectively a
    // no-op there.
    //
    // Grow the file back to the configured size before each attach. Safe:
    // ext4 only addresses blocks it knew about at mkfs time, so a host file
    // at least that big mounts fine and the extra tail is just sparse hole.
    // Never shrink here, since that would corrupt a valid FS.
    const expected = sizeGib * 1024 * 1024 * 1024;
    const fh = await open(diskPath, "r+");
    try {
      const { size } = await fh.stat();
      if (size < expected) {
        console.log(
          `[builder] re-extending ${diskPath} ${size} -> ${expected} bytes ` +
            `(fstrim truncated the tail on a previous build)`,
        );
        await fh.truncate(expected);
      }
    } finally {
      await fh.close();
    }
    return;
  }
  // Either the file was missing, was the wrong size, or wasn't actually
  // formatted, so drop it and reprovision from scratch. Cheap: it's sparse.
  await rm(diskPath, { force: true }).catch((e) => {
    console.warn(`[builder] rm stale cache disk ${diskPath} failed:`, e);
  });

  const dir = dirname(diskPath);
  await mkdir(dir, { recursive: true });

  // Sparse allocation: same effect as `truncate -s <N>G`.
  const fh = await open(diskPath, "w");
  try {
    await fh.truncate(sizeGib * 1024 * 1024 * 1024);
  } finally {
    await fh.close();
  }

  console.log(`[builder] formatting ${diskPath} as ext4 (one-time, ~30s on first run)`);
  // Outer try/catch so a Sandbox.builder().create() failure (image pull
  // auth error, network blip, etc.) also cleans up the truncated file.
  // Previously create() sat outside the cleanup, leaving an unformatted
  // sparse file that the next ensureCacheDisk call would happily accept,
  // and the builder VM would later fail to mount.
  let sandbox: Sandbox | null = null;
  try {
    sandbox = await Sandbox.builder(DISK_INIT_SANDBOX_NAME)
      .image(DISK_INIT_IMAGE)
      .cpus(2)
      .memory(1024)
      .replace()
      // Bind-mounting the parent dir (not the file directly) keeps the host
      // path manipulation simple. agentd mounts virtio-fs at /work and we
      // mkfs the file by name inside.
      .volume("/work", (m) => m.bind(dir))
      .create();

    const target = `/work/${basename(diskPath)}`;
    const out = await sandbox.shell(`mkfs.ext4 -F -L isolade-buildkit-cache ${target}`);
    if (out.code !== 0) {
      throw new Error(
        `mkfs.ext4 failed (exit ${out.code}): ` +
          (out.stderr().trim() || out.stdout().trim() || "no output"),
      );
    }
  } catch (err) {
    await rm(diskPath, { force: true }).catch((e) => {
      console.warn(`[builder] rm half-provisioned cache disk ${diskPath} failed:`, e);
    });
    throw err;
  } finally {
    if (sandbox) {
      await sandbox.stop().catch((e) => {
        console.warn("[builder] disk-init cleanup: stop failed:", e);
      });
      await Sandbox.remove(sandbox.name).catch((e) => {
        console.warn("[builder] disk-init cleanup: Sandbox.remove failed:", e);
      });
    }
  }
}

// Verify an existing cache disk is really ext4-formatted. The ext4 magic
// (0xEF53) lives at offset 0x438 within the first block group. The first
// block group starts at offset 1024 (the boot block reserve), so the magic
// is at file offset 1080. Cheap two-byte read, no superblock parse.
async function isExt4(path: string): Promise<boolean> {
  let fh;
  try {
    fh = await open(path, "r");
  } catch {
    return false;
  }
  try {
    const buf = Buffer.alloc(2);
    const { bytesRead } = await fh.read(buf, 0, 2, 1080);
    return bytesRead === 2 && buf[0] === 0x53 && buf[1] === 0xef;
  } catch {
    return false;
  } finally {
    await fh.close().catch(() => {});
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

// Yields `msg()` every `intervalMs` until `p` settles. Used to keep the SSE
// stream alive while we await opaque long operations (request-body spool,
// fs.copyFromHost, tar extract) that don't produce their own progress.
async function* heartbeat<T>(
  p: Promise<T>,
  intervalMs: number,
  msg: () => string,
): AsyncGenerator<string> {
  let done = false;
  p.finally(() => {
    done = true;
  }).catch(() => {});
  while (!done) {
    await new Promise<void>((r) => setTimeout(r, intervalMs));
    if (done) break;
    yield msg();
  }
}

// Like heartbeat, but each tick runs an async `probe()` to discover the
// current byte count (e.g. via `stat` or `du` in the guest) and formats it
// with `fmt(bytes)`. Skips probe errors (transient ENOENT before the file
// appears, dropped exec channels), because they shouldn't kill the build.
async function* progressBytes<T>(
  p: Promise<T>,
  intervalMs: number,
  probe: () => Promise<number>,
  fmt: (bytes: number) => string,
): AsyncGenerator<string> {
  let done = false;
  p.finally(() => {
    done = true;
  }).catch(() => {});
  while (!done) {
    await new Promise<void>((r) => setTimeout(r, intervalMs));
    if (done) break;
    try {
      const bytes = await probe();
      if (done) break;
      yield fmt(bytes);
    } catch {
      // Swallow probe failures, since they shouldn't abort the operation.
    }
  }
}

// Spools a stream to a host tempfile so we can hand the path to copyFromHost.
// Returns the temp path. The caller is responsible for unlinking. The optional
// onBytes callback fires after each chunk with the running total so callers
// can surface progress while multi-GB uploads spool.
//
// Writes via an fd loop rather than createWriteStream: Node's fs.WriteStream
// coalesces buffered chunks through _writev → Buffer.concat → single fs.write,
// and fs.write rejects any length over 2 GiB. With multi-GiB build contexts
// that path blew up as "length out of range (received 3071787520)". An fd
// loop with explicit per-call chunking sidesteps the coalescing entirely.
const SPOOL_MAX_WRITE = 1 << 30; // 1 GiB, safely under Node's 2 GiB fs.write cap.

async function spoolToTempfile(
  stream: ReadableStream<Uint8Array>,
  onBytes?: (n: number) => void,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "isolade-build-"));
  const path = join(dir, "context.tar");
  const fh = await open(path, "w");
  const reader = stream.getReader();
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      for (let off = 0; off < value.byteLength; off += SPOOL_MAX_WRITE) {
        const len = Math.min(SPOOL_MAX_WRITE, value.byteLength - off);
        await fh.write(value, off, len);
      }
      bytes += value.byteLength;
      onBytes?.(bytes);
    }
  } finally {
    // No explicit reader.releaseLock(): Bun's reader for a drained fetch
    // request body throws "TypeError: undefined is not a function" from
    // native:1 when releaseLock is invoked (even via `?.()`). The reader's
    // lock is released implicitly when the underlying stream completes, so
    // skipping the call is correct on both Bun and standards-compliant
    // runtimes. We just need the fh closed.
    await fh.close();
  }
  return path;
}
