// In-process sandbox runtime: the same VmManager + BuilderManager + in-process
// OCI registry that the standalone sandbox server (./index.ts) exposes over
// HTTP, handed back as plain objects so the isolade server can drive them
// directly when both run in one process (no localhost:7778 listener).
//
// IMPORTANT: importing this module loads the microsandbox SDK (via ./vms), so
// callers MUST pin MSB_HOME (./msb-home) and the NAPI path (./napi-path) BEFORE
// importing it. See packages/server/src/index.ts, which imports this lazily.

import { BuilderManager } from "./builder";
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
