import { describe, expect, it, spyOn } from "bun:test";
import { createSandboxApp } from "../src/index";

class FakeVmManager {
  calls: { method: string; args: unknown[] }[] = [];

  async create(opts: unknown) {
    this.calls.push({ method: "create", args: [opts] });
    return {
      vmId: "vm-1",
      ports: [{ address: "127.0.0.1", localPort: 12000, remotePort: 3000 }],
    };
  }

  async remove(vmId: string) {
    this.calls.push({ method: "remove", args: [vmId] });
  }

  async removeAll() {
    this.calls.push({ method: "removeAll", args: [] });
  }

  async stop(vmId: string) {
    this.calls.push({ method: "stop", args: [vmId] });
  }

  async stopAll() {
    this.calls.push({ method: "stopAll", args: [] });
  }

  async restart(vmId: string) {
    this.calls.push({ method: "restart", args: [vmId] });
    return [{ address: "127.0.0.1", localPort: 12000, remotePort: 3000 }];
  }

  async ensure(vmId: string) {
    this.calls.push({ method: "ensure", args: [vmId] });
    return [{ address: "127.0.0.1", localPort: 12000, remotePort: 3000 }];
  }

  async exec(vmId: string, command: string, opts: unknown) {
    this.calls.push({ method: "exec", args: [vmId, command, opts] });
    return { stdout: "ok", stderr: "", exitCode: 0 };
  }

  async writeFile(vmId: string, path: string, content: Buffer) {
    this.calls.push({
      method: "writeFile",
      args: [vmId, path, content.toString("utf8")],
    });
  }

  async execStream(): Promise<{ exitCode: number }> {
    throw new Error("not implemented");
  }

  async execInteractive(): Promise<{ exitCode: number }> {
    throw new Error("not implemented");
  }

  listVmHandles() {
    return [];
  }
}

describe("sandbox app HTTP routes", () => {
  it("creates VMs through the VM manager", async () => {
    const manager = new FakeVmManager();
    const app = createSandboxApp({ vmManager: manager });

    const res = await app.request("/vms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: "test-image", ports: [{ remote: 3000 }], clientId: "host" }),
    });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      id: "vm-1",
      ports: [{ address: "127.0.0.1", localPort: 12000, remotePort: 3000 }],
    });
    expect(manager.calls[0]).toEqual({
      method: "create",
      args: [{ image: "test-image", ports: [{ remote: 3000 }], clientId: "host" }],
    });
  });

  it("refuses to create a VM without a client identity", async () => {
    const manager = new FakeVmManager();
    const app = createSandboxApp({ vmManager: manager });

    const res = await app.request("/vms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: "test-image" }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "clientId required" });
    expect(manager.calls).toEqual([]);
  });

  it("stops a VM without removing it", async () => {
    const manager = new FakeVmManager();
    const app = createSandboxApp({ vmManager: manager });

    const res = await app.request("/vms/vm-1/stop", { method: "POST" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(manager.calls[0]).toEqual({ method: "stop", args: ["vm-1"] });
  });

  it("executes commands with working directory and timeout options", async () => {
    const manager = new FakeVmManager();
    const app = createSandboxApp({ vmManager: manager });

    const res = await app.request("/vms/vm-1/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        command: "pwd",
        workingDir: "/workspace",
        timeoutMs: 1000,
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stdout: "ok", stderr: "", exitCode: 0 });
    expect(manager.calls[0]).toEqual({
      method: "exec",
      args: ["vm-1", "pwd", { workingDir: "/workspace", timeoutMs: 1000 }],
    });
  });

  it("decodes base64 file writes before delegating", async () => {
    const manager = new FakeVmManager();
    const app = createSandboxApp({ vmManager: manager });

    const res = await app.request("/vms/vm-1/write", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "/workspace/file.txt",
        content: "aGVsbG8=",
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(manager.calls[0]).toEqual({
      method: "writeFile",
      args: ["vm-1", "/workspace/file.txt", "hello"],
    });
  });

  it("streams build logs and the final image id", async () => {
    const clients: string[] = [];
    const app = createSandboxApp({
      vmManager: new FakeVmManager(),
      async *runBuild(_tarStream, clientId) {
        clients.push(clientId);
        yield "first line";
        yield "second line";
        return "localhost:5000/isolade/image:latest";
      },
    });

    const res = await app.request("/builds?client=host", {
      method: "POST",
      body: "tar",
    });
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(text).toContain("event: log");
    expect(text).toContain("data: first line");
    expect(text).toContain("data: second line");
    expect(text).toContain("event: done");
    expect(text).toContain('data: {"imageId":"localhost:5000/isolade/image:latest"}');
    expect(clients).toEqual(["host"]);
  });

  it("requires a body for builds", async () => {
    const app = createSandboxApp({ vmManager: new FakeVmManager() });

    const res = await app.request("/builds?client=host", { method: "POST" });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "request body required" });
  });

  it("refuses a build without a client identity", async () => {
    const app = createSandboxApp({
      vmManager: new FakeVmManager(),
      // eslint-disable-next-line require-yield
      async *runBuild() {
        throw new Error("should not be called");
      },
    });

    const res = await app.request("/builds", { method: "POST", body: "tar" });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "client query parameter required" });
  });

  it("streams registry gc progress and forwards the keep set", async () => {
    const calls: { keep: string[]; clientId: string }[] = [];
    const app = createSandboxApp({
      vmManager: new FakeVmManager(),
      async runRegistryGc(keep, clientId, log) {
        calls.push({ keep, clientId });
        log?.("deleted isolade/old:latest");
      },
    });

    const res = await app.request("/registry/gc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keep: ["host:5001/isolade/abc:latest"], clientId: "host" }),
    });
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(calls).toEqual([{ keep: ["host:5001/isolade/abc:latest"], clientId: "host" }]);
    expect(text).toContain("event: log");
    expect(text).toContain("data: deleted isolade/old:latest");
    expect(text).toContain("event: done");
  });

  it("refuses a registry gc without a client identity", async () => {
    const app = createSandboxApp({
      vmManager: new FakeVmManager(),
      async runRegistryGc() {
        throw new Error("should not be called");
      },
    });

    const res = await app.request("/registry/gc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keep: [] }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "clientId required" });
  });

  it("rejects malformed registry gc payloads", async () => {
    const app = createSandboxApp({
      vmManager: new FakeVmManager(),
      async runRegistryGc() {
        throw new Error("should not be called");
      },
    });

    const res = await app.request("/registry/gc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keep: [42] }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "keep must be a string[]" });
  });

  it("emits an SSE error event when registry gc throws", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const app = createSandboxApp({
      vmManager: new FakeVmManager(),
      async runRegistryGc() {
        throw new Error("registry unavailable");
      },
    });

    try {
      const res = await app.request("/registry/gc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keep: [], clientId: "host" }),
      });
      const text = await res.text();
      expect(res.status).toBe(200);
      expect(text).toContain("event: error");
      expect(text).toContain("registry unavailable");
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
