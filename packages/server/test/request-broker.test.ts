import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRequestBrokerScript, FrameReader, frameResponse } from "../src/request-broker";

// ---------------------------------------------------------------------------
// Framing helpers: pure, always run.
// ---------------------------------------------------------------------------

describe("FrameReader", () => {
  it("reassembles [len][payload] frames across arbitrary chunk boundaries", () => {
    const frames: string[] = [];
    const r = new FrameReader((p) => frames.push(p.toString()));
    const framed = (s: string) => {
      const body = Buffer.from(s);
      const hdr = Buffer.alloc(4);
      hdr.writeUInt32BE(body.length, 0);
      return Buffer.concat([hdr, body]);
    };
    const all = Buffer.concat([framed("hello"), framed("world!")]);
    // Feed one byte at a time to stress the accumulator.
    for (const b of all) r.push(Buffer.from([b]));
    expect(frames).toEqual(["hello", "world!"]);
  });
});

describe("frameResponse", () => {
  it("lays out [status:1][len:4][body]", () => {
    const f = frameResponse(0, Buffer.from("sig-bytes"));
    expect(f[0]).toBe(0);
    expect(f.readUInt32BE(1)).toBe("sig-bytes".length);
    expect(f.subarray(5).toString()).toBe("sig-bytes");
  });
});

// ---------------------------------------------------------------------------
// The in-VM broker script, run as a real node child. We play the host on its
// stdio, echoing each request back with an "ok:" prefix.
// ---------------------------------------------------------------------------

class BrokerHarness {
  dir = mkdtempSync(join(tmpdir(), "req-broker-"));
  sock = join(this.dir, "req.sock");
  private proc: ReturnType<typeof Bun.spawn>;

  constructor() {
    const file = join(this.dir, "broker.cjs");
    writeFileSync(file, buildRequestBrokerScript(this.sock));
    const proc = Bun.spawn(["node", file], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    this.proc = proc;
    const reader = new FrameReader((payload) => {
      proc.stdin.write(frameResponse(0, Buffer.concat([Buffer.from("ok:"), payload])));
      proc.stdin.flush();
    });
    void (async () => {
      for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
        reader.push(Buffer.from(chunk));
      }
    })().catch(() => {});
  }

  async ready(): Promise<void> {
    for (let i = 0; i < 200 && !existsSync(this.sock); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(existsSync(this.sock)).toBe(true);
  }

  cleanup() {
    this.proc.kill();
    rmSync(this.dir, { recursive: true, force: true });
  }
}

// One well-behaved request: connect, write, half-close (FIN), collect the
// reply. Uses Bun.connect + shutdown() because Bun's node:net client tears the
// socket down fully after end(), never seeing the reply, but the real clients
// (sign-shim, the isolade CLI) run under node in the guest, where end() is a
// clean half-close.
function request(sock: string, body: string, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => reject(new Error(`request "${body}" timed out`)), timeoutMs);
    void Bun.connect({
      unix: sock,
      socket: {
        open(s) {
          if (body.length > 0) s.write(body);
          s.shutdown();
        },
        data(_s, d) {
          chunks.push(Buffer.from(d));
        },
        close() {
          clearTimeout(timer);
          resolve(Buffer.concat(chunks).toString());
        },
        error(_s, e) {
          clearTimeout(timer);
          reject(e);
        },
      },
    }).catch((e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

describe("request broker script", () => {
  const harnesses: BrokerHarness[] = [];
  afterEach(() => {
    for (const h of harnesses.splice(0)) h.cleanup();
  });

  it("answers sequential requests in order", async () => {
    const h = new BrokerHarness();
    harnesses.push(h);
    await h.ready();
    expect(await request(h.sock, "one")).toBe("ok:one");
    expect(await request(h.sock, "two")).toBe("ok:two");
  });

  it("keeps serving after a client dies without completing its request", async () => {
    const h = new BrokerHarness();
    harnesses.push(h);
    await h.ready();

    // A client that connects, writes a fragment, and fully closes without
    // waiting for the reply must not claim the single-flight slot forever.
    await new Promise<void>((resolve) => {
      void Bun.connect({
        unix: h.sock,
        socket: {
          open(s) {
            s.write("half-a-request");
            setTimeout(() => {
              s.end();
              resolve();
            }, 20);
          },
          data() {},
          error() {},
        },
      });
    });

    expect(await request(h.sock, "after")).toBe("ok:after");
  });

  it("round-trips an empty request and keeps serving", async () => {
    const h = new BrokerHarness();
    harnesses.push(h);
    await h.ready();
    // FIN with no payload, the degenerate request the broker must still
    // answer (and clear the single-flight slot for) rather than wedge on.
    expect(await request(h.sock, "")).toBe("ok:");
    expect(await request(h.sock, "after-empty")).toBe("ok:after-empty");
  });

  it("serves queued requests from concurrent clients", async () => {
    const h = new BrokerHarness();
    harnesses.push(h);
    await h.ready();
    const replies = await Promise.all([
      request(h.sock, "a"),
      request(h.sock, "b"),
      request(h.sock, "c"),
    ]);
    expect(replies.toSorted()).toEqual(["ok:a", "ok:b", "ok:c"]);
  });
});
