import { describe, expect, it } from "bun:test";
import { CodexManager } from "../src/chat/codex-manager";
import type { SandboxClient } from "../src/sandbox-client";

// Minimal SandboxClient stand-in: captures each exec-stream's stdout callback
// and hands back a controllable exit promise so tests can simulate the
// app-server replying, exiting, or dropping its connection.
class FakeSandboxClient {
  readonly stdout: ((chunk: Buffer) => void)[] = [];
  readonly settle: {
    resolve: (v: { exitCode: number }) => void;
    reject: (e: Error) => void;
  }[] = [];
  readonly requests: Array<{
    vmId: string;
    command: string;
    message: { id: number; method: string; params: unknown };
  }> = [];

  execStream(
    vmId: string,
    command: string,
    opts: { stdin?: AsyncIterable<Buffer>; stdout: (chunk: Buffer) => void },
  ): Promise<{ exitCode: number }> {
    this.stdout.push(opts.stdout);
    if (opts.stdin) {
      void (async () => {
        for await (const chunk of opts.stdin!) {
          for (const line of chunk.toString("utf8").split("\n")) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            this.requests.push({ vmId, command, message: JSON.parse(trimmed) });
          }
        }
      })();
    }
    return new Promise((resolve, reject) => {
      this.settle.push({ resolve, reject });
    });
  }
}

// Each CodexConnection starts reqId at 0 and `initialize` is the first request,
// so its id is always 1.
function ackInitialize(client: FakeSandboxClient, connectionIndex: number) {
  client.stdout[connectionIndex]!(
    Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }) + "\n"),
  );
}

const flush = () => new Promise((r) => setTimeout(r, 0));

async function waitForRequests(client: FakeSandboxClient, count: number) {
  for (let i = 0; i < 20; i++) {
    if (client.requests.length >= count) return;
    await flush();
  }
  throw new Error(`timed out waiting for ${count} request(s)`);
}

describe("CodexManager connection lifecycle", () => {
  it("reuses a live connection for the same VM", async () => {
    const client = new FakeSandboxClient();
    const mgr = new CodexManager(client as unknown as SandboxClient);

    const p1 = mgr.getOrCreate("vm");
    ackInitialize(client, 0);
    const conn1 = await p1;

    const conn2 = await mgr.getOrCreate("vm");
    expect(conn2).toBe(conn1);
    expect(client.stdout.length).toBe(1); // no second connection opened
  });

  it("evicts and reconnects after the stream drops (rejects, not just resolves)", async () => {
    const client = new FakeSandboxClient();
    const mgr = new CodexManager(client as unknown as SandboxClient);

    const p1 = mgr.getOrCreate("vm");
    ackInitialize(client, 0);
    const conn1 = await p1;

    // Simulate a premature drop. exec-stream now rejects rather than
    // resolving exitCode 0. The cached entry must still be evicted.
    client.settle[0]!.reject(new Error("closed before the command finished"));
    await flush();

    const p2 = mgr.getOrCreate("vm");
    ackInitialize(client, 1);
    const conn2 = await p2;
    expect(conn2).not.toBe(conn1);
    expect(client.stdout.length).toBe(2);
  });

  it("does not poison the cache when initialize fails", async () => {
    const client = new FakeSandboxClient();
    const mgr = new CodexManager(client as unknown as SandboxClient);

    const p1 = mgr.getOrCreate("vm");
    client.stdout[0]!(
      Buffer.from(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: { message: "init failed" },
        }) + "\n",
      ),
    );
    await expect(p1).rejects.toThrow("init failed");
    await flush();

    // A poisoned cache would re-await the same rejected `ready`. Instead the
    // entry is evicted and the next call opens a fresh connection.
    const p2 = mgr.getOrCreate("vm");
    ackInitialize(client, 1);
    await expect(p2).resolves.toBeDefined();
    expect(client.stdout.length).toBe(2);
  });

  it("refreshes auth in the live app-server via account/read", async () => {
    const client = new FakeSandboxClient();
    const mgr = new CodexManager(client as unknown as SandboxClient);

    const refresh = mgr.refreshAuth("vm");
    ackInitialize(client, 0);
    await waitForRequests(client, 2);

    expect(client.requests[1]).toMatchObject({
      vmId: "vm",
      message: {
        id: 2,
        method: "account/read",
        params: { refreshToken: true },
      },
    });

    client.stdout[0]!(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 2, result: {} }) + "\n"));
    await expect(refresh).resolves.toBeUndefined();
  });
});
