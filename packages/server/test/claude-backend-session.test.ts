import { describe, expect, it } from "bun:test";
import { ClaudeBackend } from "../src/chat/claude-backend";
import type { ChatManager } from "../src/chats";
import type { SandboxClient } from "../src/sandbox-client";
import { FakeProc, tick } from "./fake-proc";

function fakeChatManager(): ChatManager {
  return { updateSessionId: () => {} } as unknown as ChatManager;
}

// A sandbox client that mints a fresh FakeProc per execStream call, so the test
// can observe how many processes the backend spins up across turns.
function liveClient() {
  const procs: FakeProc[] = [];
  const client = {
    execStream: (vmId: string, command: string, opts: any) => {
      const newProc = new FakeProc();
      procs.push(newProc);
      return newProc.execStream(vmId, command, opts);
    },
  } as unknown as SandboxClient;
  return { client, procs };
}

const baseTurn = {
  vmId: "vm",
  chatId: "c",
  effort: "high" as const,
  onDelta: () => {},
  onEvent: () => {},
};

describe("ClaudeBackend session lifecycle", () => {
  it("reuses one process across turns and starts a fresh one on model switch", async () => {
    const { client, procs } = liveClient();
    const backend = new ClaudeBackend(client, fakeChatManager(), {
      idleMs: 60_000,
    });

    // Turn 1: new chat, no resume id.
    const p1 = backend.sendMessage({
      ...baseTurn,
      message: "hi",
      model: "claude-sonnet-4-6",
    });
    proc(procs, 0).emit({ type: "system", subtype: "init", session_id: "s" });
    proc(procs, 0).emit({ type: "result", result: "one" });
    expect((await p1).content).toBe("one");
    expect(procs.length).toBe(1);
    expect(proc(procs, 0).command).toContain("--input-format stream-json");
    expect(proc(procs, 0).command).not.toContain("--resume");

    // Turn 2: same model → SAME process (no new execStream).
    const p2 = backend.sendMessage({
      ...baseTurn,
      message: "more",
      model: "claude-sonnet-4-6",
      sessionId: "s",
    });
    proc(procs, 0).emit({ type: "result", result: "two" });
    expect((await p2).content).toBe("two");
    expect(procs.length).toBe(1);
    expect(proc(procs, 0).userMessages().length).toBe(2);

    // Turn 3: model switch → NEW process, resuming the same conversation.
    const p3 = backend.sendMessage({
      ...baseTurn,
      message: "switch",
      model: "claude-opus-4-8",
      sessionId: "s",
    });
    proc(procs, 1).emit({ type: "result", result: "three" });
    expect((await p3).content).toBe("three");
    expect(procs.length).toBe(2);
    expect(proc(procs, 1).command).toContain("--model claude-opus-4-8");
    expect(proc(procs, 1).command).toContain("--resume s");

    // The old process was asked to shut down (stdin closed). Let it exit.
    for (const p of procs) p.exit(0);
    await tick();
  });

  it("starts a fresh process when the previous one died (self-heal)", async () => {
    const { client, procs } = liveClient();
    const backend = new ClaudeBackend(client, fakeChatManager(), {
      idleMs: 60_000,
    });

    const p1 = backend.sendMessage({
      ...baseTurn,
      message: "hi",
      model: "claude-sonnet-4-6",
    });
    proc(procs, 0).emit({ type: "system", subtype: "init", session_id: "s" });
    proc(procs, 0).emit({ type: "result", result: "one" });
    await p1;

    // The VM (and its process) dies between turns.
    proc(procs, 0).exit(0);
    await tick();

    // Next turn detects the dead session and starts a new process with --resume.
    const p2 = backend.sendMessage({
      ...baseTurn,
      message: "again",
      model: "claude-sonnet-4-6",
      sessionId: "s",
    });
    proc(procs, 1).emit({ type: "result", result: "two" });
    expect((await p2).content).toBe("two");
    expect(procs.length).toBe(2);
    expect(proc(procs, 1).command).toContain("--resume s");
    proc(procs, 1).exit(0);
    await tick();
  });

  it("disposeChat shuts down the chat's process", async () => {
    const { client, procs } = liveClient();
    const backend = new ClaudeBackend(client, fakeChatManager(), {
      idleMs: 60_000,
    });

    const p1 = backend.sendMessage({
      ...baseTurn,
      message: "hi",
      model: "claude-sonnet-4-6",
    });
    proc(procs, 0).emit({ type: "result", result: "one" });
    await p1;

    backend.disposeChat("c");
    proc(procs, 0).exit(0);
    await tick();

    // After disposal a new turn must start a brand-new process.
    const p2 = backend.sendMessage({
      ...baseTurn,
      message: "again",
      model: "claude-sonnet-4-6",
      sessionId: "s",
    });
    proc(procs, 1).emit({ type: "result", result: "two" });
    expect((await p2).content).toBe("two");
    expect(procs.length).toBe(2);
    proc(procs, 1).exit(0);
    await tick();
  });
});

// Small helper so a turn's events can be emitted right after kicking it off.
// The backend creates the process synchronously inside sendMessage, before its
// first await, so procs[i] exists by the time control returns here.
function proc(procs: FakeProc[], i: number): FakeProc {
  const p = procs[i];
  if (!p) throw new Error(`process ${i} not created yet (have ${procs.length})`);
  return p;
}
