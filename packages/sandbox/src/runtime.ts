// In-process sandbox runtime: the same VmManager + BuilderManager + in-process
// OCI registry that the standalone sandbox server (./index.ts) exposes over
// HTTP, handed back as plain objects so the isolade server can drive them
// directly when both run in one process (no localhost:7778 listener).
//
// IMPORTANT: importing this module loads the microsandbox SDK (via ./vms), so
// callers MUST pin MSB_HOME (./msb-home) and the NAPI path (./napi-path) BEFORE
// importing it. See packages/server/src/index.ts, which imports this lazily.

import { BuilderManager } from "./builder";
import { HOST_CLIENT_ID, listClientIds, removeClientEntry, vmsOwnedBy } from "./clients";
import { setBoundRegistryPort, setRegistryBridgeBinder } from "./host-network";
import { type RegistryServer, startRegistry } from "./registry";
import { CpuSampler, collectSandboxStats, StatsDiskCache } from "./stats";
import { VmManager } from "./vms";

export interface SandboxRuntime {
  readonly vmManager: VmManager;
  readonly builder: BuilderManager;
  readonly registry: RegistryServer;
  /** Snapshot of VM/host/registry resource stats (shape matches the sandbox
   * /stats route). */
  getStats(): Promise<unknown>;
  /** Replace `clientId`'s retention keep-set without sweeping. Used by the
   * host server to pre-protect refs it hands to a nested client (seeded dev
   * profiles) before that client's own first GC registration. */
  registerKeepSet(clientId: string, keep: string[]): Promise<void>;
  /** Every client id known to the registry (keep-set or owned VM), the host
   * included. The host reconciles this against its instances table at boot. */
  listClients(): Promise<string[]>;
  /** Remove a nested sandbox client: destroy every VM it created, drop its
   * retention keep-set, and sweep the image caches against the remaining
   * clients' union. Called when an `expose_sandbox` instance is deleted. */
  removeClient(clientId: string): Promise<void>;
  /** Stop (don't remove) VMs, the builder, and the registry. */
  shutdown(): Promise<void>;
}

export async function createSandboxRuntime(): Promise<SandboxRuntime> {
  const vmManager = new VmManager();
  const builder = new BuilderManager();
  const diskCache = new StatsDiskCache();
  diskCache.start();
  const cpuSampler = new CpuSampler();
  cpuSampler.start();

  // Boot the in-process OCI registry on an OS-assigned port and publish the
  // bound port so the builder/vms compose image refs against it. See
  // startSandboxServer in ./index for the standalone equivalent.
  const registry = await startRegistry({ port: 0 });
  setBoundRegistryPort(registry.port);
  // Bring the registry's guest-facing listener up on the bridge IP once it
  // resolves (first VM create/build). Until then it stays loopback-only.
  setRegistryBridgeBinder((ip) => registry.ensureNetworkListener(ip));

  return {
    vmManager,
    builder,
    registry,
    getStats: () =>
      collectSandboxStats({
        vmManager,
        builderManager: builder,
        diskCache,
        cpuSampler,
      }),
    registerKeepSet: async (clientId, keep) => {
      // The host's keep-set is owned by its own GC registrations; replacing it
      // through this side channel could shrink the union out from under it.
      // (Same guard as removeClient, so the two /clients routes are symmetric.)
      if (clientId === HOST_CLIENT_ID) {
        throw new Error("refusing to replace the host client's keep-set");
      }
      // Serialized through the builder's opChain: a caller pre-protecting refs
      // must know, when this resolves, that no sweep with an older union is
      // still deleting (see runKeepSetRegistration).
      await builder.runKeepSetRegistration(clientId, keep);
    },
    listClients: async () => listClientIds(),
    removeClient: async (clientId) => {
      // The host is not a removable client: its keep-set is the host DB's
      // memoized refs, re-registered on every host GC, and its VMs are
      // lifecycle-managed through the host DB, not the ownership registry.
      if (clientId === HOST_CLIENT_ID) {
        throw new Error("refusing to remove the host client");
      }
      // Destroy the client's VMs first (its nested server is gone, so nothing
      // manages them anymore). remove() is a graceful no-op for VMs that
      // already vanished, so stale ownership entries don't fail the cascade.
      for (const vmId of vmsOwnedBy(clientId)) {
        await vmManager.remove(vmId).catch((err) => {
          console.warn(`[sandbox] client ${clientId}: VM ${vmId} removal failed:`, err);
        });
      }
      // The entry is dropped INSIDE the sweep's opChain slot: an in-flight
      // build for this client re-registers its fresh ref when it completes
      // (addToKeepSet runs in the build's slot), so dropping outside the queue
      // could land BEFORE that registration and resurrect a keep-set entry —
      // retaining the image forever. Serialized, the drop wins.
      await builder.runClientSweep(
        (line) => {
          console.log(`[sandbox] client ${clientId} sweep: ${line}`);
        },
        () => removeClientEntry(clientId),
      );
      // A createVm that was in flight when the cascade started may have
      // recorded ownership after the snapshot above. Those stragglers stay in
      // the registry (vms.remove keeps entries for failed removals too), so
      // the host's boot-time reconciliation retries this client until clean.
      const stragglers = vmsOwnedBy(clientId);
      if (stragglers.length > 0) {
        console.warn(
          `[sandbox] client ${clientId}: ${stragglers.length} VM(s) appeared during ` +
            `removal; the next boot-time client sweep retries them`,
        );
      }
    },
    shutdown: async () => {
      diskCache.stop();
      cpuSampler.stop();
      // Stop VMs before the builder, and *only* stop them. Don't remove the
      // persisted records. The next isolade boot re-attaches via
      // Sandbox.start(name) so user state (workspace edits, terminal
      // history, running processes' on-disk artifacts) survives a restart.
      // The builder VM doesn't get this treatment: its in-VM setup
      // (tmpfs mount + buildkitd spawn) has to happen on every boot
      // anyway, and the persistent buildkit cache is on a virtio-blk disk
      // that already survives without preserving the sandbox record.
      await vmManager.stopAll().catch((err) => {
        console.warn("[sandbox] shutdown: stopAll failed:", err);
      });
      await builder.shutdown().catch(() => {});
      await registry.stop().catch((err) => {
        console.warn("[sandbox] shutdown: registry.stop failed:", err);
      });
    },
  };
}
