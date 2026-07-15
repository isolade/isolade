import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { type AddressInfo, createServer, type Server } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildRelayScript } from "../src/guest-relay";

// Tests the relay SCRIPT itself (the CJS program every transport injects into
// the guest) by running it under a local `node`, the same runtime the guest
// uses. The per-connection host plumbing around it (SocketPump backpressure,
// orderly close) is covered end to end by the server package's
// port-forwarder.test.ts. Here the subject is the script's dial behavior:
// which targets it reaches, in what order, and how it exits when none answer.

let dir: string;
let scriptPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "guest-relay-test-"));
  scriptPath = join(dir, "relay.cjs");
  writeFileSync(scriptPath, buildRelayScript());
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

// Machines can have IPv6 disabled, so skip the ::1-specific cases there rather
// than fail on environment. Bun.listen binds synchronously, so probe inline.
const hasV6Loopback = (() => {
  try {
    Bun.listen({ hostname: "::1", port: 0, socket: { data() {} } }).stop(true);
    return true;
  } catch {
    return false;
  }
})();

// Run the relay against `target`, write `input` to its stdin, and collect
// stdout until it exits: the exec-stream lifecycle, minus the transport.
async function runRelay(
  target: string | number,
  input: string,
): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn(["node", scriptPath, String(target)], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  proc.stdin.write(input);
  proc.stdin.end();
  const stdout = await new Response(proc.stdout as ReadableStream<Uint8Array>).text();
  const exitCode = await proc.exited;
  return { stdout, exitCode };
}

// An upper-casing echo server on the given host (or unix socket path). It is the
// stand-in for whatever the relay's target is. Returns the listener. Read the
// bound port from `.address()`.
function startEcho(where: { host: string } | { path: string }): Promise<Server> {
  const server = createServer((s) => {
    s.on("data", (d) => s.write(d.toString("utf8").toUpperCase()));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    const done = () => resolve(server);
    if ("path" in where) server.listen(where.path, done);
    else server.listen(0, where.host, done);
  });
}

describe("guest relay script", () => {
  const servers: Server[] = [];

  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
  });

  it("dials an IPv4-loopback TCP target", async () => {
    const echo = await startEcho({ host: "127.0.0.1" });
    servers.push(echo);
    const { stdout, exitCode } = await runRelay((echo.address() as AddressInfo).port, "hello");
    expect(stdout).toBe("HELLO");
    expect(exitCode).toBe(0);
  });

  it.skipIf(!hasV6Loopback)(
    "falls back to ::1 when the target listens on IPv6 loopback only",
    async () => {
      // The localhost default of modern dev servers (Vite/Astro/Next under
      // Node 17+ or Bun): getaddrinfo ranks ::1 first, the server binds only
      // that, the regression that motivated the two-family dial.
      const echo = await startEcho({ host: "::1" });
      servers.push(echo);
      const { stdout, exitCode } = await runRelay((echo.address() as AddressInfo).port, "hello");
      expect(stdout).toBe("HELLO");
      expect(exitCode).toBe(0);
    },
  );

  it("exits non-zero with no output when nothing listens on either family", async () => {
    const { stdout, exitCode } = await runRelay(65002, "x");
    expect(stdout).toBe("");
    expect(exitCode).toBe(1);
  });

  it("dials a unix-socket path target", async () => {
    const path = join(dir, "echo.sock");
    const echo = await startEcho({ path });
    servers.push(echo);
    const { stdout, exitCode } = await runRelay(path, "ttyd");
    expect(stdout).toBe("TTYD");
    expect(exitCode).toBe(0);
  });
});
