import type { SandboxRuntime } from "@isolade/sandbox/runtime";
import {
  type CreateVmOpts,
  type ExecInteractiveOpts,
  type ExecResult,
  type ExecStreamOpts,
  HOST_CLIENT_ID,
  type SandboxApi,
  type VmHandle,
} from "./sandbox-client";

// In-process implementation of SandboxApi: drives the sandbox runtime objects
// directly instead of over HTTP. This is the default. The HTTP `SandboxClient`
// is used only when ISOLADE_SANDBOX_URL points at an external sandbox. Each
// method mirrors the corresponding HTTP route handler in
// packages/sandbox/src/index.ts one-for-one (minus the JSON/WS/SSE transport).
export class InProcessSandboxClient implements SandboxApi {
  constructor(private readonly runtime: SandboxRuntime) {}

  // The wire request type and VmManager's VmCreateOpts are structurally the
  // same shape (the HTTP route passes the parsed body straight through). The
  // cast bridges the two nominal types without a runtime round-trip. In-process
  // calls are by definition the host's own, so they're stamped "host".
  async createVm(opts: CreateVmOpts): Promise<VmHandle> {
    return this.runtime.vmManager.create({
      ...opts,
      clientId: HOST_CLIENT_ID,
    } as Parameters<SandboxRuntime["vmManager"]["create"]>[0]);
  }

  async destroyVm(vmId: string): Promise<void> {
    await this.runtime.vmManager.remove(vmId);
  }

  async stopVm(vmId: string): Promise<void> {
    await this.runtime.vmManager.stop(vmId);
  }

  async restartVm(vmId: string): Promise<VmHandle> {
    return { vmId, ports: await this.runtime.vmManager.restart(vmId) };
  }

  async ensureVm(vmId: string): Promise<VmHandle> {
    return { vmId, ports: await this.runtime.vmManager.ensure(vmId) };
  }

  async exec(
    vmId: string,
    command: string,
    opts: { workingDir?: string; timeoutMs?: number } = {},
  ): Promise<ExecResult> {
    return this.runtime.vmManager.exec(vmId, command, opts);
  }

  async writeFile(vmId: string, path: string, content: Buffer): Promise<void> {
    await this.runtime.vmManager.writeFile(vmId, path, content);
  }

  execStream(vmId: string, command: string, opts: ExecStreamOpts): Promise<{ exitCode: number }> {
    return this.runtime.vmManager.execStream(vmId, command, opts);
  }

  execInteractive(
    vmId: string,
    shell: string,
    opts: ExecInteractiveOpts,
  ): Promise<{ exitCode: number }> {
    return this.runtime.vmManager.execInteractive(vmId, shell, opts);
  }

  async build(tarStream: ReadableStream | null, onLog: (line: string) => void): Promise<string> {
    if (!tarStream) throw new Error("build: request body required");
    const gen = this.runtime.builder.runBuild(tarStream, HOST_CLIENT_ID);
    while (true) {
      const result = await gen.next();
      if (result.done) return result.value;
      onLog(result.value);
    }
  }

  getStats(): Promise<unknown> {
    return this.runtime.getStats();
  }

  async waitUntilReady(): Promise<boolean> {
    // The runtime is fully constructed before createApp runs, so it's always
    // ready by the time any caller asks.
    return true;
  }

  async garbageCollect(keep: string[], onLog: (line: string) => void = () => {}): Promise<void> {
    await this.runtime.builder.runRegistryGc(keep, HOST_CLIENT_ID, onLog);
  }

  async registerKeepSet(clientId: string, keep: string[]): Promise<void> {
    await this.runtime.registerKeepSet(clientId, keep);
  }

  async listClients(): Promise<string[]> {
    return this.runtime.listClients();
  }

  async removeClient(clientId: string): Promise<void> {
    await this.runtime.removeClient(clientId);
  }
}
