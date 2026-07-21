import { randomUUID } from "crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { AUTH_MOUNT, seedVmAuth } from "./auth-sync";
import type { PortProbe } from "./contracts";
import type { Db } from "./db";
import { schema } from "./db";
import type { GitConfigManager } from "./git-config";
import type { SigningConfig } from "./git-config-store";
import { CLIENT_ID_ENV, MOUNT_MAP_ENV } from "./mount-map";
import {
  buildControlCli,
  buildInstallCliCommand,
  CTL_BROKER_PATH,
  CTL_SOCK,
  handlePortCommand,
  type PortControlOps,
} from "./port-control";
import { ExecRelayForwarder, type GuestForwarder } from "./port-forwarder";
import type { PrAttachmentManager } from "./pr-attachments";
import { handlePrCommand, type PrControlOps } from "./pr-control";
import { ensureCacheDirs, loadProfileConfig, type ResolvedProfileConfig } from "./profile-config";
import type { ProfileManager } from "./profiles";
import { runRequestBroker } from "./request-broker";
import { GUEST_SANDBOX_PORT, SandboxReverseForwarder } from "./sandbox-forward";
import type { SecretsStore } from "./secrets-store";
import { removeSeedStaging, SEED_MOUNT, type SeedProfileEntry, stageSeed } from "./seed";
import { shellQuote } from "./shell";
import { runSignerStream, SIGN_SOCK } from "./sign-broker";
import { buildSignShimScript } from "./sign-shim";
import { removeUploadsForInstance } from "./uploads";

type CommitterIdentity = { name: string; email: string };

import { WORKSPACE_ROOT } from "./contracts";
import {
  type ExecResult,
  HOST_CLIENT_ID,
  type PortForwardBinding,
  type SandboxApi,
  type SandboxSecretBinding,
  type SandboxVolumeBinding,
} from "./sandbox-client";

// Guest path of the commit-signing shim git is pointed at via gpg.ssh.program.
// Like the auth-sync watcher, it's (re)written on every create/restart/attach.
const SIGN_SHIM_PATH = "/tmp/isolade-sign-shim.cjs";

// Per-command ceiling for profile initializers, so a hung command can't
// wedge an instance in `initializing` forever. Generous: the common sync step
// is a dependency install, which can legitimately run for minutes.
const INIT_COMMAND_TIMEOUT_MS = 10 * 60_000;

// Guest path the initializer transcript is appended to, so a failed setup is
// inspectable via a terminal / VS Code without re-running anything.
const INIT_LOG_PATH = "/tmp/isolade-init.log";

// One desired host→guest forward. `hostPort` pins the host loopback port
// (runtime forwards only — config-declared ports always get an ephemeral one);
// undefined lets the kernel pick.
interface ForwardSpec {
  remotePort: number;
  hostPort?: number;
}

export class InstanceManager {
  // Live host→guest forward bindings, keyed by instance id. The forwarder below
  // owns the host listeners. This cache mirrors its state so decorate()/list
  // stay synchronous. Kept in sync on every open/close (reopenForwards).
  private portForwards = new Map<string, PortForwardBinding[]>();
  // Opens/closes the dynamic, loopback-dialing forwards (see port-forwarder.ts).
  // Injectable so tests can swap a stub. Defaults to the exec-stream relay.
  private forwarder: GuestForwarder;
  // Exposes the host sandbox API inside `expose_sandbox` VMs (isolade within
  // isolade, see sandbox-forward.ts). Null when the host has no in-process
  // sandbox to serve (external-sandbox mode / tests). Then the opt-in is a no-op.
  private sandboxForwarder: SandboxReverseForwarder | null;
  // Persistent commit-signing broker streams, keyed by vmId. The AbortController
  // tears the stream (and its auto-reconnect loop) down on disable / remove.
  private signerStreams = new Map<string, AbortController>();
  // Persistent port-control broker streams (the in-VM `isolade` CLI's transport),
  // keyed by vmId. Started for every running VM, torn down on remove.
  private portControlStreams = new Map<string, AbortController>();
  // In-flight sync-initializer runs, keyed by instance id. A chat turn awaits
  // this (awaitInit) before the agent runs. The promise resolves whether init
  // succeeded or failed (failure is reflected in the instance's status/lastError),
  // so awaiting never throws. Replaced on restart, dropped on remove.
  private initRuns = new Map<string, Promise<void>>();
  // Monotonic per-instance generation, bumped every time a lifecycle run starts
  // (beginInit). A run only writes status/setupDone while it's still the current
  // generation, so a restart mid-init can't have its stale predecessor clobber
  // the fresh run's state.
  private initGen = new Map<string, number>();

  // Source of the live "which instances are streaming right now" set. Wired to
  // the chat stream hub after construction (the hub is built later, and depends
  // on nothing here, so a setter avoids a constructor cycle). Defaults to empty
  // so an un-wired manager (e.g. in unit tests) reports nothing as working.
  private getActiveInstanceIds: () => Set<string> = () => new Set();

  constructor(
    private db: Db,
    private sandboxClient: SandboxApi,
    // The profile owns the build image + config AND the auth / git / network /
    // secrets a VM runs with. A VM's identity is resolved from its OWN profile
    // (at create, and re-resolved from the instance's profileId on
    // restart/attach), so switching the active profile never disturbs it.
    private profiles: ProfileManager,
    private secrets: SecretsStore,
    // Chat-attached PR store + `gh` probe, backing the in-VM `isolade pr` CLI
    // and the title-bar badge. Read by decorate() so every listing carries its
    // instance's PRs.
    private prs: PrAttachmentManager,
    opts: {
      // Test seam: swap the loopback port forwarder.
      forwarder?: GuestForwarder;
      // Host unix socket serving the in-process sandbox API. Enables
      // `expose_sandbox`. Absent in external-sandbox mode / tests.
      sandboxSocketPath?: string;
      // Test seam: swap the reverse sandbox forwarder.
      sandboxForwarder?: SandboxReverseForwarder;
    } = {},
  ) {
    this.forwarder = opts.forwarder ?? new ExecRelayForwarder(sandboxClient);
    this.sandboxForwarder =
      opts.sandboxForwarder ??
      (opts.sandboxSocketPath
        ? new SandboxReverseForwarder(sandboxClient, opts.sandboxSocketPath)
        : null);
  }

  // The per-profile git manager for an instance, or null when the instance has
  // no profile (legacy/orphan rows). Null means host-derived identity, unsigned.
  private gitFor(profileId: string | null): GitConfigManager | null {
    return profileId ? this.profiles.git(profileId) : null;
  }

  // Wire the live activity source (the chat stream hub). Called once at startup.
  setActivitySource(getActiveInstanceIds: () => Set<string>) {
    this.getActiveInstanceIds = getActiveInstanceIds;
  }

  private decorate<T extends { id: string }>(
    instance: T,
    // The active set is passed in by list() so it's built once per listing,
    // single-instance callers (get/create) fall back to building it here.
    active: Set<string> = this.getActiveInstanceIds(),
    // Likewise the PR map: list() builds it once, single-instance callers fetch
    // just their instance's PRs.
    prsByInstance?: Map<string, ReturnType<PrAttachmentManager["listFor"]>>,
  ) {
    return {
      ...instance,
      working: active.has(instance.id),
      ports: this.portForwards.get(instance.id) ?? [],
      prs: prsByInstance ? (prsByInstance.get(instance.id) ?? []) : this.prs.listFor(instance.id),
    };
  }

  async create(opts: { title?: string | null; profileId: string }) {
    const t0 = performance.now();
    const id = randomUUID();
    const profileId = opts.profileId;
    const profile = this.profiles.get(profileId);
    if (!profile) throw new Error(`profile ${profileId} not found`);
    // Allow instance creation as soon as ANY image has been built, even
    // when a rebuild is in flight ("building") or the latest rebuild
    // errored. The previous image stays in `image` until a new build
    // succeeds, so spawning while building uses the last-known-good ref.
    if (!profile.image) throw new Error(`profile ${profileId} has no built image yet`);
    // Spawning runs the already-built image. The repo sources don't need to be
    // present on the host (they're baked into the image at build time). So we
    // read the config (ports / caches / secrets / signing) WITHOUT requiring
    // prepared git checkouts. Only a rebuild needs those.
    const config = loadProfileConfig(profileId);
    const image = profile.image;
    const envPorts = config.ports;
    const envCaches = config.caches;
    // Idempotent and cheap. Covers the case where the user added a cache
    // path to an already-built profile and we never re-ran build prep.
    await ensureCacheDirs(envCaches);
    const tProfileLooked = performance.now();

    const volumes: SandboxVolumeBinding[] = envCaches.map((c) => ({
      guestPath: c.guestPath,
      hostPath: c.hostPath,
    }));

    // Bind-mount the owning profile's credential store so the in-VM auth-sync
    // watcher can read it and propagate refreshes. Ensured even when empty (no
    // login yet) so the mount target exists. An empty mount just means the
    // agent runs unauthenticated until you sign into this profile via
    // Settings → Providers. Each profile is a distinct identity with its own
    // credential dir. A profile's VMs only ever see that profile's tokens.
    const profileAuth = this.profiles.auth(profileId);
    profileAuth.ensureDir();
    volumes.push({ guestPath: AUTH_MOUNT, hostPath: profileAuth.dir() });

    // Resolve each declared secret against the owning profile's credential
    // store. Declarations without a stored value are silently skipped. They're
    // never registered with microsandbox, so the guest sees no env var for them.
    const secrets: SandboxSecretBinding[] = [];
    for (const decl of config.secrets) {
      const value = await this.secrets.get(profileId, decl.env);
      if (value)
        secrets.push({
          env: decl.env,
          value,
          hosts: decl.hosts,
          inject: decl.inject,
        });
    }

    // Git config applied to this VM. Identity (committer name/email) applies to
    // every commit, signed or not. Signing applies only when the profile's
    // [git] signing config is enabled with a usable key (agent reachable).
    // Signing needs no network/port: it rides a persistent exec stream to an
    // in-VM broker (see setupGitConfig / ensureSignerBroker), so the network
    // policy is untouched.
    const profileGit = this.profiles.git(profileId);
    const identity = profileGit.effectiveIdentity();
    const signingConfig = profileGit.resolveActiveSigning();

    // The profile's network posture (internet allowlist + local/host access).
    // The profile's host_ports layer on top inside buildNetworkPolicy.
    const network = this.profiles.network(profileId).read();

    // DEV-ONLY sandbox exposure (isolade within isolade): point the guest's
    // isolade server at the host sandbox served over the reverse exec-stream
    // forward. Injected here so it's in the guest env before that server boots.
    // Gated on an actual host socket. A profile that opts in on an
    // external-sandbox host gets a warning and no injection (nothing to reach).
    // The resolved value is persisted on the instance row: the env var lives in
    // the persisted VM record from here on, so restart/attach must re-establish
    // (or not) the forward from what this VM was created with, not from the
    // profile's current config.
    const exposeSandbox = config.exposeSandbox && this.sandboxForwarder !== null;
    if (config.exposeSandbox && !this.sandboxForwarder) {
      console.warn(
        `[instance-create ${id}] profile ${profileId} sets expose_sandbox but this ` +
          `isolade has no in-process sandbox to serve; ignoring.`,
      );
    }

    // Seed profiles into the nested isolade (config dirs + built image refs;
    // see seed.ts). Meaningless without the exposed sandbox — the refs point
    // into ITS cache — so it's warn-and-ignore otherwise. Per-profile
    // validation is warn-and-skip: a seed problem should degrade the nested
    // experience, not block the dev VM.
    let seeded: SeedProfileEntry[] = [];
    if (exposeSandbox) {
      seeded = this.resolveSeedEntries(id, config.seedProfiles);
    } else if (config.seedProfiles.length > 0) {
      console.warn(
        `[instance-create ${id}] profile ${profileId} sets seed_profiles without an ` +
          `exposed sandbox; ignoring.`,
      );
    }
    if (seeded.length > 0) {
      // Register the seeded refs as this dev VM's retention keep-set BEFORE
      // the (multi-second) VM boot, so a host rebuild + GC of a seeded profile
      // in that window can't collect them (see clients.ts). Unprotected refs
      // would defeat the seed, so a failed registration aborts the create
      // rather than booting a VM whose images may vanish mid-boot. A failed
      // create below unwinds this registration.
      try {
        seeded = await this.registerSeedKeepSet(id, config.seedProfiles, seeded);
      } catch (err) {
        // Drop whatever registration landed (best-effort — the boot-time
        // orphan-client sweep retries it if this fails too).
        this.sandboxClient.removeClient(id).catch(() => {});
        throw new Error(`seeding failed: ${err instanceof Error ? err.message : String(err)}`, {
          cause: err,
        });
      }
      // Staged only after the registered keep-set and the profiles table
      // agree, so the manifest's refs are exactly the protected ones.
      volumes.push({ guestPath: SEED_MOUNT, hostPath: stageSeed(id, seeded) });
    }

    // Nested-mode env, all frozen into the persisted VM record at create:
    //   ISOLADE_SANDBOX_URL  where the nested server reaches the host sandbox.
    //   ISOLADE_CLIENT_ID    its sandbox client identity — this instance's id,
    //                        the one identifier that exists both now and at
    //                        remove() time (the msb vmId doesn't exist yet).
    //   ISOLADE_MOUNT_MAP    this VM's own volumes, verbatim, so the nested
    //                        server can translate its guest-local volume paths
    //                        to their host backing dirs (see mount-map.ts).
    const env =
      exposeSandbox && this.sandboxForwarder
        ? {
            ISOLADE_SANDBOX_URL: `http://127.0.0.1:${this.sandboxForwarder.guestPort}`,
            [CLIENT_ID_ENV]: id,
            [MOUNT_MAP_ENV]: JSON.stringify(
              volumes.map((v) => ({ guestPath: v.guestPath, hostPath: v.hostPath })),
            ),
          }
        : undefined;

    // User port forwards no longer ride microsandbox's publisher (which dials
    // the guest's external interface, missing loopback-bound servers, and is
    // fixed at create time). They're opened dynamically below via the
    // loopback-dialing forwarder instead, so `ports` is left empty here.
    const { vmId } = await this.sandboxClient
      .createVm({
        image,
        env,
        hostPorts: config.hostPorts,
        volumes,
        secrets,
        network,
      })
      .catch((e: unknown) => {
        // Unwind the seeding side effects: nothing will ever boot against
        // this staging dir, and the keep-set entry would otherwise retain
        // its refs forever (strict retention, no TTL).
        if (seeded.length > 0) {
          this.sandboxClient.removeClient(id).catch(() => {});
          removeSeedStaging(id);
        }
        throw new Error(`VM creation failed: ${e instanceof Error ? e.message : String(e)}`);
      });
    const tVmCreated = performance.now();

    this.db
      .insert(schema.instances)
      .values({
        id,
        vmId,
        title: opts.title ?? null,
        image,
        profileId,
        exposeSandbox,
        seedProfiles: seeded.length > 0 ? seeded.map((s) => s.id) : null,
      })
      .run();

    // Establish every per-VM attachment (credential/git state, the standing
    // control channels, and the host forward listeners) through the single
    // reconciliation point that restart and re-attach also run. A brand-new
    // instance has no persisted runtime forwards yet, so the desired set is
    // exactly envPorts. Identity/signing come from the config just loaded.
    await this.establishAttachments({
      id,
      vmId,
      identity,
      git: profileGit,
      signing: signingConfig,
      exposeSandbox,
      forwards: envPorts.map((remotePort) => ({ remotePort })),
    });

    // Kick off the profile's lifecycle commands in the booted VM. runSetup
    // is true for a brand-new instance. Sync steps flip the freshly-inserted row
    // to `initializing` synchronously here (so the instance we return reflects
    // it) and to running/error when they finish.
    this.beginInit(id, vmId, config.init, true);

    const instance = this.get(id);
    if (!instance) {
      throw new Error(`instance ${id} was not persisted`);
    }
    const tDone = performance.now();

    const fmt = (ms: number) => `${ms.toFixed(0)}ms`;
    console.log(
      `[instance-create id=${id} profileId=${profileId}] ` +
        `profileLookup=${fmt(tProfileLooked - t0)} ` +
        `createVm=${fmt(tVmCreated - tProfileLooked)} ` +
        `dbInsert=${fmt(tDone - tVmCreated)} ` +
        `total=${fmt(tDone - t0)}`,
    );

    return this.decorate(instance);
  }

  // Validate a dev profile's seed_profiles grant into stageable entries.
  // Warn-and-skip per profile: each needs a built image (the ref the nested
  // instance boots from) and a config whose repos are all git sources — local
  // sources resolve against host paths that don't exist inside the guest, so
  // the seeded profile could never rebuild (loadProfileConfig would throw at
  // nested instance create).
  private resolveSeedEntries(instanceId: string, seedIds: readonly string[]): SeedProfileEntry[] {
    const out: SeedProfileEntry[] = [];
    for (const seedId of seedIds) {
      const profile = this.profiles.get(seedId);
      if (!profile) {
        console.warn(`[instance-create ${instanceId}] seed profile ${seedId} not found; skipping`);
        continue;
      }
      if (!profile.image) {
        console.warn(
          `[instance-create ${instanceId}] seed profile ${seedId} has no built image; skipping`,
        );
        continue;
      }
      try {
        const config = loadProfileConfig(seedId);
        const local = config.repos.filter((r) => r.source.kind === "local");
        if (local.length > 0) {
          console.warn(
            `[instance-create ${instanceId}] seed profile ${seedId} uses local repo ` +
              `source(s) (${local.map((r) => r.name).join(", ")}), which cannot resolve ` +
              `inside a guest; skipping`,
          );
          continue;
        }
      } catch (err) {
        console.warn(
          `[instance-create ${instanceId}] seed profile ${seedId} has an unloadable config; ` +
            `skipping:`,
          err,
        );
        continue;
      }
      out.push({ id: seedId, name: profile.name, image: profile.image });
    }
    return out;
  }

  // Pre-protect the seed's image refs: register them as the dev VM's retention
  // keep-set, then re-resolve the entries until the two agree. The
  // registration is serialized behind any in-flight sweep (see
  // BuilderManager.runKeepSetRegistration), so a ref the profiles table still
  // memoizes once it returns is provably alive: every sweep that finished
  // before it had that ref inside its union (via the host's own keep-set). The
  // loop covers the other case — a rebuild that landed while we waited moved
  // the memoized ref on, and the sweep we waited out may have collected the
  // one we registered — by promoting the fresh entries and registering again.
  // A source that won't hold still after a few rounds (rebuilds landing
  // back-to-back) surfaces as a create failure rather than a seed whose images
  // may be gone.
  private async registerSeedKeepSet(
    instanceId: string,
    seedIds: readonly string[],
    seeded: SeedProfileEntry[],
  ): Promise<SeedProfileEntry[]> {
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.sandboxClient.registerKeepSet(instanceId, [
        ...new Set(seeded.map((s) => s.image)),
      ]);
      const recheck = this.resolveSeedEntries(instanceId, seedIds);
      const stable =
        recheck.length === seeded.length &&
        recheck.every((e, i) => e.id === seeded[i]!.id && e.image === seeded[i]!.image);
      if (stable) return seeded;
      seeded = recheck;
    }
    throw new Error("seed profiles kept changing during create (rebuilds in flight?); try again");
  }

  // Recency order, newest-active first: the order the sidebar renders in.
  // The tiebreakers make it a *total* order so it never flickers: updatedAt
  // has only second precision (stored via unixepoch()), so several instances
  // bumped in the same wall-clock second share a timestamp. Without a
  // deterministic tiebreak their relative order would depend on SQLite's row
  // order and shuffle between polls. createdAt (newest-created first) is the
  // recency-correlated tiebreak. The random-UUID id is the guaranteed-unique
  // final key. The client renders this order verbatim. It's the single
  // source of truth, so this comparator lives only here.
  list() {
    const active = this.getActiveInstanceIds();
    const prsByInstance = this.prs.listByInstance();
    return this.db
      .select()
      .from(schema.instances)
      .orderBy(
        desc(schema.instances.updatedAt),
        desc(schema.instances.createdAt),
        asc(schema.instances.id),
      )
      .all()
      .map((instance) => this.decorate(instance, active, prsByInstance));
  }

  get(id: string) {
    const row = this.db.select().from(schema.instances).where(eq(schema.instances.id, id)).get();
    return row ? this.decorate(row) : row;
  }

  setTitle(id: string, title: string) {
    this.db
      .update(schema.instances)
      .set({ title, updatedAt: new Date() })
      .where(eq(schema.instances.id, id))
      .run();
    return this.get(id);
  }

  // Pin/unpin a chat: toggle the flag that lifts it into the sidebar's "Pinned"
  // section. Purely presentational, so unlike archive there is no VM lifecycle
  // here, just a flag flip. The updatedAt bump orders the pinned section by
  // most-recently-pinned, mirroring how archive orders the archive.
  setPinned(id: string, pinned: boolean) {
    this.db
      .update(schema.instances)
      .set({ pinned, updatedAt: new Date() })
      .where(eq(schema.instances.id, id))
      .run();
    return this.get(id);
  }

  touch(id: string) {
    this.db
      .update(schema.instances)
      .set({ updatedAt: new Date() })
      .where(eq(schema.instances.id, id))
      .run();
  }

  // An assistant turn finished: flag the instance unread and bump updatedAt so
  // it floats to the top of the (recency-sorted) sidebar. The client clears the
  // flag via markRead the moment the user is looking at this instance, so a
  // turn that completes while you're viewing it never lingers as unread.
  markActivity(id: string) {
    this.db
      .update(schema.instances)
      .set({ unread: true, updatedAt: new Date() })
      .where(eq(schema.instances.id, id))
      .run();
  }

  // The user opened/viewed the instance, so clear the unread flag. Does not bump
  // updatedAt: reading shouldn't reorder the sidebar.
  markRead(id: string) {
    this.db
      .update(schema.instances)
      .set({ unread: false })
      .where(eq(schema.instances.id, id))
      .run();
  }

  async remove(id: string) {
    const instance = this.get(id);
    // Tear down every per-VM attachment (control channels + host listeners).
    if (instance) this.teardownAttachments(id, instance.vmId);
    else this.portForwards.delete(id);
    this.db.delete(schema.portForwards).where(eq(schema.portForwards.instanceId, id)).run();
    this.prs.removeForInstance(id);
    const uploadIds = this.db
      .select({ id: schema.uploads.id })
      .from(schema.uploads)
      .where(eq(schema.uploads.instanceId, id));
    this.db
      .delete(schema.messageUploads)
      .where(inArray(schema.messageUploads.uploadId, uploadIds))
      .run();
    this.db.delete(schema.uploads).where(eq(schema.uploads.instanceId, id)).run();
    this.initRuns.delete(id);
    // Drop the generation: an in-flight run reads `undefined` here, which never
    // equals its captured generation, so it sees itself superseded and stops
    // writing to the (now-deleted) row, and the map doesn't retain dead ids.
    this.initGen.delete(id);
    this.db.delete(schema.instances).where(eq(schema.instances.id, id)).run();
    if (instance) {
      // Fire-and-forget so the HTTP handler returns promptly, but log
      // failures: a swallowed error here is exactly how we end up with
      // orphan microsandbox processes outliving their instances.
      const destroyed = this.sandboxClient.destroyVm(instance.vmId).catch((err) => {
        console.warn(`[instance-remove ${id} vmId=${instance.vmId}] destroyVm failed:`, err);
      });
      // Drop the host-side uploads dir after the VM's destroy settles: it backs
      // a live bind mount until then, and deleting it under a running VM can
      // wedge teardown (same ordering constraint as the seed staging dir).
      void destroyed.then(() => removeUploadsForInstance(id));
      // An expose_sandbox VM was a sandbox CLIENT (its nested isolade created
      // VMs and registered an image keep-set under this instance's id).
      // Cascade its removal: destroy its leftover VMs, drop its keep-set, and
      // sweep — then drop the seed staging dir. Sequenced AFTER the VM's own
      // destroy settles: the staging dir backs a live bind mount until then,
      // and deleting it under a running VM can wedge the teardown. remove()
      // only, deliberately: archive() keeps all of it (strict retention — an
      // archived dev VM must unarchive intact).
      if (instance.exposeSandbox) {
        void destroyed.then(async () => {
          await this.sandboxClient.removeClient(id).catch((err) => {
            console.warn(`[instance-remove ${id}] nested-client cascade failed:`, err);
          });
          removeSeedStaging(id);
        });
      }
    }
  }

  // Archived instances' raw rows, used by the "clear archive" bulk delete (it
  // only needs each id/vmId to tear it down, with no live decoration). Always
  // scoped to one profile: clearing is irreversible, so there is deliberately
  // no "every profile" variant to reach by accident.
  listArchived(profileId: string) {
    return this.db
      .select()
      .from(schema.instances)
      .where(and(eq(schema.instances.archived, true), eq(schema.instances.profileId, profileId)))
      .all();
  }

  // Archive an instance: stop its VM (keeping the persisted microsandbox
  // record so unarchive can resume it) and hide it from the main sidebar list.
  // The signer broker + in-memory port maps are torn down here. The app-level
  // route drops the terminal / chat / codex / claude sessions bound to this VM
  // before calling us. Await-completes only once the VM is actually stopped, so
  // the returned row's `status: "stopped"` is truthful. The `updatedAt` bump
  // orders the archive by most-recently-archived.
  async archive(id: string) {
    const instance = this.get(id);
    if (!instance) throw new Error(`instance ${id} not found`);
    // Tear down every per-VM attachment. The control channels' reconnect loops
    // must stop (they'd otherwise retry against the stopped VM for the rest of
    // the server's life), and the host listeners close (their guest
    // counterparts die with the VM). The persisted forward ROWS are kept:
    // unarchive's restart() reopens the same set via desiredRemotePorts().
    this.teardownAttachments(id, instance.vmId);
    // Supersede any in-flight lifecycle run so it stops writing status to the
    // row we're about to mark stopped. Bump (don't delete) the generation:
    // unlike remove(), the row survives, and a fresh numbering could collide
    // with a still-captured generation from before the archive.
    this.initGen.set(id, (this.initGen.get(id) ?? 0) + 1);
    this.initRuns.delete(id);
    try {
      await this.sandboxClient.stopVm(instance.vmId);
    } catch (err) {
      // A stop failure shouldn't strand the chat un-archived: the VM is at
      // worst still running (reaped on next full shutdown), and the row is
      // marked archived so the UI reflects the user's intent. Log and proceed.
      console.warn(`[instance-archive ${id} vmId=${instance.vmId}] stopVm failed:`, err);
    }
    this.db
      .update(schema.instances)
      .set({
        archived: true,
        // A chat is pinned XOR archived: archiving drops it out of the "Pinned"
        // section rather than leaving it pinned-but-hidden under the archive.
        pinned: false,
        status: "stopped",
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.instances.id, id))
      .run();
    return this.get(id);
  }

  // Unarchive an instance and boot its VM back up. Clears the flag first so the
  // row immediately rejoins the main list (rendered as "restarting"); restart()
  // then resumes the stopped VM from its persisted record and flips it to
  // running (or to error + lastError if the resume fails, same as any restart).
  async unarchive(id: string) {
    const instance = this.get(id);
    if (!instance) throw new Error(`instance ${id} not found`);
    this.db
      .update(schema.instances)
      .set({ archived: false })
      .where(eq(schema.instances.id, id))
      .run();
    return this.restart(id);
  }

  // Stop the underlying VM (if running) and start it again from its
  // persisted microsandbox record. Same code path runs at server boot
  // (auto-restart everything we know about) and from the user-facing
  // "Restart VM" action. There's no separate "first attach" path.
  async restart(id: string) {
    const instance = this.get(id);
    if (!instance) throw new Error(`instance ${id} not found`);

    this.db
      .update(schema.instances)
      .set({ status: "restarting", updatedAt: new Date() })
      .where(eq(schema.instances.id, id))
      .run();

    try {
      await this.sandboxClient.restartVm(instance.vmId);
      // A fresh boot dropped the guest's relay/watcher/broker processes and the
      // host listeners. Re-establish every per-VM attachment. Params come from
      // the instance's OWN profile (not the active one), so switching profiles
      // never disturbs a running VM.
      await this.establishAttachments(this.establishParamsForInstance(instance));
      this.db
        .update(schema.instances)
        .set({ status: "running", lastError: null, updatedAt: new Date() })
        .where(eq(schema.instances.id, id))
        .run();
      // A fresh boot lost the guest's processes (the disk persists), so re-run
      // the `[start]` phase. Re-run `[setup]` only if it never completed,
      // a retry path for a failed/interrupted first provision.
      this.beginInit(
        id,
        instance.vmId,
        this.readInitForProfile(instance.profileId),
        !instance.setupDone,
      );
      return this.get(id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.db
        .update(schema.instances)
        .set({ status: "error", lastError: message, updatedAt: new Date() })
        .where(eq(schema.instances.id, id))
        .run();
      throw err;
    }
  }

  // Re-attach the in-memory port-forward maps to every persisted VM at
  // server boot. Goes through `ensureVm`, which:
  //   - If the sandbox-service's in-memory vmManager.vms still has the VM
  //     (only the isolade server reloaded, not the sandbox-service), it
  //     just re-reads the existing port bindings, with no stop/start cycle.
  //     This is the common dev case where `bun --watch` reloads the server.
  //   - Otherwise (sandbox-service also reloaded → its vmManager.vms is
  //     empty), it calls Sandbox.start to resume the VM from its persisted
  //     microsandbox record.
  // Failures (host port collision, VM record corruption, mount path
  // missing) land in `status=error` + `lastError`. The user can retry via
  // the context menu's Restart action.
  //
  // Untitled instances are reaped instead of resumed: they're abandoned
  // drafts (NewInstancePane creates a real VM the moment the user submits
  // a first message. If the page closes before the auto-title flow lands
  // AND before beaconDeleteInstance fires, the instance survives but is
  // hidden by the sidebar's title-required filter). Auto-resuming them
  // booted up to a dozen invisible msb processes every isolade start.
  async resyncAll(): Promise<void> {
    const all = this.list();
    // Archived instances are neither resumed nor reaped. Archived means the
    // VM stays stopped (no CPU/RAM) until the user unarchives. Enforce that
    // instead of assuming it: stopVm is a cheap no-op for an already-stopped
    // VM, and it reaps one that survived a failed archive-time stop or was
    // resurrected by a crash, which the archived-skip would otherwise leave
    // running forever.
    const archived = all.filter((i) => i.archived);
    const live = all.filter((i) => !i.archived);
    const restartable = live.filter((i) => i.title !== null && i.title.trim() !== "");
    const abandoned = live.filter((i) => i.title === null || i.title.trim() === "");
    if (abandoned.length > 0) {
      console.log(
        `[instance-resync] reaping ${abandoned.length} untitled instance(s) ` +
          `(${abandoned.map((i) => i.id).join(", ")})`,
      );
    }
    await Promise.all([
      ...archived.map(async (instance) => {
        try {
          await this.sandboxClient.stopVm(instance.vmId);
        } catch (err) {
          console.warn(
            `[instance-resync ${instance.id} vmId=${instance.vmId}] archived-stop failed:`,
            err,
          );
        }
      }),
      ...abandoned.map(async (instance) => {
        try {
          await this.remove(instance.id);
        } catch (err) {
          console.warn(`[instance-resync ${instance.id} vmId=${instance.vmId}] reap failed:`, err);
        }
      }),
      ...restartable.map(async (instance) => {
        try {
          await this.ensureAttached(instance.id);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(
            `[instance-resync ${instance.id} vmId=${instance.vmId}] ensure failed:`,
            err,
          );
          this.db
            .update(schema.instances)
            .set({ status: "error", lastError: message, updatedAt: new Date() })
            .where(eq(schema.instances.id, instance.id))
            .run();
        }
      }),
    ]);
  }

  // Boot-time reconciliation of the sandbox client registry against the
  // instances table: any registered client whose instance row no longer exists
  // was left behind by a crash or a failed removal cascade (remove()'s cascade
  // is fire-and-forget and has no other retry). Host-with-in-process-sandbox
  // only — the caller gates on that, since a server sharing an external
  // sandbox can't know which clients belong to other servers' tables.
  async sweepOrphanClients(): Promise<void> {
    const clients = await this.sandboxClient.listClients();
    const live = new Set(this.list().map((i) => i.id));
    for (const clientId of clients) {
      if (clientId === HOST_CLIENT_ID || live.has(clientId)) continue;
      console.log(`[instance-resync] removing orphaned sandbox client ${clientId}`);
      await this.sandboxClient.removeClient(clientId).catch((err) => {
        console.warn(`[instance-resync] orphan client ${clientId} removal failed:`, err);
      });
      removeSeedStaging(clientId);
    }
  }

  // Refresh in-memory port bindings for an instance whose VM is still
  // alive. Does NOT toggle status or bump lastError on the happy path.
  // when the sandbox-service held its VMs through a server reload, the
  // user should see no change in instance state. Failures bubble. The
  // caller (resyncAll) translates them to status=error.
  private async ensureAttached(id: string): Promise<void> {
    const instance = this.get(id);
    if (!instance) throw new Error(`instance ${id} not found`);
    await this.sandboxClient.ensureVm(instance.vmId);
    // Re-establish every per-VM attachment. If the VM was resumed via a fresh
    // boot, its guest relay/watcher/broker processes are gone and this rewrites
    // them. If it was merely re-read (server-only reload), the guest side is
    // still live and this harmlessly re-establishes the host listeners.
    await this.establishAttachments(this.establishParamsForInstance(instance));
    // If the instance was previously in error status (e.g. last boot's
    // restart failed and the user fixed whatever was wrong), clear it
    // here on a successful re-attach.
    if (instance.status !== "running") {
      this.db
        .update(schema.instances)
        .set({ status: "running", lastError: null, updatedAt: new Date() })
        .where(eq(schema.instances.id, id))
        .run();
    }
  }

  listPortForwards(id: string) {
    return this.portForwards.get(id) || [];
  }

  // Open a new runtime forward (from the UI or the in-VM agent helper): persist
  // it so it survives restart, then open the host listener. Idempotent, so a
  // repeat call returns the existing binding. `hostPort` pins the host loopback
  // port (see GuestForwarder.open); a pinned open that collides throws before
  // anything is opened, but the persisted row keeps the pin for the next
  // restart's reopen attempt.
  //
  // `persist: false` skips the row entirely: the forward lives until it is
  // unforwarded or the VM/server restarts, and is never reopened. That is the
  // right lifetime for pins requested by an automated flow whose own state is
  // in-memory (the nested login callback, see auth-login.ts) — a persisted pin
  // whose requester died mid-flow would squat the pinned host port across
  // every later restart with nothing behind it.
  async addForward(
    id: string,
    remotePort: number,
    hostPort?: number,
    opts: { persist?: boolean } = {},
  ): Promise<PortForwardBinding> {
    const instance = this.get(id);
    if (!instance) throw new Error(`instance ${id} not found`);
    if (opts.persist !== false) {
      // A pinned request records its pin; an unpinned repeat leaves any existing
      // row (and its pin) untouched, preserving the old "repeat addForward never
      // mutates the persisted row" invariant. Un-pinning is removeForward + re-add.
      const insert = this.db
        .insert(schema.portForwards)
        .values({ instanceId: id, remotePort, hostPort: hostPort ?? null });
      if (hostPort === undefined) {
        insert.onConflictDoNothing().run();
      } else {
        insert
          .onConflictDoUpdate({
            target: [schema.portForwards.instanceId, schema.portForwards.remotePort],
            set: { hostPort },
          })
          .run();
      }
    }
    const binding = await this.forwarder.open(instance.vmId, remotePort, hostPort);
    this.portForwards.set(id, this.forwarder.list(instance.vmId));
    return binding;
  }

  // Tear down a forward and stop reopening it on restart. Config-declared ports
  // aren't persisted, so removing one only closes it until the next restart
  // (the config re-declares it), but runtime forwards are removed for good.
  removeForward(id: string, remotePort: number): void {
    const instance = this.get(id);
    this.db
      .delete(schema.portForwards)
      .where(
        and(eq(schema.portForwards.instanceId, id), eq(schema.portForwards.remotePort, remotePort)),
      )
      .run();
    if (instance) {
      this.forwarder.close(instance.vmId, remotePort);
      this.portForwards.set(id, this.forwarder.list(instance.vmId));
    }
  }

  // The forwards an instance should have open: its profile's config-declared
  // ports plus any runtime forwards persisted for it. Deduped by guest port,
  // with a persisted runtime row's host-port pin winning over the (pin-less)
  // config declaration for the same port.
  private desiredForwards(id: string, profileId: string | null): ForwardSpec[] {
    const byRemote = new Map<number, ForwardSpec>();
    for (const remotePort of this.readPortsForProfile(profileId)) {
      byRemote.set(remotePort, { remotePort });
    }
    for (const row of this.persistedForwards(id)) {
      byRemote.set(row.remotePort, {
        remotePort: row.remotePort,
        hostPort: row.hostPort ?? undefined,
      });
    }
    return [...byRemote.values()];
  }

  // Config-declared ports for a profile, best-effort (a missing/invalid config
  // yields none rather than blocking a restart, mirroring readInitForProfile).
  private readPortsForProfile(profileId: string | null): number[] {
    if (!profileId) return [];
    try {
      return loadProfileConfig(profileId).ports;
    } catch {
      return [];
    }
  }

  private persistedForwards(id: string) {
    return this.db
      .select()
      .from(schema.portForwards)
      .where(eq(schema.portForwards.instanceId, id))
      .all();
  }

  // Re-establish the host listeners for a (re)booted VM: drop any stale ones
  // this manager holds for the VM (and reset the forwarder's per-VM relay-script
  // state), then open each desired port fresh. Best-effort per port: a failed
  // open is logged, not fatal, so one bad port can't wedge a restart. Unpinned
  // local ports are ephemeral, so they may change across a restart.
  private async reopenForwards(id: string, vmId: string, forwards: ForwardSpec[]): Promise<void> {
    this.forwarder.closeAll(vmId);
    for (const { remotePort, hostPort } of forwards) {
      try {
        await this.forwarder.open(vmId, remotePort, hostPort);
      } catch (err) {
        console.warn(`[port-forward ${id} vmId=${vmId}] open ${remotePort} failed:`, err);
      }
    }
    this.portForwards.set(id, this.forwarder.list(vmId));
  }

  // Probe the VM's TCP listeners for the port panel. One exec reads
  // /proc/net/tcp{,6}. From it we report:
  //   - `forwarded`: each currently-forwarded port as "listening" (a server is
  //     up on wildcard OR loopback, both reachable via the relay) or
  //     "not-listening" (nothing bound yet, server not started / crashed).
  //   - `detected`: ports a server is listening on but that AREN'T forwarded
  //     yet: the one-click "forward this" candidates. Filtered to user-space
  //     ports (≥1024, so infra like systemd-resolved:53 doesn't show) and with
  //     the one isolade port that still binds a guest TCP socket (the
  //     expose_sandbox acceptor) removed. Terminals no longer bind a guest TCP
  //     port at all (ttyd runs on a unix socket), so there's nothing else to hide.
  async probePorts(id: string): Promise<PortProbe> {
    const instance = this.get(id);
    if (!instance) throw new Error(`instance ${id} not found`);
    const forwardedPorts = (this.portForwards.get(id) ?? []).map((p) => p.remotePort);

    const { stdout } = await this.sandboxClient.exec(
      instance.vmId,
      "sh -c 'cat /proc/net/tcp; echo ---; cat /proc/net/tcp6'",
    );
    const listening = parseListeningPorts(stdout);

    const forwarded = classifyListeningPorts(stdout, forwardedPorts);
    const forwardedSet = new Set(forwardedPorts);
    const detected = [...listening]
      // GUEST_SANDBOX_PORT is isolade plumbing (the expose_sandbox acceptor),
      // not a user server, so never offer to forward it.
      .filter((p) => p >= 1024 && !forwardedSet.has(p) && p !== GUEST_SANDBOX_PORT)
      .toSorted((a, b) => a - b);
    return { forwarded, detected };
  }

  // Establish every per-VM attachment a live VM needs: the single
  // reconciliation point create, restart, and re-attach all run (each supplying
  // params resolved its own way: create from the config it just loaded,
  // restart/attach via establishParamsForInstance). Two kinds of attachment:
  //   - apply-only (awaited): credential files + git config, which must be in
  //     place before the agent runs a turn. Best-effort, so they never throw.
  //   - standing channels (fire-and-forget): the signer broker, the in-VM CLI's
  //     control broker, and the reverse-sandbox acceptor each hold a background
  //     exec stream with its own reconnect loop, so they're kicked off, not
  //     awaited.
  // Then the host forward listeners (awaited). Every piece is idempotent per VM,
  // so re-attaching a still-live VM (a server-only reload) harmlessly refreshes
  // it rather than duplicating anything.
  //
  // Note: expose_sandbox's ISOLADE_SANDBOX_URL env var is NOT an attachment.
  // It's baked into the VM at createVm time and read back from the row
  // thereafter. Only the reverse-forward acceptor is (re)attached here, gated on
  // that same persisted flag.
  private async establishAttachments(params: {
    id: string;
    vmId: string;
    identity: CommitterIdentity | null;
    git: GitConfigManager | null;
    signing: SigningConfig | null;
    exposeSandbox: boolean;
    forwards: ForwardSpec[];
  }): Promise<void> {
    const { id, vmId, identity, git, signing, exposeSandbox, forwards } = params;
    await this.setupAgentAuth(vmId);
    await this.setupGitConfig(vmId, identity, signing);
    this.ensureSignerBroker(vmId, git, signing);
    this.setupPortControl(id, vmId);
    this.setupSandboxForward(vmId, exposeSandbox);
    await this.reopenForwards(id, vmId, forwards);
  }

  // The establish params for a persisted instance (restart / re-attach), all
  // resolved from the instance's OWN profile (never the active one), so
  // switching the active profile never disturbs a running VM. create() builds
  // the equivalent inline from the config it already loaded.
  private establishParamsForInstance(instance: {
    id: string;
    vmId: string;
    profileId: string | null;
    exposeSandbox: boolean;
  }) {
    const git = this.gitFor(instance.profileId);
    return {
      id: instance.id,
      vmId: instance.vmId,
      identity: git?.effectiveIdentity() ?? null,
      git,
      signing: this.resolveSigningForVm(instance.profileId),
      exposeSandbox: instance.exposeSandbox,
      forwards: this.desiredForwards(instance.id, instance.profileId),
    };
  }

  // Tear down every per-VM attachment establishAttachments set up: stop the
  // standing control channels (their reconnect loops must not outlive the VM)
  // and close the host forward listeners (their guest counterparts die with the
  // VM), dropping the in-memory forward cache. Does NOT touch the persisted
  // forward ROWS. remove() deletes them separately, archive() keeps them so
  // unarchive can reopen the same set.
  private teardownAttachments(id: string, vmId: string): void {
    this.stopSignerBroker(vmId);
    this.stopPortControl(vmId);
    this.sandboxForwarder?.teardown(vmId);
    this.forwarder.closeAll(vmId);
    this.portForwards.delete(id);
  }

  // Seed VM-local credential files from the bind-mounted auth dir and
  // (re)start the auth-sync watcher. Idempotent: kills any prior watcher first
  // so restarts/resyncs don't stack duplicates. Best-effort, since an
  // unauthenticated agent is a valid state (no login yet), so a failure here
  // must never block create/restart/attach.
  private async setupAgentAuth(vmId: string): Promise<void> {
    await seedVmAuth(this.sandboxClient, vmId);
  }

  // Apply git config to a VM: the committer identity (every commit) and, when
  // active, commit signing via the shim. Mirrors setupAgentAuth and is
  // (re)written on create/restart/attach. Best-effort: on failure we log and
  // leave whatever was set, so at worst commits are unsigned / host-identity'd
  // rather than every commit failing.
  private async setupGitConfig(
    vmId: string,
    identity: CommitterIdentity | null,
    signing: SigningConfig | null,
  ): Promise<void> {
    if (!identity && !signing) return;
    try {
      // Single-quote each value so identities/keys with spaces survive the shell.
      const q = shellQuote;
      const cmds: string[] = [];
      // Identity overrides the host-derived name/email applyGitconfig set at
      // create, and applied to every instance's VM, signed or not.
      if (identity?.name) cmds.push(`git config --global user.name ${q(identity.name)}`);
      if (identity?.email) cmds.push(`git config --global user.email ${q(identity.email)}`);
      if (signing) {
        // Inject the shim via base64-through-the-shell (NOT sandboxClient.writeFile)
        // so it's owned by the runtime user and therefore chmod +x'able: writeFile
        // lands root-owned and a non-root agent can neither chmod nor exec it
        // (which would silently break the && chain after the identity commands).
        // Mirrors the in-VM script injection in auth-login.ts.
        const shimB64 = Buffer.from(
          buildSignShimScript({ socketPath: SIGN_SOCK }),
          "utf8",
        ).toString("base64");
        cmds.push(
          `echo ${shimB64} | base64 -d > ${SIGN_SHIM_PATH}`,
          `chmod +x ${SIGN_SHIM_PATH}`,
          `git config --global gpg.format ssh`,
          `git config --global gpg.ssh.program ${SIGN_SHIM_PATH}`,
          // Literal `key::` form so no public-key file needs to ship into the
          // VM. The shim ignores -f anyway and the host signer holds the key.
          `git config --global user.signingkey ${q(`key::${signing.signingKey}`)}`,
          `git config --global commit.gpgsign true`,
          `git config --global tag.gpgsign true`,
        );
      }
      if (cmds.length === 0) return;
      const { exitCode, stderr } = await this.sandboxClient.exec(vmId, cmds.join(" && "));
      if (exitCode !== 0) {
        console.warn(`[git-config ${vmId}] git config exited ${exitCode}: ${stderr.trim()}`);
      }
    } catch (err) {
      console.warn(`[git-config ${vmId}] setup failed:`, err);
    }
  }

  // Hold (or tear down) the persistent exec-stream signing broker for a VM.
  // When signing is active and no stream is running, start one. It signs each
  // request through the host SSH agent over the microsandbox exec channel (no
  // network, no port). A running stream reads the live config per request, so
  // key/socket changes need no restart. It also auto-reconnects across VM
  // reboots. When signing isn't active, ensure any stream is stopped.
  private ensureSignerBroker(
    vmId: string,
    git: GitConfigManager | null,
    signing: SigningConfig | null,
  ): void {
    if (!git || !signing) {
      this.stopSignerBroker(vmId);
      return;
    }
    if (this.signerStreams.has(vmId)) return;
    const ac = new AbortController();
    this.signerStreams.set(vmId, ac);
    void runSignerStream({
      sandboxClient: this.sandboxClient,
      vmId,
      sign: (payload) => git.signPayload(payload),
      signal: ac.signal,
    })
      .catch((err) => console.warn(`[git-signer ${vmId}] broker stream stopped:`, err))
      .finally(() => {
        if (this.signerStreams.get(vmId) === ac) this.signerStreams.delete(vmId);
      });
  }

  private stopSignerBroker(vmId: string): void {
    const ac = this.signerStreams.get(vmId);
    if (ac) {
      ac.abort();
      this.signerStreams.delete(vmId);
    }
  }

  // Install the in-VM `isolade` CLI and hold the persistent control broker that
  // backs it, so the agent can inspect/change forwards AND attach PRs from
  // inside the VM (see port-control.ts / pr-control.ts). Idempotent: no-op if a
  // stream is already running for the VM. Best-effort, so a failure here just
  // means the helper is unavailable, not a broken instance, so it never blocks
  // create/restart/attach.
  private setupPortControl(id: string, vmId: string): void {
    // (Re)install the CLI on PATH. The disk persists across a VM reboot, so this
    // is usually a harmless overwrite. On a fresh server it re-establishes it.
    void this.sandboxClient
      .exec(vmId, buildInstallCliCommand(buildControlCli(CTL_SOCK)))
      .catch((err) => console.warn(`[port-control ${vmId}] CLI install failed:`, err));

    if (this.portControlStreams.has(vmId)) return;
    const portOps: PortControlOps = {
      list: () => this.listPortForwards(id),
      forward: (remotePort, hostPort, ephemeral) => {
        // Host-port pinning from INSIDE a VM is an expose_sandbox privilege.
        // An ordinary agent VM may open ephemeral forwards, but letting it
        // claim exact host loopback ports would allow squatting on numbers
        // other host-local flows dial (e.g. OAuth callback ports). The dev VM
        // already has full-fleet trust, and its nested login flow is what
        // needs the pin (see auth-login.ts).
        if (hostPort !== undefined && !this.get(id)?.exposeSandbox) {
          throw new Error("pinned host ports are only available to expose_sandbox instances");
        }
        return this.addForward(id, remotePort, hostPort, { persist: !ephemeral });
      },
      unforward: (remotePort) => this.removeForward(id, remotePort),
    };
    const prOps: PrControlOps = {
      add: (ref) => this.prs.attach(id, vmId, ref),
      list: () => this.prs.listFor(id),
      remove: (ref) => this.prs.detach(id, ref),
    };
    const ac = new AbortController();
    this.portControlStreams.set(vmId, ac);
    void runRequestBroker({
      sandboxClient: this.sandboxClient,
      vmId,
      socketPath: CTL_SOCK,
      brokerPath: CTL_BROKER_PATH,
      // One socket carries both command families. Peek the `cmd` to route: `pr-*`
      // to the PR handler, everything else to port-control. A double parse (the
      // handler parses again) is fine for this low-rate control traffic.
      handle: (req) => {
        let cmd: unknown;
        try {
          cmd = JSON.parse(req.toString("utf8")).cmd;
        } catch {}
        return typeof cmd === "string" && cmd.startsWith("pr-")
          ? handlePrCommand(req, prOps)
          : handlePortCommand(req, portOps);
      },
      signal: ac.signal,
      label: "port-control",
    })
      .catch((err) => console.warn(`[port-control ${vmId}] broker stream stopped:`, err))
      .finally(() => {
        if (this.portControlStreams.get(vmId) === ac) this.portControlStreams.delete(vmId);
      });
  }

  private stopPortControl(vmId: string): void {
    const ac = this.portControlStreams.get(vmId);
    if (ac) {
      ac.abort();
      this.portControlStreams.delete(vmId);
    }
  }

  // Start/stop exposing the host sandbox API inside a VM (isolade within
  // isolade). `expose` is the instance row's create-time flag, NOT the profile's
  // live config: the guest's ISOLADE_SANDBOX_URL is baked into the persisted VM
  // record at create, so restart/attach must follow what the VM was actually
  // built with. A later config toggle only affects newly created instances.
  // Idempotent and safe to call on create/restart/attach: `setup` no-ops if
  // already running (the acceptor's reconnect loop rides out a reboot). No-op
  // entirely when there's no host sandbox to serve (sandboxForwarder null).
  private setupSandboxForward(vmId: string, expose: boolean): void {
    if (!this.sandboxForwarder) return;
    if (expose) this.sandboxForwarder.setup(vmId);
    else this.sandboxForwarder.teardown(vmId);
  }

  // Whether a persisted instance's VM should sign commits, for restart /
  // re-attach. (create() computes the equivalent inline via resolveActiveSigning
  // too.) Returns the active signing config, or null to leave the VM's commits
  // unsigned.
  private resolveSigningForVm(profileId: string | null): SigningConfig | null {
    if (!profileId) return null;
    if (!this.profiles.get(profileId)) return null;
    return this.profiles.git(profileId).resolveActiveSigning();
  }

  // Await the profile's in-flight lifecycle steps (setup/start) for an
  // instance, if any. Resolves immediately when none are running. Never throws:
  // a failed step surfaces as status=error + lastError, which the caller checks.
  async awaitInit(id: string): Promise<void> {
    await this.initRuns.get(id);
  }

  // The lifecycle command block for a persisted instance's profile, for restart.
  // Best-effort like resolveSigningForVm: a missing/invalid config yields no
  // commands rather than blocking the restart.
  private readInitForProfile(profileId: string | null): ResolvedProfileConfig["init"] {
    const empty = {
      setup: { sync: [], async: [] },
      start: { sync: [], async: [] },
    };
    if (!profileId) return empty;
    try {
      return loadProfileConfig(profileId).init;
    } catch {
      return empty;
    }
  }

  // Kick off the profile's lifecycle commands against a freshly-booted VM and
  // reflect readiness in the instance status. Returns synchronously after
  // setting the initial status (`initializing` when a gating sync step will
  // run). The steps then run in the background and flip the status to
  // running/error. `runSetup` gates the one-time `[setup]` phase: true at
  // create and when a prior setup never completed (retry), false once setupDone.
  private beginInit(
    id: string,
    vmId: string,
    init: ResolvedProfileConfig["init"],
    runSetup: boolean,
  ): void {
    // Supersede any prior run for this instance (see initGen).
    const gen = (this.initGen.get(id) ?? 0) + 1;
    this.initGen.set(id, gen);
    this.initRuns.delete(id);
    const setup = runSetup ? init.setup : { sync: [], async: [] };
    const start = init.start;
    const nothingToRun =
      setup.sync.length === 0 &&
      setup.async.length === 0 &&
      start.sync.length === 0 &&
      start.async.length === 0;
    if (nothingToRun) {
      // Nothing runs, but record that setup is "done" (once) so a restart after
      // a [start] block is added later doesn't reconsider the setup phase.
      if (runSetup) this.markSetupDone(id);
      return;
    }
    if (setup.sync.length > 0 || start.sync.length > 0) {
      this.db
        .update(schema.instances)
        .set({ status: "initializing", lastError: null, updatedAt: new Date() })
        .where(eq(schema.instances.id, id))
        .run();
    }
    // runInit never rejects (failures are recorded on the row). The guard is
    // belt-and-suspenders against a bug leaving an unhandled rejection.
    const run = this.runInit(id, vmId, setup, start, runSetup, gen).catch((err) =>
      console.warn(`[instance-init ${id}] lifecycle run crashed:`, err),
    );
    this.initRuns.set(id, run);
  }

  // True when a newer lifecycle run (or a remove) has superseded generation
  // `gen` for `id`. The caller should stop mutating this instance's state.
  private initSuperseded(id: string, gen: number): boolean {
    return this.initGen.get(id) !== gen;
  }

  // Execute one boot's lifecycle steps in the VM. Async steps from both phases
  // fire immediately in parallel and never gate (a failure is logged, the
  // instance stays usable). Sync steps gate readiness: setup first, then start,
  // each sequential. Setup is marked complete the moment its sync steps pass,
  // so a later [start] failure never causes setup to re-provision on restart.
  private async runInit(
    id: string,
    vmId: string,
    setup: { sync: string[]; async: string[] },
    start: { sync: string[]; async: string[] },
    markSetup: boolean,
    gen: number,
  ): Promise<void> {
    // Fresh transcript per boot so restarts don't accrete stale output.
    await this.sandboxClient
      .exec(vmId, `: > ${INIT_LOG_PATH}`, { workingDir: WORKSPACE_ROOT })
      .catch(() => {});

    for (const command of [...setup.async, ...start.async]) {
      void this.runInitStep(vmId, command)
        .then((r) => {
          if (r.exitCode !== 0)
            console.warn(`[instance-init ${id}] async step exited ${r.exitCode}: ${command}`);
        })
        .catch((err) => console.warn(`[instance-init ${id}] async step failed (${command}):`, err));
    }

    if (!(await this.runSyncSteps(id, vmId, setup.sync, gen))) return;
    if (this.initSuperseded(id, gen)) return;
    if (markSetup) this.markSetupDone(id);
    if (!(await this.runSyncSteps(id, vmId, start.sync, gen))) return;

    // All gating steps passed, so claim readiness, unless a concurrent
    // restart/remove already superseded this run or moved the status on.
    if (!this.initSuperseded(id, gen) && this.get(id)?.status === "initializing") {
      this.db
        .update(schema.instances)
        .set({ status: "running", lastError: null, updatedAt: new Date() })
        .where(eq(schema.instances.id, id))
        .run();
    }
  }

  // Run gating steps sequentially. On the first non-zero exit or exec error,
  // record it (status=error + lastError) and return false. Returns true when
  // all pass (or there are none). Stops silently if superseded mid-run.
  private async runSyncSteps(
    id: string,
    vmId: string,
    commands: string[],
    gen: number,
  ): Promise<boolean> {
    for (const command of commands) {
      if (this.initSuperseded(id, gen)) return false;
      let exitCode: number;
      try {
        ({ exitCode } = await this.runInitStep(vmId, command));
      } catch (err) {
        await this.failInit(
          id,
          vmId,
          command,
          err instanceof Error ? err.message : String(err),
          gen,
        );
        return false;
      }
      if (exitCode !== 0) {
        await this.failInit(id, vmId, command, `exited ${exitCode}`, gen);
        return false;
      }
    }
    return true;
  }

  // Run one lifecycle command from /workspace, appending its output (with a `$ `
  // header) to the in-VM transcript. exec returns the command's own exit code
  // because the redirection is on the brace group, not a pipe. Newlines (not
  // `;`) terminate the list so a backgrounded command (`some-daemon &`, the
  // common `[start]` shape) stays valid. `& ;` is a shell syntax error.
  private runInitStep(vmId: string, command: string): Promise<ExecResult> {
    const header = `printf '\\n$ %s\\n' ${shellQuote(command)}`;
    const wrapped = `{ ${header}\n${command}\n} >> ${INIT_LOG_PATH} 2>&1`;
    return this.sandboxClient.exec(vmId, wrapped, {
      workingDir: WORKSPACE_ROOT,
      timeoutMs: INIT_COMMAND_TIMEOUT_MS,
    });
  }

  private markSetupDone(id: string): void {
    this.db
      .update(schema.instances)
      .set({ setupDone: true })
      .where(eq(schema.instances.id, id))
      .run();
  }

  // Record a sync-step failure: pull a tail of the transcript for context, then
  // land the instance in `error` with a one-line reason. Best-effort log read,
  // so the reason still names the failing command if the read fails.
  private async failInit(
    id: string,
    vmId: string,
    command: string,
    detail: string,
    gen: number,
  ): Promise<void> {
    let tail = "";
    try {
      const { stdout } = await this.sandboxClient.exec(vmId, `tail -n 20 ${INIT_LOG_PATH}`, {
        workingDir: WORKSPACE_ROOT,
      });
      tail = stdout.trim();
    } catch {
      // ignore, the command + detail below is still actionable
    }
    const reason = `init command failed (${detail}): ${command}${tail ? `\n${tail}` : ""}`;
    console.warn(`[instance-init ${id}] ${reason}`);
    if (this.initSuperseded(id, gen)) return;
    // Don't clobber a status a concurrent restart/remove already changed.
    if (this.get(id)?.status === "initializing") {
      this.db
        .update(schema.instances)
        .set({ status: "error", lastError: reason, updatedAt: new Date() })
        .where(eq(schema.instances.id, id))
        .run();
    }
  }

  async cleanup() {
    for (const instance of this.list()) {
      await this.remove(instance.id);
    }
  }
}

export type PortListenStatus = "listening" | "not-listening";

// Every TCP port with a LISTEN socket in the guest's combined /proc/net/tcp +
// /proc/net/tcp6 dump (the two halves joined by a "---" line, as probePorts
// reads them). Counts both wildcard (0.0.0.0 / ::) and loopback (127.0.0.1 /
// ::1) binds, both reachable through the in-guest relay. Pure so the
// fiddly hex address/port/state parsing is directly testable. Addresses in
// /proc are hex and only state 0A is LISTEN.
export function parseListeningPorts(procNetTcp: string): Set<number> {
  const [v4 = "", v6 = ""] = procNetTcp.split("---");
  const ports = new Set<number>();
  // IPv4 rows carry an 8-hex-char address, and IPv6 rows a 32-hex-char one. We
  // accept any local address (wildcard or loopback). Only the LISTEN state
  // (0A) and the port matter.
  const scan = (block: string, addrLen: number) => {
    const re = new RegExp(
      `^\\d+:\\s+[0-9A-Fa-f]{${addrLen}}:([0-9A-Fa-f]{4})\\s+\\S+\\s+([0-9A-Fa-f]{2})`,
    );
    for (const line of block.split("\n").slice(1)) {
      const m = line.trim().match(re);
      if (m && m[1] && m[2] === "0A") ports.add(parseInt(m[1], 16));
    }
  };
  scan(v4, 8);
  scan(v6, 32);
  return ports;
}

// Classify each requested port: "listening" if the guest has any TCP listener
// on it (wildcard or loopback, the relay reaches both), else "not-listening".
export function classifyListeningPorts(
  procNetTcp: string,
  remotePorts: readonly number[],
): Array<{ remotePort: number; status: PortListenStatus }> {
  const listening = parseListeningPorts(procNetTcp);
  return remotePorts.map((remotePort) => ({
    remotePort,
    status: listening.has(remotePort) ? ("listening" as const) : ("not-listening" as const),
  }));
}
