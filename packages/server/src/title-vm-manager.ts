import { eq } from "drizzle-orm";
import { AUTH_MOUNT, seedVmAuth } from "./auth-sync";
import type { Db } from "./db";
import { schema } from "./db";
import { KeyedQueue } from "./keyed-queue";
import type { ProfileManager } from "./profiles";
import type { SandboxApi } from "./sandbox-client";

interface WarmVm {
  vmId: string;
  ready: boolean;
}

// Keeps one always-warm "titling" VM per profile so chat titles can be minted
// instantly. The instance's own VM is cold-booting on the first message, so
// titling it there means title latency == boot latency every time. A titling VM
// is a stripped-down clone of an instance VM: the profile's image + the auth
// bind-mount + the profile's network policy, but no ports / caches /
// secrets / git signing (titling needs none of those). It bind-mounts the
// SAME per-profile auth dir as instance VMs, so it inherits whichever provider
// the profile is signed into (claude and/or codex). That's what lets titling
// run through the chat's own provider.
//
// Lifecycle (see ActiveProfileTracker): created when a profile becomes active
// in some window, destroyed when no window is using it anymore. Never resumed
// across a restart. reapOrphans() destroys any leftovers at boot.
export class TitleVmManager {
  // profileId -> warm VM. The in-memory map is the live source of truth. The
  // title_vms table is only a crash-recovery breadcrumb.
  private vms = new Map<string, WarmVm>();
  // Per-profile op serialization. acquire and release for one profile must not
  // interleave (a release mid-create would otherwise orphan a VM), so every op
  // chains behind the previous one for that profile.
  private ops = new KeyedQueue();
  // Called once a titling VM is ready, to pre-warm the agent processes inside it
  // (a persistent claude titling session + the codex app-server) so the first
  // title pays no startup. Wired by app.ts (which holds the backends), and kept as a
  // hook so this manager doesn't depend on them directly.
  private prewarm?: (vmId: string) => void;

  constructor(
    private db: Db,
    private sandboxClient: SandboxApi,
    private profiles: ProfileManager,
  ) {}

  setPrewarm(fn: (vmId: string) => void): void {
    this.prewarm = fn;
  }

  // Destroy any titling VMs left over from a previous run and clear the table.
  // They're ephemeral and never resumed, so a clean boot starts with none.
  // Call once at startup, after the sandbox is reachable.
  async reapOrphans(): Promise<void> {
    const rows = this.db.select().from(schema.titleVms).all();
    if (rows.length > 0) {
      console.log(`[title-vm] reaping ${rows.length} orphaned titling VM(s) from a prior run`);
    }
    await Promise.all(
      rows.map((r) =>
        this.sandboxClient.destroyVm(r.vmId).catch((err) => {
          console.warn(`[title-vm] orphan destroy failed vmId=${r.vmId}:`, err);
        }),
      ),
    );
    this.db.delete(schema.titleVms).run();
    this.vms.clear();
  }

  // Ensure a warm titling VM exists for the profile. Idempotent and safe to call
  // fire-and-forget (the activate endpoint does, and it must not block on a cold
  // boot). Best-effort: a failure leaves no entry so the next call retries.
  acquire(profileId: string): Promise<void> {
    return this.ops.run(profileId, async () => {
      if (this.vms.get(profileId)?.ready) return;
      const profile = this.profiles.get(profileId);
      if (!profile?.image) {
        console.warn(`[title-vm] profile ${profileId} has no built image; skipping warm VM`);
        return;
      }
      try {
        const authStore = this.profiles.auth(profileId);
        authStore.ensureDir();
        const network = this.profiles.network(profileId).read();
        const t0 = performance.now();
        const { vmId } = await this.sandboxClient.createVm({
          image: profile.image,
          volumes: [{ guestPath: AUTH_MOUNT, hostPath: authStore.dir() }],
          network,
        });
        this.db
          .insert(schema.titleVms)
          .values({ profileId, vmId })
          .onConflictDoUpdate({
            target: schema.titleVms.profileId,
            set: { vmId },
          })
          .run();
        await seedVmAuth(this.sandboxClient, vmId);
        this.vms.set(profileId, { vmId, ready: true });
        console.log(
          `[title-vm] warmed profile=${profileId} vmId=${vmId} in ${(performance.now() - t0).toFixed(0)}ms`,
        );
        // Pre-warm the agent processes so the first title is just an inference
        // round-trip. Best-effort and fire-and-forget, so it never blocks acquire.
        try {
          this.prewarm?.(vmId);
        } catch (err) {
          console.warn(`[title-vm] prewarm hook failed vmId=${vmId}:`, err);
        }
      } catch (err) {
        console.warn(`[title-vm] acquire failed profile=${profileId}:`, err);
        this.vms.delete(profileId);
      }
    });
  }

  // The warm VM id for a profile, or null if none is ready yet. Non-blocking,
  // the title flow falls back to the instance's own VM when this returns null.
  getReadyVmId(profileId: string): string | null {
    const entry = this.vms.get(profileId);
    return entry?.ready ? entry.vmId : null;
  }

  async ensureReadyVmId(profileId: string): Promise<string | null> {
    await this.acquire(profileId);
    return this.getReadyVmId(profileId);
  }

  // Tear down the profile's titling VM (profile switched away from, or deleted).
  release(profileId: string): Promise<void> {
    return this.ops.run(profileId, async () => {
      const entry = this.vms.get(profileId);
      this.vms.delete(profileId);
      const row = this.db
        .select()
        .from(schema.titleVms)
        .where(eq(schema.titleVms.profileId, profileId))
        .get();
      const vmId = entry?.vmId ?? row?.vmId;
      this.db.delete(schema.titleVms).where(eq(schema.titleVms.profileId, profileId)).run();
      if (vmId) {
        await this.sandboxClient.destroyVm(vmId).catch((err) => {
          console.warn(`[title-vm] release destroy failed profile=${profileId} vmId=${vmId}:`, err);
        });
        console.log(`[title-vm] released profile=${profileId} vmId=${vmId}`);
      }
    });
  }

  // Profile deleted: same teardown as release.
  disposeForProfile(profileId: string): Promise<void> {
    return this.release(profileId);
  }

  // Server shutdown: tear down every warm VM.
  async disposeAll(): Promise<void> {
    await Promise.all([...this.vms.keys()].map((p) => this.release(p)));
  }
}

// Idle window after which a client (window/tab) that stopped sending heartbeats
// is presumed gone and its profile released. Generous: a leak-guard for missed
// pagehide beacons, NOT the primary teardown path. An open window keeps
// heartbeating, so the profile it's using is never reaped while in use.
const CLIENT_STALE_MS = 5 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;

// Tracks which profiles are in use, keyed by a per-window client id, and drives
// the TitleVmManager: warm a profile's VM when a window starts using it, tear it
// down when the last window leaves it. The server has no singular "active
// profile" (multiple windows can each be on a different profile, and sessionStorage
// is per-window), so usage is a reference count over client ids.
export class ActiveProfileTracker {
  private clientProfile = new Map<string, string>(); // clientId -> profileId
  private lastSeen = new Map<string, number>(); // clientId -> epoch ms
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private titleVms: TitleVmManager) {}

  // A window reports (on boot, on switch, and periodically as a heartbeat) that
  // it's using `profileId`. Moves the client off any previous profile, releasing
  // that profile if no other window still holds it, and warms the new one.
  activate(clientId: string, profileId: string): void {
    const previous = this.clientProfile.get(clientId);
    this.clientProfile.set(clientId, profileId);
    this.lastSeen.set(clientId, Date.now());
    if (previous && previous !== profileId && !this.inUse(previous)) {
      void this.titleVms.release(previous);
    }
    void this.titleVms.acquire(profileId);
  }

  // A window is going away (pagehide beacon). Drop it and release its profile
  // if it was the last holder.
  deactivate(clientId: string): void {
    const previous = this.clientProfile.get(clientId);
    this.clientProfile.delete(clientId);
    this.lastSeen.delete(clientId);
    if (previous && !this.inUse(previous)) {
      void this.titleVms.release(previous);
    }
  }

  private inUse(profileId: string): boolean {
    for (const p of this.clientProfile.values()) if (p === profileId) return true;
    return false;
  }

  // Leak-guard: drop clients whose heartbeat went stale (window crashed or its
  // beacon was lost) and release any profile that leaves unused.
  private sweep(): void {
    const cutoff = Date.now() - CLIENT_STALE_MS;
    for (const [clientId, seen] of [...this.lastSeen]) {
      if (seen < cutoff) this.deactivate(clientId);
    }
  }

  // Started by the real entrypoint only (tests skip it). Unref'd so it never
  // keeps the process alive on its own.
  startSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  stopSweep(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }
}
