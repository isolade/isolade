import { afterEach, describe, expect, it } from "bun:test";
import { type AddressInfo, createServer, type Server } from "node:net";
import type { Socket, TCPSocketListener } from "bun";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ExecRelayForwarder } from "../src/port-forwarder";
import type { ExecStreamOpts, SandboxApi } from "../src/sandbox-client";

// A SandboxApi that implements only what the forwarder touches: writeFile
// (captures the relay script) and execStream (runs the REAL relay script via a
// local `node` subprocess). Everything else throws, so the forwarder must not
// reach for it. This exercises both halves of a forward end to end: the actual
// guest relay code and the host listener, faking only the microsandbox
// transport that would carry stdio between them.
class NodeRelaySandbox {
  private files = new Map<string, Buffer>();
  private dir = mkdtempSync(join(tmpdir(), "relay-test-"));
  running = 0;

  cleanup() {
    rmSync(this.dir, { recursive: true, force: true });
  }

  writeFile(_vmId: string, path: string, content: Buffer): Promise<void> {
    this.files.set(path, content);
    return Promise.resolve();
  }

  async execStream(
    _vmId: string,
    command: string,
    opts: ExecStreamOpts,
  ): Promise<{ exitCode: number }> {
    const m = command.match(/^node (\S+) (\d+)$/);
    if (!m) throw new Error(`unexpected exec command: ${command}`);
    const script = this.files.get(m[1]!);
    if (!script) throw new Error(`relay script not written before exec: ${m[1]}`);
    const scriptPath = join(this.dir, "relay.cjs");
    writeFileSync(scriptPath, script);

    this.running++;
    const proc = Bun.spawn(["node", scriptPath, m[2]!], {
      stdin: "pipe",
      stdout: "pipe",
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
    // The real transport (an ordered websocket) delivers every stdout frame
    // before the exit message, so mirror that here.
    await pump;
    opts.signal?.removeEventListener("abort", onAbort);
    this.running--;
    return { exitCode };
  }
}

function sandbox(): SandboxApi & { cleanup(): void; running: number } {
  return new NodeRelaySandbox() as unknown as SandboxApi & {
    cleanup(): void;
    running: number;
  };
}

// Stand-in for a user's server bound to guest loopback: an upper-casing echo
// server. Its port is the "remote" port the forward targets. `hostname` picks
// the loopback family. A ::1-only server is what "localhost" dev servers
// (Vite/Astro/Next on Node 17+/Bun) actually bind.
function startEchoServer(hostname = "127.0.0.1"): TCPSocketListener {
  return Bun.listen({
    hostname,
    port: 0,
    socket: {
      data(s, d) {
        s.write(Buffer.from(d.toString("utf8").toUpperCase()));
      },
    },
  });
}

// Machines can have IPv6 disabled, so skip the ::1 case there rather than fail
// on environment. Bun.listen binds synchronously, so probe inline.
const hasV6Loopback = (() => {
  try {
    Bun.listen({ hostname: "::1", port: 0, socket: { data() {} } }).stop(true);
    return true;
  } catch {
    return false;
  }
})();

// Connect to the host listener and count bytes until the far side closes,
// the read pattern of a close-delimited response (no length header).
function collectUntilClose(port: number, timeoutMs = 15000): Promise<number> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const timer = setTimeout(
      () => reject(new Error(`collect timed out after ${total} bytes`)),
      timeoutMs,
    );
    void Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        data(_s, d) {
          total += d.length;
        },
        close() {
          clearTimeout(timer);
          resolve(total);
        },
        error(_s, e) {
          clearTimeout(timer);
          reject(e);
        },
      },
    }).catch(reject);
  });
}

// Open a client to the host listener, send `payload`, resolve the first bytes
// echoed back. Rejects on timeout so a broken forward fails fast.
function roundTrip(port: number, payload: string, timeoutMs = 5000): Promise<string> {
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

describe("ExecRelayForwarder", () => {
  const echoServers: TCPSocketListener[] = [];
  const sandboxes: Array<{ cleanup(): void }> = [];

  afterEach(() => {
    for (const s of echoServers.splice(0)) s.stop(true);
    for (const s of sandboxes.splice(0)) s.cleanup();
  });

  it("relays bytes host→guest-loopback→host and reports the listener port", async () => {
    const echo = startEchoServer();
    echoServers.push(echo);
    const sb = sandbox();
    sandboxes.push(sb);
    const fwd = new ExecRelayForwarder(sb);

    const binding = await fwd.open("vm1", echo.port);
    expect(binding).toEqual({
      address: "127.0.0.1",
      localPort: binding.localPort,
      remotePort: echo.port,
    });
    expect(binding.localPort).toBeGreaterThan(0);
    expect(binding.localPort).not.toBe(echo.port);

    expect(await roundTrip(binding.localPort, "hello")).toBe("HELLO");
    // A second connection over the same forward works (fresh exec per conn).
    expect(await roundTrip(binding.localPort, "world")).toBe("WORLD");
  });

  it.skipIf(!hasV6Loopback)("reaches a server bound to ::1 only", async () => {
    // The relay dials 127.0.0.1, gets refused, and must fall back to ::1,
    // otherwise a `localhost`-default dev server yields the blank-preview
    // symptom: connection accepted on the host, closed with zero bytes.
    const echo = startEchoServer("::1");
    echoServers.push(echo);
    const sb = sandbox();
    sandboxes.push(sb);
    const fwd = new ExecRelayForwarder(sb);

    const binding = await fwd.open("vm1", echo.port);
    expect(await roundTrip(binding.localPort, "hello")).toBe("HELLO");
  });

  it("delivers a large close-delimited response intact", async () => {
    // A node:net server (buffers writes internally) that sends 4 MiB and
    // closes: a file download with no content-length, delimited only by the
    // close. Every byte must arrive: the relay flushes stdout before exiting
    // and the host flushes its drain backlog before end(), so nothing of the
    // tail is lost to the guest socket closing first.
    const blob = 4 * 1024 * 1024;
    const server: Server = createServer((s) => s.end(Buffer.alloc(blob, 0x61)));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      const sb = sandbox();
      sandboxes.push(sb);
      const fwd = new ExecRelayForwarder(sb);
      const binding = await fwd.open("vm1", port);
      expect(await collectUntilClose(binding.localPort, 30000)).toBe(blob);
    } finally {
      server.close();
    }
  }, 40000);

  it("coalesces concurrent open() calls for the same (vm, remotePort)", async () => {
    const echo = startEchoServer();
    echoServers.push(echo);
    const sb = sandbox();
    sandboxes.push(sb);
    const fwd = new ExecRelayForwarder(sb);

    // Both calls race past the "already open?" check; they must share one
    // listener rather than leaking the loser's.
    const [a, b] = await Promise.all([fwd.open("vm1", echo.port), fwd.open("vm1", echo.port)]);
    expect(b.localPort).toBe(a.localPort);
    expect(fwd.list("vm1")).toEqual([a]);
    expect(await roundTrip(a.localPort, "hi")).toBe("HI");
  });

  it("is idempotent per (vm, remotePort) and tracks open forwards", async () => {
    const echo = startEchoServer();
    echoServers.push(echo);
    const sb = sandbox();
    sandboxes.push(sb);
    const fwd = new ExecRelayForwarder(sb);

    const a = await fwd.open("vm1", echo.port);
    const b = await fwd.open("vm1", echo.port);
    expect(b.localPort).toBe(a.localPort);
    expect(fwd.list("vm1")).toEqual([a]);
  });

  it("close() stops the listener; closeAll() clears the VM", async () => {
    const echo = startEchoServer();
    echoServers.push(echo);
    const sb = sandbox();
    sandboxes.push(sb);
    const fwd = new ExecRelayForwarder(sb);

    const binding = await fwd.open("vm1", echo.port);
    await roundTrip(binding.localPort, "up"); // works while open
    fwd.close("vm1", echo.port);
    expect(fwd.list("vm1")).toEqual([]);
    await expect(roundTrip(binding.localPort, "down", 500)).rejects.toThrow();

    // closeAll on a fresh forward tears everything down.
    const b2 = await fwd.open("vm1", echo.port);
    await roundTrip(b2.localPort, "again");
    fwd.closeAll("vm1");
    expect(fwd.list("vm1")).toEqual([]);
  });

  it("pins the requested host port, and reopens pinned over an ephemeral forward", async () => {
    const echo = startEchoServer();
    echoServers.push(echo);
    const sb = sandbox();
    sandboxes.push(sb);
    const fwd = new ExecRelayForwarder(sb);

    // An unpinned forward exists on an ephemeral port…
    const ephemeral = await fwd.open("vm1", echo.port);
    // …then a pinned request for the same guest port must NOT be satisfied by
    // it: the forward is reopened on the exact requested host port.
    const probe = startEchoServer(); // just to find a free port number
    const pin = probe.port;
    probe.stop(true);
    const pinned = await fwd.open("vm1", echo.port, pin);
    expect(pinned.localPort).toBe(pin);
    expect(fwd.list("vm1")).toEqual([pinned]);
    expect(pinned.localPort).not.toBe(ephemeral.localPort);
    expect(await roundTrip(pin, "pinned")).toBe("PINNED");

    // A later unpinned open returns the existing (pinned) forward untouched.
    expect((await fwd.open("vm1", echo.port)).localPort).toBe(pin);
  });

  it("a colliding pinned bind throws and leaves the existing forward intact", async () => {
    const echo = startEchoServer();
    echoServers.push(echo);
    const sb = sandbox();
    sandboxes.push(sb);
    const fwd = new ExecRelayForwarder(sb);

    const before = await fwd.open("vm1", echo.port);
    // A port that is definitely taken: the echo server's own.
    const taken = startEchoServer();
    echoServers.push(taken);
    await expect(fwd.open("vm1", echo.port, taken.port)).rejects.toThrow();
    // The prior forward survived the failed pin and still works.
    expect(fwd.list("vm1")).toEqual([before]);
    expect(await roundTrip(before.localPort, "still up")).toBe("STILL UP");
  });

  it("closes the client socket when the guest relay can't reach the target", async () => {
    // No echo server for this port → the guest relay's connect fails and it
    // exits non-zero, which must close the host-side client socket.
    const sb = sandbox();
    sandboxes.push(sb);
    const fwd = new ExecRelayForwarder(sb);
    const deadPort = 65001;
    const binding = await fwd.open("vm1", deadPort);
    // The connection opens (host listener is up) then closes with no data.
    // roundTrip waits for data that never comes, so it times out, but the
    // relay subprocess must have exited rather than leaking.
    await expect(roundTrip(binding.localPort, "x", 500)).rejects.toThrow();
    // Give the finally() a tick to run, then assert no relay is still running.
    await new Promise((r) => setTimeout(r, 100));
    expect((sb as unknown as NodeRelaySandbox).running).toBe(0);
  });
});
