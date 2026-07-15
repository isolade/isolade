import { afterEach, describe, expect, it } from "bun:test";
import type { Socket, UnixSocketListener } from "bun";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ExecResult, ExecStreamOpts, SandboxApi } from "../src/sandbox-client";
import { SandboxReverseForwarder } from "../src/sandbox-forward";

// A SandboxApi implementing only what the reverse forwarder touches: writeFile
// (captures the acceptor + relay scripts), exec (the pkill, a no-op), and
// execStream (runs the REAL guest scripts as local `node` subprocesses).
// Everything else throws. This drives both guest halves (the acceptor and the
// per-connection relay) end to end, faking only the microsandbox transport
// that would carry stdio between guest and host.
class NodeScriptSandbox {
  private files = new Map<string, Buffer>();
  private dir = mkdtempSync(join(tmpdir(), "sbxfwd-test-"));
  private seq = 0;
  running = 0;

  cleanup() {
    rmSync(this.dir, { recursive: true, force: true });
  }

  writeFile(_vmId: string, path: string, content: Buffer): Promise<void> {
    this.files.set(path, content);
    return Promise.resolve();
  }

  exec(): Promise<ExecResult> {
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }

  async execStream(
    _vmId: string,
    command: string,
    opts: ExecStreamOpts,
  ): Promise<{ exitCode: number }> {
    const m = command.match(/^node (\S+)(?: (\d+))?$/);
    if (!m) throw new Error(`unexpected exec command: ${command}`);
    const script = this.files.get(m[1]!);
    if (!script) throw new Error(`script not written before exec: ${m[1]}`);
    const scriptPath = join(this.dir, `s${this.seq++}.cjs`);
    writeFileSync(scriptPath, script);
    const argv = m[2] ? ["node", scriptPath, m[2]] : ["node", scriptPath];

    this.running++;
    const proc = Bun.spawn(argv, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    const onAbort = () => proc.kill();
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    (async () => {
      for await (const chunk of opts.stdin) proc.stdin.write(chunk);
      proc.stdin.end();
    })().catch(() => {});

    const pump = (async () => {
      for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
        opts.stdout(Buffer.from(chunk));
      }
    })().catch(() => {});

    const exitCode = await proc.exited;
    await pump; // ordered transport: all stdout before exit
    opts.signal?.removeEventListener("abort", onAbort);
    this.running--;
    return { exitCode };
  }
}

function sandbox(): SandboxApi & { cleanup(): void; running: number } {
  return new NodeScriptSandbox() as unknown as SandboxApi & {
    cleanup(): void;
    running: number;
  };
}

// Stand-in for createSandboxApp served on a host unix socket: an upper-casing
// echo server. The reverse forward should route guest requests here and pipe
// the response back.
function startHostUnixServer(socketPath: string): UnixSocketListener<unknown> {
  return Bun.listen({
    unix: socketPath,
    socket: {
      data(s, d) {
        s.write(Buffer.from(d.toString("utf8").toUpperCase()));
      },
    },
  });
}

// A loopback port that's free right now, for the acceptor to bind. The tests
// must NOT use the production GUEST_SANDBOX_PORT: run inside an expose_sandbox
// guest (developing isolade within isolade, the point of this feature), the
// REAL acceptor already holds that port and the suite would collide with it.
function freePort(): number {
  const l = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  const port = l.port;
  l.stop(true);
  return port;
}

// The acceptor binds its port asynchronously in a subprocess, so retry until it's
// up (or time out).
async function waitForAcceptor(port: number, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const s = await Bun.connect({
        hostname: "127.0.0.1",
        port,
        socket: {
          data() {},
          open(sock) {
            sock.end();
          },
        },
      });
      s.end();
      return;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

// Send `payload` to the guest-side acceptor port and resolve the first bytes
// echoed back through the whole tunnel.
function roundTrip(port: number, payload: string, timeoutMs = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("round-trip timed out")), timeoutMs);
    let client: Socket;
    void Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(s) {
          client = s;
          s.write(payload);
        },
        data(_s, d) {
          clearTimeout(timer);
          client.end();
          resolve(d.toString("utf8"));
        },
        error(_s, e) {
          clearTimeout(timer);
          reject(e);
        },
      },
    }).catch(reject);
  });
}

describe("SandboxReverseForwarder", () => {
  const forwarders: SandboxReverseForwarder[] = [];
  const sandboxes: Array<{ cleanup(): void }> = [];
  const servers: UnixSocketListener<unknown>[] = [];
  const sockPaths: string[] = [];

  afterEach(async () => {
    for (const f of forwarders.splice(0)) f.teardown("vm1");
    for (const s of servers.splice(0)) s.stop(true);
    for (const s of sandboxes.splice(0)) s.cleanup();
    for (const p of sockPaths.splice(0)) rmSync(p, { force: true });
    // Let killed acceptor/relay subprocesses wind down before the next test.
    await new Promise((r) => setTimeout(r, 150));
  });

  function hostSocketPath(): string {
    const p = join(mkdtempSync(join(tmpdir(), "sbxfwd-host-")), "sandbox.sock");
    sockPaths.push(p);
    return p;
  }

  it("routes guest requests to the host unix socket and pipes the reply back", async () => {
    const sockPath = hostSocketPath();
    servers.push(startHostUnixServer(sockPath));
    const sb = sandbox();
    sandboxes.push(sb);
    const port = freePort();
    const fwd = new SandboxReverseForwarder(sb, sockPath, port);
    forwarders.push(fwd);

    fwd.setup("vm1");
    await waitForAcceptor(port);

    expect(await roundTrip(port, "hello")).toBe("HELLO");
    // A second connection over the same forward works (fresh relay per conn).
    expect(await roundTrip(port, "world")).toBe("WORLD");
  });

  it("teardown stops the acceptor so the guest port stops accepting", async () => {
    const sockPath = hostSocketPath();
    servers.push(startHostUnixServer(sockPath));
    const sb = sandbox();
    sandboxes.push(sb);
    const port = freePort();
    const fwd = new SandboxReverseForwarder(sb, sockPath, port);
    forwarders.push(fwd);

    fwd.setup("vm1");
    await waitForAcceptor(port);
    expect(await roundTrip(port, "up")).toBe("UP");

    fwd.teardown("vm1");
    // The acceptor subprocess is killed on abort, so the port should stop
    // accepting. Give the kill a moment, then a connect+send must not echo.
    await new Promise((r) => setTimeout(r, 200));
    await expect(roundTrip(port, "down", 600)).rejects.toThrow();
    expect((sb as unknown as NodeScriptSandbox).running).toBe(0);
  });

  it("setup is idempotent per VM (one acceptor)", async () => {
    const sockPath = hostSocketPath();
    servers.push(startHostUnixServer(sockPath));
    const sb = sandbox();
    sandboxes.push(sb);
    const port = freePort();
    const fwd = new SandboxReverseForwarder(sb, sockPath, port);
    forwarders.push(fwd);

    fwd.setup("vm1");
    fwd.setup("vm1"); // no-op: must not spawn a second acceptor (port conflict)
    await waitForAcceptor(port);
    expect(await roundTrip(port, "ok")).toBe("OK");
  });
});
