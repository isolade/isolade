import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildControlCli, handlePortCommand, type PortControlOps } from "../src/port-control";
import { runRequestBroker } from "../src/request-broker";
import type { ExecStreamOpts, PortForwardBinding, SandboxApi } from "../src/sandbox-client";

// A fake ops that records calls and returns canned bindings. `forwarded`
// mirrors live state (unforward removes), so `ports rm --all` round-trips.
function fakeOps(overrides: Partial<PortControlOps> = {}): PortControlOps & {
  forwarded: number[];
  unforwarded: number[];
  calls: Array<{ remotePort: number; hostPort?: number; ephemeral?: boolean }>;
} {
  const forwarded: number[] = [];
  const unforwarded: number[] = [];
  const calls: Array<{ remotePort: number; hostPort?: number; ephemeral?: boolean }> = [];
  return {
    forwarded,
    unforwarded,
    calls,
    list: () =>
      forwarded.map((remotePort) => ({
        address: "127.0.0.1",
        localPort: 40000 + remotePort,
        remotePort,
      })),
    forward: async (remotePort, hostPort, ephemeral) => {
      forwarded.push(remotePort);
      calls.push({ remotePort, hostPort, ephemeral });
      return {
        address: "127.0.0.1",
        localPort: hostPort ?? 40000 + remotePort,
        remotePort,
      } as PortForwardBinding;
    },
    unforward: (remotePort) => {
      unforwarded.push(remotePort);
      const i = forwarded.indexOf(remotePort);
      if (i >= 0) forwarded.splice(i, 1);
    },
    ...overrides,
  };
}

async function call(cmd: object, ops: PortControlOps): Promise<any> {
  const out = await handlePortCommand(Buffer.from(JSON.stringify(cmd)), ops);
  return JSON.parse(out.toString("utf8"));
}

describe("handlePortCommand", () => {
  it("lists forwarded ports", async () => {
    const ops = fakeOps();
    await ops.forward(5173);
    expect(await call({ cmd: "list" }, ops)).toEqual({
      ok: true,
      forwarded: [{ remotePort: 5173, localPort: 45173 }],
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

  it("passes hostPort and the ephemeral flag through to ops.forward", async () => {
    const calls: Array<[number, number | undefined, boolean | undefined]> = [];
    const ops = fakeOps({
      forward: async (remotePort, hostPort, ephemeral) => {
        calls.push([remotePort, hostPort, ephemeral]);
        return {
          address: "127.0.0.1",
          localPort: hostPort ?? 40000 + remotePort,
          remotePort,
        } as PortForwardBinding;
      },
    });
    // The nested login's pinned ephemeral request (see auth-login.ts).
    expect(
      await call({ cmd: "forward", port: 1455, hostPort: 1455, ephemeral: true }, ops),
    ).toEqual({ ok: true, remotePort: 1455, localPort: 1455 });
    expect(calls).toEqual([[1455, 1455, true]]);
    // A non-boolean flag is rejected before ops is touched.
    expect((await call({ cmd: "forward", port: 3000, ephemeral: "yes" }, ops)).ok).toBe(false);
    expect(calls).toHaveLength(1);
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

    const fwd = await runCli(cliPath, ["ports", "add", "5173"]);
    expect(fwd.code).toBe(0);
    expect(fwd.stdout).toContain("localhost:45173 -> guest 5173");
    expect(ops.calls).toEqual([{ remotePort: 5173 }]);

    // Docker publish order: HOST:GUEST pins the host side.
    const pinned = await runCli(cliPath, ["ports", "add", "45174:5174"]);
    expect(pinned.code).toBe(0);
    expect(pinned.stdout).toContain("localhost:45174 -> guest 5174");
    expect(ops.calls.at(-1)).toEqual({ remotePort: 5174, hostPort: 45174 });

    const list = await runCli(cliPath, ["ports"]);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain("localhost:45173 -> 5173");
    expect(list.stdout).toContain("localhost:45174 -> 5174");

    // rm keys on the guest port, and accepts a pasted HOST:GUEST mapping.
    const un = await runCli(cliPath, ["ports", "rm", "45174:5174"]);
    expect(un.code).toBe(0);
    expect(ops.unforwarded).toEqual([5174]);

    const all = await runCli(cliPath, ["ports", "rm", "--all"]);
    expect(all.code).toBe(0);
    expect(all.stdout).toContain("Stopped forwarding 5173.");
    expect(ops.unforwarded).toEqual([5174, 5173]);

    // The old flat spellings are gone, and bad input exits with usage.
    expect((await runCli(cliPath, ["forward", "5173"])).code).toBe(2);
    expect((await runCli(cliPath, ["ports", "add"])).code).toBe(2);
    expect((await runCli(cliPath, ["ports", "add", "5173:80:90"])).code).toBe(2);
  });
});
