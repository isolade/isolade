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
  it("reuses one process across turns and changes model and effort live", async () => {
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

    // The context endpoint also uses the same process instead of launching a
    // separate resumed CLI.
    const context = backend.probeContext({
      vmId: "vm",
      chatId: "c",
      model: "claude-sonnet-4-6",
      effort: "high",
      sessionId: "s",
    });
    await tick();
    proc(procs, 0).succeedControl(proc(procs, 0).controls("get_context_usage")[0], {
      totalTokens: 20_000,
      rawMaxTokens: 200_000,
      percentage: 10,
      categories: [],
    });
    expect(await context).toMatchObject({ available: true, totalTokens: 20_000 });
    expect(procs.length).toBe(1);

    // Turn 3: model and effort switch through controls on the SAME process.
    const p3 = backend.sendMessage({
      ...baseTurn,
      effort: "max",
      message: "switch",
      model: "claude-opus-4-8",
      sessionId: "s",
    });
    await tick();
    const modelControl = proc(procs, 0).controls("set_model")[0];
    proc(procs, 0).succeedControl(modelControl);
    await tick();
    const effortControl = proc(procs, 0).controls("apply_flag_settings")[0];
    proc(procs, 0).succeedControl(effortControl);
    await tick();
    proc(procs, 0).emit({ type: "result", result: "three" });
    expect((await p3).content).toBe("three");
    expect(procs.length).toBe(1);
    expect(modelControl.request).toEqual({
      subtype: "set_model",
      model: "claude-opus-4-8",
    });
    expect(effortControl.request).toEqual({
      subtype: "apply_flag_settings",
      settings: { effortLevel: "max" },
    });
    expect(proc(procs, 0).userMessages().length).toBe(3);

    for (const p of procs) p.exit(0);
    await tick();
  });

  it("falls back to a resumed process when a live configuration control fails", async () => {
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

    const p2 = backend.sendMessage({
      ...baseTurn,
      message: "switch",
      model: "claude-opus-4-8",
      sessionId: "s",
    });
    await tick();
    proc(procs, 0).failControl(proc(procs, 0).controls("set_model")[0], "unsupported");
    await tick();
    proc(procs, 1).emit({ type: "result", result: "two" });

    expect((await p2).content).toBe("two");
    expect(procs.length).toBe(2);
    expect(proc(procs, 1).command).toContain("--model claude-opus-4-8");
    expect(proc(procs, 1).command).toContain("--resume s");
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

  it("reports the session id and assistant-message anchors through onMeta", async () => {
    const { client, procs } = liveClient();
    const backend = new ClaudeBackend(client, fakeChatManager(), {
      idleMs: 60_000,
    });

    const metas: Array<{ sessionId?: string; anchorId?: string }> = [];
    const p1 = backend.sendMessage({
      ...baseTurn,
      message: "hi",
      model: "claude-sonnet-4-6",
      onMeta: (m) => metas.push(m),
    });
    proc(procs, 0).emit({ type: "system", subtype: "init", session_id: "s" });
    // One assistant echo per tool roundtrip: the LAST uuid is the turn's
    // anchor (the turn service keeps the latest).
    proc(procs, 0).emit({ type: "assistant", uuid: "uuid-mid", message: {} });
    proc(procs, 0).emit({ type: "assistant", uuid: "uuid-final", message: {} });
    proc(procs, 0).emit({ type: "result", result: "done" });
    await p1;

    expect(metas).toContainEqual({ sessionId: "s" });
    expect(metas.filter((m) => m.anchorId).map((m) => m.anchorId)).toEqual([
      "uuid-mid",
      "uuid-final",
    ]);
    proc(procs, 0).exit(0);
    await tick();
  });

  it("fork turns retire the live process and launch with resume-at + fork flags", async () => {
    const { client, procs } = liveClient();
    const backend = new ClaudeBackend(client, fakeChatManager(), {
      idleMs: 60_000,
    });

    // Establish a warm process on session s1.
    const p1 = backend.sendMessage({
      ...baseTurn,
      message: "hi",
      model: "claude-sonnet-4-6",
    });
    proc(procs, 0).emit({ type: "system", subtype: "init", session_id: "s1" });
    proc(procs, 0).emit({ type: "result", result: "one" });
    await p1;

    // An edit turn: fork s1 at an anchored assistant message. The warm
    // process is positioned at s1's tail, so it must NOT be reused.
    const metas: Array<{ sessionId?: string; anchorId?: string }> = [];
    const p2 = backend.sendMessage({
      ...baseTurn,
      message: "edited",
      model: "claude-sonnet-4-6",
      sessionId: "s1",
      fork: { anchorId: "uuid-anchor" },
      onMeta: (m) => metas.push(m),
    });
    expect(procs.length).toBe(2);
    expect(proc(procs, 1).command).toContain("--resume s1");
    expect(proc(procs, 1).command).toContain("--resume-session-at uuid-anchor");
    expect(proc(procs, 1).command).toContain("--fork-session");
    // The CLI mints a new session id for the fork and reports it on init.
    proc(procs, 1).emit({ type: "system", subtype: "init", session_id: "s2" });
    proc(procs, 1).emit({ type: "result", result: "forked answer" });
    const result = await p2;
    expect(result.sessionId).toBe("s2");
    expect(metas).toContainEqual({ sessionId: "s2" });

    // A follow-up on the same chat reuses the forked process, no fork flags.
    const p3 = backend.sendMessage({
      ...baseTurn,
      message: "continue",
      model: "claude-sonnet-4-6",
      sessionId: "s2",
    });
    proc(procs, 1).emit({ type: "result", result: "three" });
    expect((await p3).content).toBe("three");
    expect(procs.length).toBe(2);

    for (const p of procs) p.exit(0);
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
