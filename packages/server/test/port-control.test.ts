import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildControlCli, handlePortCommand, type PortControlOps } from "../src/port-control";
import { runRequestBroker } from "../src/request-broker";
import type { ExecStreamOpts, PortForwardBinding, SandboxApi } from "../src/sandbox-client";

// A fake ops that records calls and returns canned bindings.
function fakeOps(overrides: Partial<PortControlOps> = {}): PortControlOps & {
  forwarded: number[];
  unforwarded: number[];
} {
  const forwarded: number[] = [];
  const unforwarded: number[] = [];
  return {
    forwarded,
    unforwarded,
    list: () =>
      forwarded.map((remotePort) => ({
        address: "127.0.0.1",
        localPort: 40000 + remotePort,
        remotePort,
      })),
    detected: async () => [8080],
    forward: async (remotePort) => {
      forwarded.push(remotePort);
      return {
        address: "127.0.0.1",
        localPort: 40000 + remotePort,
        remotePort,
      } as PortForwardBinding;
    },
    unforward: (remotePort) => {
      unforwarded.push(remotePort);
    },
    ...overrides,
  };
}

async function call(cmd: object, ops: PortControlOps): Promise<any> {
  const out = await handlePortCommand(Buffer.from(JSON.stringify(cmd)), ops);
  return JSON.parse(out.toString("utf8"));
}

describe("handlePortCommand", () => {
  it("lists forwarded + detected ports", async () => {
    const ops = fakeOps();
    await ops.forward(5173);
    expect(await call({ cmd: "list" }, ops)).toEqual({
      ok: true,
      forwarded: [{ remotePort: 5173, localPort: 45173 }],
      detected: [8080],
    });
  });

  it("forwards a port and echoes the binding", async () => {
    const ops = fakeOps();
    expect(await call({ cmd: "forward", port: 3000 }, ops)).toEqual({
      ok: true,
      remotePort: 3000,
      localPort: 43000,
    });
    expect(ops.forwarded).toEqual([3000]);
  });

  it("unforwards a port", async () => {
    const ops = fakeOps();
    expect(await call({ cmd: "unforward", port: 3000 }, ops)).toEqual({
      ok: true,
    });
    expect(ops.unforwarded).toEqual([3000]);
  });

  it("rejects invalid ports and unknown commands", async () => {
    const ops = fakeOps();
    expect((await call({ cmd: "forward", port: 0 }, ops)).ok).toBe(false);
    expect((await call({ cmd: "forward", port: 99999 }, ops)).ok).toBe(false);
    expect((await call({ cmd: "bogus" }, ops)).ok).toBe(false);
    expect(ops.forwarded).toEqual([]);
  });

  it("surfaces a handler error as { ok: false }", async () => {
    const ops = fakeOps({
      forward: async () => {
        throw new Error("instance not found");
      },
    });
    const res = await call({ cmd: "forward", port: 3000 }, ops);
    expect(res).toEqual({ ok: false, error: "instance not found" });
  });

  it("rejects a malformed request", async () => {
    const res = JSON.parse(
      (await handlePortCommand(Buffer.from("not json"), fakeOps())).toString(),
    );
    expect(res.ok).toBe(false);
  });
});

// A SandboxApi that runs the REAL broker script via a local `node` subprocess,
// so the CLI ↔ broker ↔ host round-trip is exercised for real (only the
// microsandbox exec transport is faked). Mirrors the forwarder test's approach.
class NodeBrokerSandbox {
  private files = new Map<string, Buffer>();
  dir = mkdtempSync(join(tmpdir(), "ctl-test-"));
  private procs: ReturnType<typeof Bun.spawn>[] = [];

  cleanup() {
    for (const p of this.procs) p.kill();
    rmSync(this.dir, { recursive: true, force: true });
  }

  writeFile(_vmId: string, path: string, content: Buffer): Promise<void> {
    this.files.set(path, content);
    return Promise.resolve();
  }

  exec(): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    // The broker runner's pkill/rm cleanup step, nothing to do in the fake.
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }

  async execStream(
    _vmId: string,
    command: string,
    opts: ExecStreamOpts,
  ): Promise<{ exitCode: number }> {
    const m = command.match(/^node (\S+)$/);
    if (!m) throw new Error(`unexpected exec command: ${command}`);
    const script = this.files.get(m[1]!);
    if (!script) throw new Error(`broker script not written before exec: ${m[1]}`);
    const scriptPath = join(this.dir, "broker.cjs");
    writeFileSync(scriptPath, script);
    const proc = Bun.spawn(["node", scriptPath], {
      stdin: "pipe",
      stdout: "pipe",
    });
    this.procs.push(proc);
    opts.signal?.addEventListener("abort", () => proc.kill(), { once: true });
    (async () => {
      for await (const chunk of opts.stdin) proc.stdin.write(chunk);
      proc.stdin.end();
    })().catch(() => {});
    (async () => {
      for await (const chunk of proc.stdout as ReadableStream<Uint8Array>)
        opts.stdout(Buffer.from(chunk));
    })().catch(() => {});
    return { exitCode: await proc.exited };
  }
}

// Run the real guest CLI against a socket, returning its stdout/exit.
async function runCli(
  cliPath: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn(["node", cliPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

describe("port-control broker + CLI round-trip", () => {
  const sandboxes: NodeBrokerSandbox[] = [];
  const controllers: AbortController[] = [];

  afterEach(() => {
    for (const c of controllers.splice(0)) c.abort();
    for (const s of sandboxes.splice(0)) s.cleanup();
  });

  it("drives forward/list/unforward from the real CLI through the broker", async () => {
    const sb = new NodeBrokerSandbox();
    sandboxes.push(sb);
    const sock = join(sb.dir, "ctl.sock");
    const brokerPath = join(sb.dir, "ctl-broker.cjs");
    const cliPath = join(sb.dir, "isolade");
    writeFileSync(cliPath, buildControlCli(sock));

    const ops = fakeOps();
    const ac = new AbortController();
    controllers.push(ac);
    void runRequestBroker({
      sandboxClient: sb as unknown as SandboxApi,
      vmId: "vm1",
      socketPath: sock,
      brokerPath,
      handle: (req) => handlePortCommand(req, ops),
      signal: ac.signal,
      label: "test",
    });

    // Wait for the broker to create the socket before dialing it.
    const deadline = Date.now() + 5000;
    while (!existsSync(sock) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    expect(existsSync(sock)).toBe(true);

    const fwd = await runCli(cliPath, ["forward", "5173"]);
    expect(fwd.code).toBe(0);
    expect(fwd.stdout).toContain("host localhost:45173");
    expect(ops.forwarded).toEqual([5173]);

    const list = await runCli(cliPath, ["ports"]);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain("5173  ->  host localhost:45173");
    expect(list.stdout).toContain("Detected");

    const un = await runCli(cliPath, ["unforward", "5173"]);
    expect(un.code).toBe(0);
    expect(ops.unforwarded).toEqual([5173]);
  });
});
