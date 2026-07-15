import {
  ESSENTIAL_NETWORK_DOMAINS,
  type NetworkConfig,
  type SecretInjectMode,
} from "@isolade/shared";
import { execSync } from "child_process";
import { randomUUID } from "crypto";
import { statSync } from "fs";
import {
  Destination,
  type ExecHandle,
  MicrosandboxError,
  NetworkPolicy,
  PatchBuilder,
  PortRange,
  Rule,
  Sandbox,
  SandboxHandle,
} from "microsandbox";
import { createServer } from "net";
import { cpus as hostCpus, totalmem } from "os";
import { join } from "path";

// microsandbox exports PatchBuilder as a value (a constructor alias), not a
// class declaration, so it can't be used directly in type position. The
// `.patch()` callback hands us an *instance*, which is what addPatches takes.
type PatchBuilderInstance = InstanceType<typeof PatchBuilder>;

import { deriveHome, imageUserName, inspectImageConfig } from "./builds";
import { buildRelayScript, openLoopbackRelay } from "./guest-relay";
import { getLocalRegistryEndpoint } from "./host-network";
import { msbStateHome } from "./msb-home";

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on("error", reject);
  });
}

export interface VmVolume {
  /** Path inside the guest. May start with ~/ or $HOME/, resolved against
   * the image's runtime HOME below. */
  guestPath: string;
  /** Absolute host directory bind-mounted at guestPath. */
  hostPath: string;
}

export interface VmSecret {
  /** Env var name exposed in the guest. For the proxy modes the guest sees an
   * auto-generated placeholder. For `env` it sees `value` itself. */
  env: string;
  /** Real value. Kept on the host and substituted by the proxy for the
   * `headers`/`full` modes, and injected straight into the guest env for `env`. */
  value: string;
  /** Hosts the proxy may substitute into. Entries containing `*` are treated
   * as wildcard patterns (microsandbox `allowHostPattern`), others as exact
   * matches (`allowHost`). Empty for the `env` mode. */
  hosts: string[];
  /** Delivery mode (see SECRET_INJECT_MODES): `headers` (proxy, headers only),
   * `full` (proxy, headers + query + body), or `env` (real value injected as a
   * guest env var, no proxy). */
  inject: SecretInjectMode;
}

export interface VmCreateOpts {
  image: string;
  env?: Record<string, string>;
  /** Host bridge ports the VM is allowed to reach (TCP). Each entry adds an
   * allow-egress rule for `host.microsandbox.internal:port`. Without this,
   * the network policy denies the entire host group. */
  hostPorts?: number[];
  ports?: { remote: number }[];
  volumes?: VmVolume[];
  secrets?: VmSecret[];
  /** Global network posture. Absent → open internet with no local/host
   * access (the historical default). See buildNetworkPolicy. */
  network?: NetworkConfig;
}

export interface PortBinding {
  address: string;
  localPort: number;
  remotePort: number;
}

const TTYD_CONNECT_TIMEOUT_MS = 10_000;
const MIB = 1024 * 1024;

// Where the PTY relay script is written in the guest (mirrors port-forwarder's
// RELAY_PATH). One script per VM backs every terminal's ttyd reach.
const PTY_RELAY_PATH = "/tmp/isolade-pty-relay.cjs";

interface VmState {
  sandbox: Sandbox;
}

export function getHostCpuCount() {
  return Math.min(255, Math.max(1, hostCpus().length));
}

function getHostMemoryMib() {
  return Math.max(1, Math.floor(totalmem() / MIB));
}

export function getVmMemoryMib(hostMemoryMib = getHostMemoryMib()) {
  return Math.max(1, Math.floor((hostMemoryMib * 3) / 4));
}

// Maps `~/foo`, `$HOME/foo`, or an absolute path to an absolute guest path.
// HOME is the image's runtime $HOME (from inspectImageConfig / deriveHome).
export function resolveGuestHomePath(input: string, home: string): string {
  if (input.startsWith("~/")) return join(home, input.slice(2));
  if (input === "~") return home;
  if (input.startsWith("$HOME/")) return join(home, input.slice("$HOME/".length));
  if (input === "$HOME") return home;
  return input;
}

// Translate the global NetworkConfig (two orthogonal axes: internet
// open/allowlist, plus independent local-network and host toggles) into a
// microsandbox policy, layering the workspace's opted-in host ports on top.
//
// Rules are first-match-wins, so order matters:
//   1. host-port allows: placed first so a denied `host` group can't shadow
//      a port the workspace explicitly opted into.
//   2. DNS: always allowed (needed for any name resolution, and for the
//      allowlist's domain rules to ever match).
//   3. internet: in allowlist mode, allow the agent essentials + the user's
//      domains (suffix-matched). In open mode the default-allow covers public.
//   4/5. local-network (`private`) and host groups: allowed or denied per
//      toggle, in whichever direction the default action doesn't already give.
//   6. footguns (loopback/link-local/metadata/multicast): never exposed.
//      Explicitly denied under open's default-allow, implicitly under deny.
//
// An undefined config is treated as the historical default: open internet,
// no local/host access, identical rules to the pre-feature behavior.
export function buildNetworkPolicy(
  hostPorts: readonly number[],
  config?: NetworkConfig,
): NetworkPolicy {
  const cfg: NetworkConfig = config ?? {
    internet: "open",
    allowedDomains: [],
    allowLocalNetwork: false,
    allowHost: false,
    ports: [],
    hostPorts: [],
  };
  const allowlist = cfg.internet === "allowlist";

  const hostPortRules = hostPorts.map((port) => ({
    direction: "egress" as const,
    destination: Destination.group("host"),
    protocols: ["tcp" as const],
    ports: [PortRange.single(port)],
    action: "allow" as const,
  }));

  const rules = [...hostPortRules, Rule.allowDns()];

  if (allowlist) {
    // Agent essentials first so the agents always reach their APIs. These are
    // suffix-matched (apex + all subdomains): a deliberately robust, locked
    // set. See ESSENTIAL_NETWORK_DOMAINS. Then the user's domains, which are
    // exact by default with a leading "*." opting into a subdomain suffix.
    for (const host of ESSENTIAL_NETWORK_DOMAINS) {
      rules.push(Rule.allowEgress(Destination.domainSuffix(host)));
    }
    for (const entry of cfg.allowedDomains) {
      const dest = entry.startsWith("*.")
        ? Destination.domainSuffix(entry.slice(2))
        : Destination.domain(entry);
      rules.push(Rule.allowEgress(dest));
    }
  }

  // For each zone group, only one rule is needed: an allow when the default
  // would otherwise deny it (allowlist mode), or a deny when the default
  // would otherwise allow it (open mode). The other two cases are no-ops.
  for (const group of ["private", "host"] as const) {
    const allowed = group === "private" ? cfg.allowLocalNetwork : cfg.allowHost;
    if (allowed && allowlist) rules.push(Rule.allowEgress(Destination.group(group)));
    else if (!allowed && !allowlist) rules.push(Rule.denyEgress(Destination.group(group)));
  }

  // Never-routable / SSRF-prone groups. Under allowlist (default-deny) they're
  // already blocked. Under open (default-allow) they must be denied explicitly.
  if (!allowlist) {
    for (const group of ["loopback", "link-local", "metadata", "multicast"] as const) {
      rules.push(Rule.denyEgress(Destination.group(group)));
    }
  }

  return {
    defaultEgress: allowlist ? "deny" : "allow",
    defaultIngress: "allow",
    rules,
  };
}

// microsandbox surfaces typed errors carrying a lowercase discriminant `.code`
// (see the SDK's MicrosandboxError hierarchy). We branch recovery on the code
// rather than on message text so the state machine below doesn't break when the
// wording of an error changes. Falls back to duck-typing a string `.code` for
// the rare raw napi error that slips past the SDK's instanceof.
function msbErrorCode(err: unknown): string | undefined {
  if (err instanceof MicrosandboxError) return err.code;
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// No persisted record for this name, so nothing to resume or stop.
function isSandboxNotFound(err: unknown): boolean {
  return msbErrorCode(err) === "sandboxNotFound";
}

// `Sandbox.start` refused because microsandbox already considers the VM live.
// Used to fall back from a cold-boot to an attach when a concurrent caller
// booted the VM in the window between our status read and our start.
function isSandboxStillRunning(err: unknown): boolean {
  return msbErrorCode(err) === "sandboxStillRunning";
}

// `connect` refused because the record isn't in a running/draining state. It
// stopped out from under us (e.g. a concurrent stop) between the status read
// and the connect. For a stop that means "already down"; for an attach it means
// "cold-boot it instead".
function isNotRunning(err: unknown): boolean {
  return msbErrorCode(err) === "custom" && /is not running/i.test(errMessage(err));
}

// A record microsandbox still marks running, but whose agent relay socket is
// gone: the owning sandbox process died (SIGKILL/crash) without updating the
// DB. connect() surfaces this as a Runtime error naming the missing endpoint.
// This is the recoverable "stale-running" state: reset the record and cold-boot.
function isNoAgentEndpoint(err: unknown): boolean {
  return msbErrorCode(err) === "runtime" && /no agent endpoint/i.test(errMessage(err));
}

export class VmManager {
  private vms = new Map<string, VmState>();
  // Coalesces concurrent attaches for the same VM (see attachExistingCoalesced).
  // Every attach path funnels through one in-flight promise, so only ONE
  // Sandbox handle is ever constructed per VM. Those paths are the boot resync
  // (ensure), the first exec after a sandbox reload (ensureAttached), and
  // restart. A second concurrent
  // attach would build a rival handle and race to write `vms`. The loser is
  // dropped, and if it held the attached-mode lifecycle handle (whose
  // ProcessHandle keeps the guest's parent-watchdog pipe open) GC'ing it tears
  // the VM down out from under the winner.
  private reattachInFlight = new Map<string, Promise<PortBinding[]>>();

  async create(opts: VmCreateOpts): Promise<{ vmId: string; ports: PortBinding[] }> {
    const t0 = performance.now();
    const name = randomUUID();

    // Inspect the image's config so credential patches (and the env HOME)
    // land in whatever home directory the image actually expects, instead of
    // hardcoding /root. inspectImageConfig returns null for non-local refs
    // or any failure, and we treat that as "default to root", matching the
    // pre-inspection behavior.
    const imageConfig = await inspectImageConfig(opts.image);
    const home = deriveHome(imageConfig);
    const runtimeUser = imageUserName(imageConfig);

    const env: Record<string, string> = {
      TERM: "xterm-256color",
      // Claude Code reads $IS_SANDBOX to allow --dangerously-skip-permissions
      // when the runtime user is root. Without it, claude refuses to start
      // in our default dev image. Cheap to set even for non-root images.
      IS_SANDBOX: "1",
      ...opts.env,
    };

    // `env`-mode secrets put their REAL value straight into the guest
    // environment with no proxy and no substitution. This opts the secret out of the
    // secretless model (any process in the VM can read it), so it's only for
    // secrets the agent must use locally. Folded in before `.envs(env)` below.
    // The proxy modes are wired via `.secret(...)` further down instead.
    for (const secret of opts.secrets ?? []) {
      if (secret.inject === "env") env[secret.env] = secret.value;
    }

    // Published ports: any host↔guest TCP mapping the caller asked for, fixed
    // at create (microsandbox's constraint). isolade's own features no longer
    // use these (user port-forwards ride the dynamic loopback forwarder and
    // terminals reach ttyd over a unix-socket relay), but the capability stays
    // for general callers.
    const tPortStart = performance.now();
    const portBindings: PortBinding[] = [];
    const portsMap: Record<string, number> = {};
    for (const { remote } of opts.ports ?? []) {
      const localPort = await getFreePort();
      portsMap[String(localPort)] = remote;
      portBindings.push({
        address: "127.0.0.1",
        localPort,
        remotePort: remote,
      });
    }
    const tPortDone = performance.now();

    let patchesMs = 0;
    let patchedHomePaths: string[] = [];
    const networkPolicy = buildNetworkPolicy(opts.hostPorts ?? [], opts.network);
    let builder = Sandbox.builder(name)
      .image(opts.image)
      .hostname("vm")
      // The image is fully ingested into microsandbox's local cache by the
      // builder (post-push `microsandbox pull`), and the in-process registry
      // copy is deleted immediately after. Never contact the registry on
      // create. The endpoint baked into `opts.image` is treated purely as
      // an opaque cache key.
      .pullPolicy("never")
      // vCPUs and guest memory are limits, not host reservations. Keep memory
      // below host-sized to avoid microVM memory-map failures on large hosts
      // while still leaving enough room for builds, language servers, and agents.
      .cpus(getHostCpuCount())
      .memory(getVmMemoryMib())
      .envs(env)
      .workdir("/workspace")
      .replace()
      .network((n) => n.policy(networkPolicy))
      .patch((p) => {
        const t = performance.now();
        const { builder: out, homePaths } = this.addPatches(p, home);
        patchedHomePaths = homePaths;
        patchesMs += performance.now() - t;
        return out;
      });

    for (const [hostStr, guestPort] of Object.entries(portsMap)) {
      builder = builder.port(Number(hostStr), guestPort);
    }

    // Bind-mount each requested host dir at its $HOME-resolved guest path.
    // We bind at the tool's default location (e.g. $HOME/.cache/ccache) so
    // the guest finds the cache without any env-var injection, which would
    // be brittle in the face of nix-direnv shellHooks rewriting CCACHE_DIR
    // and friends.
    for (const vol of opts.volumes ?? []) {
      const guestPath = resolveGuestHomePath(vol.guestPath, home);
      builder = builder.volume(guestPath, (m) => m.bind(vol.hostPath));
    }

    if (isInsecureRegistryRef(opts.image)) {
      builder = builder.registry((r) => r.insecure());
    }

    for (const secret of opts.secrets ?? []) {
      if (secret.inject === "env") continue; // injected into the guest env above
      builder = builder.secret((s) => {
        let b = s.env(secret.env).value(secret.value);
        for (const host of secret.hosts) {
          b = host.includes("*") ? b.allowHostPattern(host) : b.allowHost(host);
        }
        // Headers + Basic-Auth are on by default. Query/body are off. The `full`
        // mode widens substitution to the whole request (body + query).
        if (secret.inject === "full") {
          b = b.injectBody(true).injectQuery(true);
        }
        return b;
      });
    }
    const tBuilderConfigured = performance.now();

    const upperPath = join(msbStateHome(), "sandboxes", name, "upper.ext4");
    const upperTargetBytes = 128 * 1024 * 1024 * 1024;
    let tUpperAppeared: number | null = null;
    let tUpperFull: number | null = null;
    const probe = setInterval(() => {
      try {
        const s = statSync(upperPath);
        if (tUpperAppeared === null) tUpperAppeared = performance.now();
        if (tUpperFull === null && s.size >= upperTargetBytes) {
          tUpperFull = performance.now();
          clearInterval(probe);
        }
      } catch {}
    }, 25);

    const sandbox = await builder
      .create()
      .catch((e: unknown) => {
        throw new Error(`VM creation failed: ${e instanceof Error ? e.message : String(e)}`);
      })
      .finally(() => clearInterval(probe));
    const tBuilderCreated = performance.now();

    this.vms.set(name, { sandbox });

    // PatchBuilder writes credential files as root in the rootfs (uid/gid
    // are hard-coded to 0 in microsandbox, with no owner knob on the API). When
    // the runtime user is non-root, claude/codex/gh refuse credentials they
    // can't open for write, so we chown the paths we patched.
    //
    // Crucially: only the exact patched paths plus their parent dirs up to
    // and including $HOME, never a recursive chown of $HOME or /workspace.
    // On overlayfs, chown on a lower-layer file forces a full data copy_up.
    // A `chown -R` over $HOME would copy up the entire image's home tree (Nix
    // caches, claude install, etc.) into upper.ext4, easily hundreds of MiB
    // before the user does anything. /workspace is excluded entirely: the
    // build fragment chowns it (and baked source) to AGENT_USER at image
    // build time, and PatchBuilder doesn't write under it, so the upper
    // layer never materializes a root-owned shadow there.
    //
    // Single-inode chowns on directories are fine. They trigger at most a
    // metadata-only directory copy_up. Lower-layer children stay where they
    // are. `-h` keeps symlink chowns from rewriting their (root-owned)
    // targets like /usr/bin/fdfind.
    if (runtimeUser && runtimeUser !== "root" && patchedHomePaths.length > 0) {
      try {
        const quoted = patchedHomePaths.map((p) => `'${p}'`).join(" ");
        const out = await sandbox.execWith("/bin/sh", (b) =>
          b
            .args(["-c", `chown -h ${runtimeUser}:${runtimeUser} ${quoted} 2>/dev/null || true`])
            .user("root"),
        );
        if (out.code !== 0) {
          console.warn(
            `[vm-create name=${name}] chown to ${runtimeUser} exited ${out.code}: ${out.stderr().trim()}`,
          );
        }
      } catch (err) {
        console.warn(`[vm-create name=${name}] chown failed:`, err);
      }
    }
    const tChownDone = performance.now();

    // Strip the AAAA entries microsandbox writes for host.microsandbox.internal.
    // The alias resolves to both v4 (CGNAT) and v6 (ULA), and microsandbox's
    // bridge terminates v6 SYNs even when the actual host process binds v4-only
    // (Bun/Node/Vite/most dev servers do). Apps that pick v6 (including
    // curl's happy-eyeballs racer) then get TCP-established but empty replies.
    // Scoped to this one hostname so we don't disturb any other v6 resolution
    // in the guest.
    try {
      await sandbox.execWith("/bin/sh", (b) =>
        b
          .args([
            "-c",
            `sed -i -E '/^[^[:space:]]*:[^[:space:]]*[[:space:]].*host\\.microsandbox\\.internal/d' /etc/hosts || true`,
          ])
          .user("root"),
      );
    } catch (err) {
      console.warn(`[vm-create name=${name}] /etc/hosts v6-strip failed:`, err);
    }

    // After chown so the runtime user can write into $HOME. The github.com
    // credential helper is only wired up when the workspace registered a
    // GH_TOKEN secret. That's what `gh auth git-credential` reads (as a
    // placeholder the proxy substitutes on egress to github.com).
    const hasGitHubToken = (opts.secrets ?? []).some((s) => s.env === "GH_TOKEN");
    await this.applyGitconfig(sandbox, runtimeUser, home, hasGitHubToken);

    const fmt = (ms: number) => `${ms.toFixed(0)}ms`;
    const upperAppeared = tUpperAppeared !== null ? fmt(tUpperAppeared - tBuilderConfigured) : "?";
    const upperFull = tUpperFull !== null ? fmt(tUpperFull - tBuilderConfigured) : "?";
    const mkfs =
      tUpperAppeared !== null && tUpperFull !== null ? fmt(tUpperFull - tUpperAppeared) : "?";
    const postMkfs = tUpperFull !== null ? fmt(tBuilderCreated - tUpperFull) : "?";
    console.log(
      `[vm-create name=${name} image=${opts.image}] ` +
        `portAlloc=${fmt(tPortDone - tPortStart)} ` +
        `builderConfig=${fmt(tBuilderConfigured - tPortDone)} ` +
        `addPatches=${fmt(patchesMs)} ` +
        `builderCreate=${fmt(tBuilderCreated - tBuilderConfigured)} ` +
        `[upperAppeared=${upperAppeared} mkfs=${mkfs} upperFull=${upperFull} postMkfs=${postMkfs}] ` +
        `chown=${fmt(tChownDone - tBuilderCreated)} ` +
        `total=${fmt(tChownDone - t0)}`,
    );

    return { vmId: name, ports: portBindings };
  }

  // Rootfs patches applied before boot. `home` is the absolute path we should
  // treat as $HOME for the runtime user (derived from the image config,
  // defaulting to /root).
  //
  // Returns `homePaths`: every path under $HOME we created or wrote. These are
  // files, symlinks, and the intermediate parent dirs PatchBuilder materializes
  // (root-owned). The caller chowns these to the runtime user. /workspace is
  // omitted because its lower-layer ownership is already set at image build
  // time and chowning it would force an unnecessary directory copy_up.
  private addPatches(
    p: PatchBuilderInstance,
    home: string,
  ): { builder: PatchBuilderInstance; homePaths: string[] } {
    const homePrefix = home.endsWith("/") ? home : `${home}/`;
    const dirs = new Set<string>();
    const leaves: string[] = [];
    // Every parent dir of `path` up to and including $HOME. PatchBuilder
    // writes into the upper ext4 layer directly, and every dir entry on the
    // way to a patched file is materialized there as root-owned, including
    // $HOME itself. At overlayfs mount the upper layer's metadata wins over
    // the lower layer's agent-owned $HOME, so we have to chown $HOME too or
    // the runtime user can't create lock files (e.g. .gitconfig.lock) in it.
    const addParents = (path: string) => {
      let cursor = path;
      while (true) {
        const slash = cursor.lastIndexOf("/");
        if (slash < homePrefix.length - 1) break;
        cursor = cursor.slice(0, slash);
        dirs.add(cursor);
      }
    };
    const mkdir = (path: string) => {
      p.mkdir(path);
      if (path.startsWith(homePrefix)) {
        dirs.add(path);
        addParents(path);
      }
    };
    const text = (path: string, content: string, opts?: { replace?: boolean }) => {
      p.text(path, content, opts);
      if (path.startsWith(homePrefix)) {
        leaves.push(path);
        addParents(path);
      }
    };

    // /workspace is our guest workdir. Minimal base images like alpine don't
    // have it. mkdir is idempotent so this is safe even on isolade-dev
    // where the Dockerfile already creates it. Not added to homePaths, since the
    // build fragment owns /workspace as AGENT_USER at image build time.
    p.mkdir("/workspace");

    // Credentials injected from host always overwrite whatever the image
    // pre-populated (e.g. `claude install` creates ~/.claude.json).
    const overwrite = { replace: true };

    // Suppress first-run callouts that fire when claude transitions a state
    // flag from undefined → its discovered value:
    //   - "Anthropic marketplace installed · /plugin to see..." (gated by
    //     officialMarketplaceAutoInstall*)
    //   - "Fast mode is now available · /fast to turn on" (gated by a
    //     transition check against penguinModeOrgEnabled in this file)
    //
    // Claude/Codex credentials are NO LONGER injected here. They arrive at
    // runtime via the bind-mounted host auth dir + the in-VM auth-sync watcher
    // (InstanceManager.setupAgentAuth), which lets a refresh inside the VM
    // propagate back out. We still mark onboarding complete + set
    // skipDangerousModePermissionPrompt so the agent runs non-interactively
    // regardless of whether a login has happened yet.
    const claudeJson: Record<string, unknown> = {
      officialMarketplaceAutoInstallAttempted: true,
      officialMarketplaceAutoInstalled: true,
      penguinModeOrgEnabled: true,
      hasCompletedOnboarding: true,
      effortCalloutDismissed: true,
      projects: {
        "/workspace": { allowedTools: [], hasTrustDialogAccepted: true },
      },
    };
    mkdir(`${home}/.claude`);
    text(
      `${home}/.claude/settings.json`,
      JSON.stringify({
        skipDangerousModePermissionPrompt: true,
        autoMemoryEnabled: false,
      }),
      overwrite,
    );
    text(`${home}/.claude.json`, JSON.stringify(claudeJson), overwrite);

    // Dirs first so the chown invocation lists parents before children.
    // This isn't strictly required for a single-shot chown but keeps logs readable.
    const homePaths = [...[...dirs].toSorted(), ...leaves];
    return { builder: p, homePaths };
  }

  // Merges our host-derived git identity and GitHub credential helper into
  // $HOME/.gitconfig inside the guest, preserving anything the image baked
  // in (aliases, core.* tweaks, etc.). Runs `git config --global` as the
  // runtime user so the file is created/updated with correct ownership and
  // lands in whatever HOME git resolves to. We don't touch other
  // credential.* hosts, only the github.com helper, which we want to point
  // at gh so the GH_TOKEN secret flows through.
  private async applyGitconfig(
    sandbox: Sandbox,
    runtimeUser: string | null,
    home: string,
    hasGitHubToken: boolean,
  ) {
    const userName = readHostGitConfig("user.name");
    const userEmail = readHostGitConfig("user.email");

    const cmds: string[] = [];
    if (userName) {
      cmds.push(`git config --global user.name ${shellSingleQuote(userName)}`);
    }
    if (userEmail) {
      cmds.push(`git config --global user.email ${shellSingleQuote(userEmail)}`);
    }
    if (hasGitHubToken) {
      // Wipe any pre-existing helper chain for this exact host so re-creates
      // don't accumulate duplicates. The first --add with an empty value
      // clears inherited (system-scope) helpers, and the second installs ours.
      cmds.push(
        `git config --global --unset-all 'credential.https://github.com.helper' 2>/dev/null || true`,
        `git config --global --add 'credential.https://github.com.helper' ''`,
        `git config --global --add 'credential.https://github.com.helper' '!$(command -v gh) auth git-credential'`,
      );
    }
    if (cmds.length === 0) return;

    // Set HOME explicitly: microsandbox's exec doesn't necessarily seed the
    // runtime user's HOME from passwd, and `git config --global` needs the
    // right path to land in the runtime user's $HOME/.gitconfig.
    const script = `export HOME=${shellSingleQuote(home)}; ${cmds.join(" ; ")}`;
    try {
      const out = await sandbox.execWith("/bin/sh", (b) => {
        b.args(["-c", script]);
        if (runtimeUser) b.user(runtimeUser);
        return b;
      });
      if (out.code !== 0) {
        console.warn(`[vm-create] gitconfig merge exited ${out.code}: ${out.stderr().trim()}`);
      }
    } catch (err) {
      console.warn(`[vm-create] gitconfig merge failed:`, err);
    }
  }

  async exec(
    vmId: string,
    command: string,
    opts: { workingDir?: string; timeoutMs?: number } = {},
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return this.withConnection(vmId, async (sandbox) => {
      if (opts.workingDir || opts.timeoutMs) {
        const out = await sandbox.execWith("/bin/sh", (b) => {
          b.args(["-c", command]);
          if (opts.workingDir) b.cwd(opts.workingDir);
          if (opts.timeoutMs) b.timeout(opts.timeoutMs);
          return b;
        });
        return {
          stdout: out.stdout(),
          stderr: out.stderr(),
          exitCode: out.code,
        };
      }
      const out = await sandbox.shell(command);
      return { stdout: out.stdout(), stderr: out.stderr(), exitCode: out.code };
    });
  }

  async writeFile(vmId: string, path: string, content: Buffer) {
    await this.withConnection(vmId, (sandbox) => sandbox.fs().write(path, content));
  }

  async execStream(
    vmId: string,
    command: string,
    opts: {
      stdin: AsyncIterable<Buffer>;
      stdout: (chunk: Buffer) => void;
      stderr?: (chunk: Buffer) => void;
      signal?: AbortSignal;
    },
  ): Promise<{ exitCode: number }> {
    return this.withConnection(vmId, async (sandbox) => {
      const handle = await sandbox.execStreamWith("/bin/sh", (b) =>
        b.args(["-c", command]).stdinPipe(),
      );

      // Abort the subprocess on signal. The recv() loop falls through once
      // the handle is killed, and the caller sees a non-zero exit code.
      const onAbort = () => {
        handle.kill().catch((err) => {
          console.warn(`[exec-stream ${vmId}] kill failed:`, err);
        });
      };
      if (opts.signal) {
        if (opts.signal.aborted) onAbort();
        else opts.signal.addEventListener("abort", onAbort, { once: true });
      }

      (async () => {
        const sink = await handle.takeStdin();
        if (!sink) return;
        try {
          for await (const chunk of opts.stdin) {
            await sink.write(chunk).catch(() => {});
          }
        } finally {
          await sink.close().catch(() => {});
        }
      })().catch(() => {});

      // `null` until the guest process actually reports an exit code. If the
      // event stream ends while this is still null, the process never exited
      // on its own: the agent connection dropped or the VM was stopped out
      // from under a live command (e.g. its creator process died and
      // microsandbox tore the VM down, "creator process exited; stopping
      // attached sandbox"). Defaulting to 0 there is a trap. It makes a
      // truncated stream look like a clean success, so the chat backend
      // reports a killed turn as the nonsensical "claude exited with code 0"
      // and persists the partial turn as if it had completed. Surface it as
      // the failure it is. (The WebSocket transport already guards this on its
      // own side, see sandbox-client.ts's exec-stream `onclose` handler.)
      let exitCode: number | null = null;
      try {
        while (true) {
          const ev = await handle.recv();
          if (!ev) break;
          if (ev.kind === "stdout") opts.stdout(Buffer.from(ev.data));
          else if (ev.kind === "stderr") opts.stderr?.(Buffer.from(ev.data));
          else if (ev.kind === "exited") exitCode = ev.code;
        }
      } finally {
        if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      }

      if (exitCode === null) {
        // We asked for the kill ourselves (Stop / force-kill): report a
        // conventional "killed by signal" code instead of throwing, so the
        // caller's abort handling (which already normalizes this to a
        // cancellation) stays on its happy path.
        if (opts.signal?.aborted) return { exitCode: 137 };
        throw new Error(
          `exec stream for VM ${vmId} ended before the process reported an exit ` +
            `(agent connection dropped or the VM was stopped)`,
        );
      }

      return { exitCode };
    });
  }

  // Runs ttyd inside the guest on a per-terminal unix socket and proxies its
  // WebSocket to the caller's {stdin, stdout, resize} contract. Microsandbox's
  // own attach/exec APIs don't expose a resizable PTY, hence ttyd + the proxy.
  //
  // The host reaches ttyd through the shared loopback relay (openLoopbackRelay):
  // a host loopback listener whose per-connection guest relay dials ttyd's unix
  // socket. So a terminal needs no guest TCP port and nothing pre-allocated at
  // VM create. It's just a fresh socket + relay, opened on demand and torn down
  // when the session ends. That removes the old fixed PTY-port pool (and its
  // hard cap on concurrent terminals), and leaves nothing for the Ports panel's
  // listener probe to mistake for a user server.
  async execInteractive(
    vmId: string,
    shell: string,
    opts: {
      stdin: AsyncIterable<Buffer>;
      stdout: (chunk: Buffer) => void;
      rows: number;
      cols: number;
      resize: AsyncIterable<[number, number]>;
    },
  ): Promise<{ exitCode: number }> {
    await this.ensureAttached(vmId);
    const ttydSocket = `/tmp/isolade-ttyd-${randomUUID()}.sock`;

    // A terminal's ttyd `shellStream` stays open for the entire life of the
    // session (potentially hours), so it MUST run on its own connection. On
    // the shared handle it would serialize behind / in front of every chat turn
    // and exec on this VM. withConnection gives it a dedicated one, released
    // when the terminal closes.
    return await this.withConnection(vmId, async (sandbox) => {
      let ttydHandle: ExecHandle | null = null;
      let relay: ReturnType<typeof openLoopbackRelay> | null = null;
      try {
        // Write the relay script, then start ttyd on the unix socket. -W
        // writable, -q exit on all-clients-disconnect, -i <socket> so it binds
        // the socket the relay dials (no guest TCP port). Wrap the user command
        // in sh -c to handle multi-token strings like
        // "claude --dangerously-skip-permissions".
        await sandbox.fs().write(PTY_RELAY_PATH, Buffer.from(buildRelayScript(), "utf8"));
        const ttydCmd =
          `ttyd -W -q -i ${ttydSocket} ` + `/bin/sh -c ${JSON.stringify("exec " + shell)}`;
        ttydHandle = await sandbox.shellStream(ttydCmd);
        // Drain ttyd's own stdout/stderr so the handle doesn't back up.
        (async () => {
          while (true) {
            const ev = await ttydHandle!.recv();
            if (!ev) break;
          }
        })().catch(() => {});

        // Host loopback listener → per-connection relay → ttyd's guest socket.
        relay = openLoopbackRelay({
          transport: this,
          vmId,
          relayPath: PTY_RELAY_PATH,
          target: ttydSocket,
        });
        const hostPort = relay.port;
        await waitForTtydHttp("127.0.0.1", hostPort, 7000);

        return {
          exitCode: await proxyTtydWs({
            url: `ws://127.0.0.1:${hostPort}/ws`,
            rows: opts.rows,
            cols: opts.cols,
            stdin: opts.stdin,
            stdout: opts.stdout,
            resize: opts.resize,
          }),
        };
      } finally {
        if (relay) {
          try {
            relay.stop(true);
          } catch {}
        }
        if (ttydHandle) {
          // kill() can hang indefinitely (observed on msb 0.5.4), and cleanup
          // must never mask the session's real error or wedge the route.
          // An unkilled ttyd self-exits via -q once its clients disconnect.
          const killed = await Promise.race([
            ttydHandle.kill().then(
              () => true,
              () => true,
            ),
            new Promise<boolean>((r) => setTimeout(() => r(false), 3000)),
          ]);
          if (!killed) {
            console.warn(`[vm ${vmId}] ttyd kill timed out, leaving process to ttyd -q cleanup`);
          }
        }
        // Best-effort: drop the per-terminal socket file (uuid-unique and in
        // /tmp, so harmless if it lingers, but tidy up rather than accumulate).
        void this.exec(vmId, `rm -f ${ttydSocket}`).catch(() => {});
      }
    });
  }

  listVmHandles(): { id: string; sandbox: Sandbox }[] {
    return Array.from(this.vms.entries()).map(([id, state]) => ({
      id,
      sandbox: state.sandbox,
    }));
  }

  // Stops a VM and re-starts it from its persisted microsandbox record.
  // Used by the user-facing "Restart VM" action. Returns the fresh
  // PortBinding[] so the server can repopulate its in-memory map. On a map
  // miss the stop half is skipped: attachExisting's startOrConnect handles
  // every persisted state: booting a stopped/crashed record, attaching to a
  // still-running orphan, and recovering a stale-running one (dead process,
  // DB still says running) by resetting it and cold-booting.
  async restart(vmId: string): Promise<PortBinding[]> {
    if (this.vms.has(vmId)) await this.stop(vmId);
    // Coalesce like ensure(): a broker reconnect or probe can hit ensureAttached
    // while we're re-attaching, and two rival handles would tear the VM down.
    return this.attachExistingCoalesced(vmId);
  }

  // Stop a VM without removing its persisted microsandbox record, so it can be
  // resumed later via `restart`/`ensure` (Sandbox.start). Used when archiving a
  // chat: the guest goes quiet (no CPU/RAM) but its rootfs (agent sessions,
  // git work) survives on disk for a later unarchive.
  //
  // Best-effort by contract: this never throws. A VM we can't stop is at worst
  // still running (reaped on the next full shutdown), the persisted record
  // (what a later resume needs) is intact regardless, and every caller
  // (archive, resyncAll) already treats stopping as non-fatal. So every failure
  // here is logged, not raised. The only early returns are the "already stopped
  // / nothing to do" cases.
  async stop(vmId: string): Promise<void> {
    const existing = this.vms.get(vmId);
    if (existing) {
      this.vms.delete(vmId);
      // Discard any attach in flight for this VM: we're stopping it, so a
      // concurrent attach's handle must not linger and get adopted as live.
      this.reattachInFlight.delete(vmId);
      // Sync the guest before stop so writebacks land on upper.ext4.
      // The agentd Shutdown handler asks the guest kernel to power off
      // before exiting the VMM, but that's racy with virtio-blk write
      // buffering. Without this, recent file writes inside the guest
      // (e.g. ~/.claude/projects/*.jsonl session files) end up as 0-byte
      // inodes on the upper layer because their data pages never made
      // it through the block device to the host's backing file.
      try {
        await existing.sandbox.shell("sync");
      } catch (err) {
        console.warn(`[vm-stop ${vmId}] pre-stop sync failed:`, err);
      }
      try {
        await existing.sandbox.stop();
      } catch (err) {
        // Already stopped / crashed → fine. The record is what matters, and
        // a restart's follow-up start will surface a clearer error if the
        // persisted record is unusable.
        console.warn(`[vm-stop ${vmId}] stop failed:`, err);
      }
      return;
    }
    // Not in our map. The sandbox-service restarted while this VM's record
    // persisted. Read the reconciled status instead of blindly connecting: an
    // already-stopped record (the normal state for an archived instance at
    // boot, or any VM after a clean shutdown) needs no work and must not be
    // logged as a failure.
    let handle: SandboxHandle;
    try {
      handle = await this.getHandle(vmId);
    } catch (err) {
      // No persisted record → nothing to stop. Any other lookup failure is
      // unexpected, but stop() is best-effort: log it and move on.
      if (!isSandboxNotFound(err)) console.warn(`[vm-stop ${vmId}] lookup failed:`, err);
      return;
    }
    if (handle.status !== "running" && handle.status !== "draining") return;

    // Best-effort pre-stop sync while the guest is still reachable, so its
    // writebacks land on disk before power-off (agentd's own shutdown sync is
    // racy, see the in-map path). If we can't reach it (already gone, or a
    // stale record whose agent socket died), there's nothing to flush, so skip.
    const sandbox = await handle.connect().catch(() => null);
    if (sandbox) {
      await sandbox
        .shell("sync")
        .catch((err) => console.warn(`[vm-stop ${vmId}] pre-stop sync failed:`, err));
      await sandbox.detach().catch(() => {});
    }

    // One stop, by name. stop_local covers every remaining state uniformly: a
    // no-op if the record already stopped, a graceful guest shutdown if it's
    // reachable, and PID termination if it's stale-running, so we don't
    // re-classify here, we just delegate and log if even that can't complete.
    await handle.stop().catch((err) => console.warn(`[vm-stop ${vmId}] stop failed:`, err));
  }

  // Repopulates this.vms[vmId] if the VM is still alive in microsandbox
  // but missing from our in-memory map. Cheap re-attach path used by the
  // server's boot-time resync: when only the isolade server reloaded
  // (not the sandbox-service), the running VM is fine and we just need
  // to refresh port bindings without a stop/start cycle. If the VM isn't
  // alive, falls through to attachExisting (Sandbox.start).
  async ensure(vmId: string): Promise<PortBinding[]> {
    const existing = this.vms.get(vmId);
    if (existing) return this.portBindings(await this.readPortsTcp(existing.sandbox));
    // Coalesce with any concurrent attach (a boot-time diff-stats probe or a
    // broker reconnect hitting ensureAttached) so we don't build a rival handle.
    return this.attachExistingCoalesced(vmId);
  }

  // Resume a persisted sandbox to a live, attached Sandbox, driven by its
  // reconciled status rather than by trial-and-error. microsandbox reconciles a
  // dead-PID "running" record to "crashed" when we read the handle, so
  // `handle.status` is authoritative about whether a VM process should be live:
  //
  //   - running / draining → a process should be up. Attach to it (connect).
  //     If the agent socket is gone (the sandbox-service was SIGKILL'd and took
  //     the VM down but msb's DB still says "running"), the record is
  //     *stale-running*: reset it and cold-boot, so a crash-killed host recovers
  //     to a healthy VM instead of stranding the instance in `error`.
  //   - stopped / crashed → cold-boot from the persisted rootfs (disk survives).
  //
  // Reading the status up front (instead of start()-then-catch) keeps the
  // common "already running" case quiet. We only attempt the operation that
  // matches the observed state.
  private async startOrConnect(vmId: string): Promise<Sandbox> {
    const handle = await this.getHandle(vmId);
    if (handle.status === "running" || handle.status === "draining") {
      return this.connectOrRecover(vmId, handle);
    }
    // stopped / crashed → cold-boot. Guard the small TOCTOU window where a
    // concurrent caller started it between our status read and here: then
    // start() reports it already running, so re-read and attach instead.
    try {
      return await this.startSandbox(vmId);
    } catch (err) {
      if (isSandboxStillRunning(err)) {
        return this.connectOrRecover(vmId, await this.getHandle(vmId));
      }
      throw err; // unrecognized, so surface it
    }
  }

  // Attach to a record microsandbox believes is live. On the happy path (the VM
  // really is up, e.g. only the isolade server reloaded) connect() returns a
  // handle that doesn't own the lifecycle but whose exec/shell/stop all work via
  // the agent socket.
  //
  // Unlike stop(), this must DELIVER a live Sandbox or throw. The caller needs
  // a working VM, so an error it can't classify is raised, not logged. It
  // dispatches the two recoverable states to a cold-boot. The only best-effort
  // step is the kill() that resets a stale record, because the startSandbox that
  // follows is the authoritative recovery (it throws if the boot truly fails),
  // so a kill hiccup the boot survives isn't a real failure.
  private async connectOrRecover(vmId: string, handle: SandboxHandle): Promise<Sandbox> {
    try {
      return await handle.connect();
    } catch (err) {
      // Raced to stopped between the status read and the connect → cold-boot it.
      if (isNotRunning(err)) return this.startSandbox(vmId);
      // Stale-running: the record says running but its agent socket is gone
      // (owning process died in an unclean prior shutdown). Reset it with kill(),
      // which force-terminates any lingering PID and marks the record stopped,
      // then cold-boot from the surviving rootfs.
      if (isNoAgentEndpoint(err)) {
        console.warn(
          `[vm-attach ${vmId}] record is marked running but its agent socket is ` +
            `gone (unclean prior shutdown). Resetting the stale record and cold-booting`,
        );
        await handle
          .kill()
          .catch((e) =>
            console.warn(`[vm-attach ${vmId}] stale-record kill failed (continuing to boot):`, e),
          );
        return this.startSandbox(vmId);
      }
      throw err; // unrecognized state, can't safely recover, so surface it
    }
  }

  private async readPortsTcp(sandbox: Sandbox): Promise<{ hostPort: number; guestPort: number }[]> {
    const rawConfig = (await sandbox.config()) as {
      network?: {
        ports?: ReadonlyArray<{
          hostPort: number;
          guestPort: number;
          protocol?: string;
        }>;
      };
    };
    return (rawConfig.network?.ports ?? []).filter(
      (p) => (p.protocol ?? "tcp").toLowerCase() === "tcp",
    );
  }

  private portBindings(ports: { hostPort: number; guestPort: number }[]): PortBinding[] {
    return ports.map(({ hostPort, guestPort }) => ({
      address: "127.0.0.1",
      localPort: hostPort,
      remotePort: guestPort,
    }));
  }

  // Attach to a persisted sandbox by name (microsandbox's `Sandbox.start`)
  // and rebuild VmState from its config. Used at boot to re-hydrate every
  // VM the isolade service knows about, and by `restart()`.
  //
  // Note: the SDK's `SandboxConfig` type advertises a flat `portsTcp`
  // tuple list, but the actual JSON shape from `configJson()` puts ports
  // under `network.ports` as `{ hostPort, guestPort, protocol }` objects
  // (camelCased from the on-disk snake_case). The flat `portsTcp` field
  // is a documentation artifact, not populated.
  async attachExisting(vmId: string): Promise<PortBinding[]> {
    const sandbox = await this.startOrConnect(vmId);
    const ports = await this.readPortsTcp(sandbox);
    this.vms.set(vmId, { sandbox });
    return this.portBindings(ports);
  }

  async remove(vmId: string) {
    const state = this.vms.get(vmId);
    this.vms.delete(vmId);
    // If we still hold the live handle, use it. Otherwise the sandbox-service
    // process was restarted after the VM was created. The in-memory map is
    // gone but the microsandbox VM is still running. Reattach via the
    // persisted record so DELETE actually kills it.
    if (state) {
      let stopped = false;
      try {
        await state.sandbox.stop();
        stopped = true;
      } catch (err) {
        console.warn(`[vm-remove ${vmId}] stop failed:`, err);
      }
      try {
        await Sandbox.remove(state.sandbox.name);
      } catch (err) {
        if (stopped) console.warn(`[vm-remove ${vmId}] Sandbox.remove failed:`, err);
      }
      return;
    }
    let handle;
    try {
      handle = await Sandbox.get(vmId);
    } catch (err) {
      // No persisted record either, so nothing to remove. (Already cleaned up,
      // or the name was never valid.)
      console.warn(`[vm-remove ${vmId}] no live handle and Sandbox.get failed:`, err);
      return;
    }
    try {
      await handle.kill();
    } catch (err) {
      console.warn(`[vm-remove ${vmId}] kill failed:`, err);
    }
    try {
      await handle.remove();
    } catch (err) {
      console.warn(`[vm-remove ${vmId}] remove failed:`, err);
    }
  }

  // Stop and remove every VM we know about. Called when the user wants
  // VMs gone for good (not used on graceful shutdown, see stopAll).
  async removeAll() {
    const ids = Array.from(this.vms.keys());
    await Promise.all(ids.map((id) => this.remove(id).catch(() => {})));
  }

  // Gracefully stop every VM without removing the persisted microsandbox
  // record. Called on SIGTERM/SIGINT so the next isolade boot can
  // re-attach via `Sandbox.start(name)` instead of cold-creating fresh
  // VMs. Leaves the in-memory map empty. Re-population happens via
  // attachExisting on the server's boot-time resync path.
  async stopAll() {
    const entries = Array.from(this.vms.entries());
    this.vms.clear();
    await Promise.all(
      entries.map(async ([id, state]) => {
        // See `restart()` for why we force a sync before stop.
        try {
          await state.sandbox.shell("sync");
        } catch (err) {
          console.warn(`[vm-stop ${id}] pre-stop sync failed:`, err);
        }
        try {
          await state.sandbox.stop();
        } catch (err) {
          console.warn(`[vm-stop ${id}] stop failed:`, err);
        }
      }),
    );
  }

  // Run an operation on its own dedicated agent connection.
  //
  // microsandbox multiplexes nothing at the high level: every RPC issued on
  // a `Sandbox` handle serializes over that handle's single agent connection,
  // so one long-running call (a multi-minute `claude -p` turn streaming
  // stdout, or a PTY's `shellStream` that stays open for the terminal's whole
  // life) blocks *every* other call on the same handle: context probes, a
  // second chat, port probes, file writes. That head-of-line blocking is the
  // single biggest source of "the chat froze" reports.
  //
  // The cure is to stop sharing one connection. Each exec/stream/write opens
  // its own connection via `Sandbox.get(vmId).connect()` and releases it with
  // `detach()` (which drops the connection without touching VM lifecycle,
  // since connected handles have ownsLifecycle=false). connect()/detach() are
  // sub-millisecond once the VM is warm, so the per-op cost is noise next to
  // the work itself, and concurrency is bounded naturally by the number of
  // in-flight server operations.
  //
  // The stored lifecycle handle (`VmState.sandbox`, from create/start) is
  // deliberately never used for execs anymore. It's reserved for
  // stop/restart/config/metrics, so those never contend with in-flight execs
  // either.
  private async withConnection<T>(vmId: string, fn: (sandbox: Sandbox) => Promise<T>): Promise<T> {
    // Ensure we manage this VM before connecting (self-heals after a sandbox
    // restart) and avoid attaching to a VM this process doesn't own.
    await this.ensureAttached(vmId);
    const connection = await this.openConnection(vmId);
    try {
      return await fn(connection);
    } finally {
      // Best-effort: a failed detach leaks one connection until the VM stops
      // (never a correctness problem), but a chronic leak is worth surfacing.
      await connection.detach().catch((err) => {
        console.warn(`[vm ${vmId}] connection detach failed:`, err);
      });
    }
  }

  // Make sure `vmId` is in our in-memory map, reattaching if it isn't.
  //
  // The map is process-memory only. When the sandbox process restarts (a
  // crash, or `bun --watch` reloading on a code change in dev) but the
  // microsandbox VMs keep running, the map comes back empty while the server
  // still believes its instances are live, so every exec used to fail with
  // "VM not found" until the *server* restarted and re-ran its boot resync.
  // Self-heal instead: on a cache miss, reattach via the same battle-tested
  // attachExisting() path the boot resync uses (it connects to an
  // already-running VM, or starts a stopped one). A removed VM has no
  // persisted record, so attachExisting throws and the operation surfaces the
  // failure honestly rather than reviving a deleted VM.
  //
  // Concurrent first-touches dedupe on one in-flight attach so a burst of
  // execs right after a restart doesn't open N redundant lifecycle handles.
  private async ensureAttached(vmId: string): Promise<void> {
    if (this.vms.has(vmId)) return;
    // Only the call that actually starts the attach (not the ones joining an
    // in-flight one, and not a resync's ensure() that got there first) logs the
    // cache-miss recovery. attachExistingCoalesced registers the promise
    // synchronously, so this has()-check reliably identifies the initiator.
    const initiating = !this.reattachInFlight.has(vmId);
    const pending = this.attachExistingCoalesced(vmId);
    if (initiating) {
      void pending
        .then(() =>
          console.warn(`[vm ${vmId}] reattached after cache miss (sandbox-restart recovery)`),
        )
        .catch(() => undefined);
    }
    await pending;
  }

  // Attach to a persisted VM, coalescing concurrent callers onto one attach so
  // exactly one Sandbox handle is constructed and stored (see reattachInFlight
  // for why a rival handle is dangerous). Wraps the overridable attachExisting()
  // so the boot resync (ensure), the exec self-heal (ensureAttached), and
  // restart all share a single in-flight attach per VM.
  private attachExistingCoalesced(vmId: string): Promise<PortBinding[]> {
    const inFlight = this.reattachInFlight.get(vmId);
    if (inFlight) return inFlight;
    const pending = this.attachExisting(vmId);
    this.reattachInFlight.set(vmId, pending);
    void pending
      .catch(() => undefined)
      .finally(() => {
        if (this.reattachInFlight.get(vmId) === pending) this.reattachInFlight.delete(vmId);
      });
    return pending;
  }

  // Open a fresh, independent agent connection to a running VM. Seam point:
  // overridable in tests so the connection model can be exercised without a
  // live microsandbox. Production always goes through Sandbox.get().connect().
  protected async openConnection(vmId: string): Promise<Sandbox> {
    const handle = await Sandbox.get(vmId);
    return handle.connect();
  }

  // Look up the persisted database handle for a VM, carrying its reconciled
  // status (microsandbox reconciles a dead-PID "running" record to "crashed" at
  // read time, so the status is authoritative). Seam point: overridable in
  // tests to drive the lifecycle state machine without a live microsandbox.
  protected getHandle(vmId: string): Promise<SandboxHandle> {
    return Sandbox.get(vmId);
  }

  // Cold-boot a persisted (stopped/crashed) VM from its rootfs. The disk
  // survives across a stop, so this resumes state rather than starting fresh.
  // Seam point: overridable in tests alongside getHandle().
  protected startSandbox(vmId: string): Promise<Sandbox> {
    return Sandbox.start(vmId);
  }
}

// The in-process OCI registry is plain-HTTP, so tell microsandbox to skip TLS
// for images whose host:port matches it. Anything else (ghcr.io, docker.io,
// etc.) keeps the default HTTPS path.
//
// Image refs the builder hands out use the host bridge IP (e.g.
// "192.168.64.1:53892/...") with the live bound port, so the same string
// works for both the buildkit push and the guest-side pull.
export function isInsecureRegistryRef(imageRef: string): boolean {
  const slash = imageRef.indexOf("/");
  if (slash < 0) return false;
  const host = imageRef.slice(0, slash);
  if (host.startsWith("localhost:") || host.startsWith("127.0.0.1:")) return true;
  const bridgeRegistry = getLocalRegistryEndpoint();
  if (bridgeRegistry && host === bridgeRegistry) return true;
  return false;
}

function readHostGitConfig(key: string): string {
  try {
    return execSync(`git config --global ${key}`, { encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
}

// Quote a string for safe inclusion in a single-quoted shell argument.
function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ttyd readiness can't be probed with a bare TCP connect: the msb relay
// accepts host-side connections unconditionally and only drops them ~1s
// later when nothing listens in the guest. An HTTP round-trip through the
// forward only succeeds once ttyd is actually serving. Dialing the proxy
// any earlier gets killed by the relay mid-handshake.
async function waitForTtydHttp(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`http://${host}:${port}/`, {
        signal: AbortSignal.timeout(800),
      });
      await resp.arrayBuffer().catch(() => {});
      return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `ttyd did not become reachable on ${host}:${port} within ${timeoutMs}ms: ${lastErr}`,
  );
}

interface ProxyWsOpts {
  url: string;
  rows: number;
  cols: number;
  stdin: AsyncIterable<Buffer>;
  stdout: (chunk: Buffer) => void;
  resize: AsyncIterable<[number, number]>;
}

// Translates between our {stdin, stdout, resize} contract and ttyd's WS
// framing. Handshake is a text JSON frame with {AuthToken, columns, rows}.
// subsequent client frames are [typeByte, ...payload] where '0' = INPUT and
// '1' = RESIZE (JSON payload). Server frames: '0' = OUTPUT, '1'/'2' ignored.
export function proxyTtydWs(
  opts: ProxyWsOpts,
  connectTimeoutMs = TTYD_CONNECT_TIMEOUT_MS,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(opts.url, "tty");
    ws.binaryType = "arraybuffer";
    let resolved = false;

    // A dial the relay accepts but never upgrades (no guest listener, or a
    // wedged socket layer) fires neither open nor error, so without a deadline
    // the session hangs forever and its PTY-pool slot stays busy.
    const connectTimer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      try {
        ws.close();
      } catch {}
      reject(new Error(`ttyd WS handshake timed out after ${connectTimeoutMs}ms (${opts.url})`));
    }, connectTimeoutMs);

    const sendBinary = (bytes: Uint8Array) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const payload = new Uint8Array(bytes);
      ws.send(payload.buffer);
    };

    ws.onopen = () => {
      clearTimeout(connectTimer);
      ws.send(JSON.stringify({ AuthToken: "", columns: opts.cols, rows: opts.rows }));

      (async () => {
        for await (const chunk of opts.stdin) {
          const framed = new Uint8Array(chunk.length + 1);
          framed[0] = 0x30; // '0' INPUT
          framed.set(chunk, 1);
          sendBinary(framed);
        }
      })().catch(() => {});

      (async () => {
        const enc = new TextEncoder();
        for await (const [rows, cols] of opts.resize) {
          const payload = enc.encode(JSON.stringify({ columns: cols, rows }));
          const framed = new Uint8Array(payload.length + 1);
          framed[0] = 0x31; // '1' RESIZE
          framed.set(payload, 1);
          sendBinary(framed);
        }
      })().catch(() => {});
    };

    ws.onmessage = (evt) => {
      if (!(evt.data instanceof ArrayBuffer)) return;
      const arr = new Uint8Array(evt.data);
      if (arr.length === 0) return;
      if (arr[0] === 0x30) {
        // OUTPUT
        opts.stdout(Buffer.from(arr.buffer, arr.byteOffset + 1, arr.byteLength - 1));
      }
      // '1' title, '2' preferences: ignored.
    };

    ws.onclose = (evt) => {
      clearTimeout(connectTimer);
      if (resolved) return;
      resolved = true;
      resolve(evt.code === 1000 ? 0 : 1);
    };

    ws.onerror = () => {
      clearTimeout(connectTimer);
      if (resolved) return;
      resolved = true;
      reject(new Error("ttyd WS proxy failed"));
    };
  });
}
