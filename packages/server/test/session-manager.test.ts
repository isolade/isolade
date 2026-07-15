import { describe, expect, it } from "bun:test";
import type { WSContext } from "hono/ws";
import type { SandboxClient } from "../src/sandbox-client";
import { PersistentSessionManager } from "../src/session-manager";

function stubWs() {
  const closes: { code?: number; reason?: string }[] = [];
  const ws = {
    send: () => {},
    close: (code?: number, reason?: string) => {
      closes.push({ code, reason });
    },
  } as unknown as WSContext;
  return { ws, closes };
}

function clientWith(execInteractive: SandboxClient["execInteractive"]): SandboxClient {
  return { execInteractive } as unknown as SandboxClient;
}

describe("PersistentSessionManager", () => {
  it("closes attached clients with 1011 and the failure reason when exec rejects", async () => {
    let rejectExec!: (err: Error) => void;
    const manager = new PersistentSessionManager(
      clientWith(
        () =>
          new Promise((_, reject) => {
            rejectExec = reject;
          }),
      ),
    );
    const { ws, closes } = stubWs();

    manager.start("t1", "vm1", "/bin/sh");
    manager.attach("t1", ws);

    rejectExec(new Error("ttyd WS handshake timed out after 10000ms"));
    await new Promise((r) => setTimeout(r, 0));

    expect(closes).toEqual([
      {
        code: 1011,
        reason: "terminal failed: ttyd WS handshake timed out after 10000ms",
      },
    ]);
    expect(manager.has("t1")).toBe(false);
  });

  it("closes attached clients with 1000 when the shell exits normally", async () => {
    let resolveExec!: (v: { exitCode: number }) => void;
    const manager = new PersistentSessionManager(
      clientWith(
        () =>
          new Promise((resolve) => {
            resolveExec = resolve;
          }),
      ),
    );
    const { ws, closes } = stubWs();

    manager.start("t1", "vm1", "/bin/sh");
    manager.attach("t1", ws);

    resolveExec({ exitCode: 0 });
    await new Promise((r) => setTimeout(r, 0));

    expect(closes).toEqual([{ code: 1000, reason: "session ended" }]);
    expect(manager.has("t1")).toBe(false);
  });
});
