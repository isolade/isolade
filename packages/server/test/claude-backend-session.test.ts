import { describe, expect, it } from "bun:test";
import type { ModelBilling } from "../src/chat/backend";
import { ClaudeBackend } from "../src/chat/claude-backend";
import type { ChatManager } from "../src/chats";
import type { SandboxClient } from "../src/sandbox-client";
import { FakeProc, tick } from "./fake-proc";

// `get` is consulted when a turn resumes a session with no running totals in
// memory (see ClaudeBackend.seedTotalsFromChat). These lifecycle tests never
// stream usage, so an absent row is the honest answer.
function fakeChatManager(): ChatManager {
  return { updateSessionId: () => {}, get: () => undefined } as unknown as ChatManager;
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

// A `result` envelope whose modelUsage reads the way the CLI's does: cumulative
// for the life of the process, so `costUSD` here is everything the process has
// spent, not what this turn spent.
function resultWith(costSoFar: number, tokensSoFar: number, model = "claude-sonnet-4-6") {
  return {
    type: "result",
    result: "ok",
    total_cost_usd: costSoFar,
    usage: { input_tokens: tokensSoFar, output_tokens: 0 },
    modelUsage: {
      [model]: {
        inputTokens: tokensSoFar,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: costSoFar,
      },
    },
  };
}

describe("ClaudeBackend billing across a process's turns", () => {
  it("bills each turn the rise since the last, not the running total", async () => {
    // The CLI counts cost for the life of the process (STATE.totalCostUSD), and
    // one process serves every turn in a chat. Reading its figure as a per-turn
    // cost would bill turn 2 for turn 1 as well, and a chat's total would grow
    // quadratically in its turn count.
    const { client, procs } = liveClient();
    const backend = new ClaudeBackend(client, fakeChatManager(), { idleMs: 60_000 });
    const billed: number[] = [];
    const turn = async (index: number, costSoFar: number, tokensSoFar: number) => {
      const pending = backend.sendMessage({
        ...baseTurn,
        message: `turn ${index}`,
        model: "claude-sonnet-4-6",
        ...(index === 0 ? {} : { sessionId: "s" }),
        onBilling: (models) => billed.push(models[0]!.costUsd),
      });
      if (index === 0) proc(procs, 0).emit({ type: "system", subtype: "init", session_id: "s" });
      proc(procs, 0).emit(resultWith(costSoFar, tokensSoFar));
      await pending;
    };

    await turn(0, 0.1, 1_000);
    await turn(1, 0.35, 3_000);
    await turn(2, 0.6, 5_000);

    expect(procs.length).toBe(1); // one process, so one running counter
    expect(billed).toHaveLength(3);
    expect(billed[0]).toBeCloseTo(0.1, 10);
    expect(billed[1]).toBeCloseTo(0.25, 10);
    expect(billed[2]).toBeCloseTo(0.25, 10);
    // What the chat is charged is the last figure the CLI reported, not the sum
    // of the three reports ($1.05).
    expect(billed.reduce((sum, n) => sum + n, 0)).toBeCloseTo(0.6, 10);

    for (const p of procs) p.exit(0);
    await tick();
  });

  it("starts a new process's baseline at zero", async () => {
    // A restarted process counts from zero again, so the previous process's
    // figures must not be differenced against it: that would bill nothing until
    // the new process passed the old one's total.
    const { client, procs } = liveClient();
    const backend = new ClaudeBackend(client, fakeChatManager(), { idleMs: 60_000 });
    const billed: number[] = [];
    const turn = async (index: number, costSoFar: number) => {
      const pending = backend.sendMessage({
        ...baseTurn,
        message: `turn ${index}`,
        model: "claude-sonnet-4-6",
        ...(index === 0 ? {} : { sessionId: "s" }),
        onBilling: (models) => billed.push(models[0]!.costUsd),
      });
      if (index === 0)
        proc(procs, index).emit({ type: "system", subtype: "init", session_id: "s" });
      proc(procs, procs.length - 1).emit(resultWith(costSoFar, 1_000));
      await pending;
    };

    await turn(0, 0.4);
    // The process goes away (a crash, an idle reap, a server restart), and the
    // next turn resumes the session on a fresh one.
    proc(procs, 0).exit(0);
    await tick();
    await turn(1, 0.15);

    expect(procs.length).toBe(2);
    expect(billed[0]).toBeCloseTo(0.4, 10);
    expect(billed[1]).toBeCloseTo(0.15, 10);

    for (const p of procs) p.exit(0);
    await tick();
  });
});

describe("ClaudeBackend fast mode", () => {
  it("switches a fresh process over before the turn, and bills what the CLI reports", async () => {
    const { client, procs } = liveClient();
    const backend = new ClaudeBackend(client, fakeChatManager(), { idleMs: 60_000 });
    const billed: ModelBilling[] = [];

    const pending = backend.sendMessage({
      ...baseTurn,
      message: "hi",
      model: "claude-opus-4-6",
      fast: true,
      onBilling: (models) => billed.push(...models),
    });
    await tick();
    // A fresh CLI starts standard, so the mode is applied through the same
    // in-memory flag-settings control that carries effort.
    const control = proc(procs, 0).controls("apply_flag_settings")[0];
    expect(control.request.settings).toEqual({ fastMode: true });
    proc(procs, 0).succeedControl(control);
    await tick();

    proc(procs, 0).emit({ type: "system", subtype: "init", session_id: "s" });
    proc(procs, 0).emit({
      type: "result",
      result: "ok",
      fast_mode_state: "on",
      usage: { input_tokens: 100, output_tokens: 10, speed: "fast" },
      modelUsage: {
        "claude-opus-4-6": {
          inputTokens: 100,
          outputTokens: 10,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          webSearchRequests: 0,
          costUSD: 0.2,
        },
      },
    });
    await pending;

    expect(billed[0]!.fast).toBe(true);
    for (const p of procs) p.exit(0);
    await tick();
  });

  it("bills standard when the CLI declines the mode", async () => {
    // The CLI gates fast mode on things the host cannot see: the plan, a
    // cooldown after a rate limit, and which models the installed build
    // supports at all. Asking is not evidence of getting, so the turn's own
    // report is what decides the rate.
    const { client, procs } = liveClient();
    const backend = new ClaudeBackend(client, fakeChatManager(), { idleMs: 60_000 });
    const billed: ModelBilling[] = [];

    const pending = backend.sendMessage({
      ...baseTurn,
      message: "hi",
      model: "claude-sonnet-4-6",
      fast: true,
      onBilling: (models) => billed.push(...models),
    });
    await tick();
    proc(procs, 0).succeedControl(proc(procs, 0).controls("apply_flag_settings")[0]);
    await tick();
    proc(procs, 0).emit({ type: "system", subtype: "init", session_id: "s" });
    proc(procs, 0).emit({
      type: "result",
      result: "ok",
      fast_mode_state: "off",
      usage: { input_tokens: 100, output_tokens: 10, speed: "standard" },
      modelUsage: {
        "claude-sonnet-4-6": {
          inputTokens: 100,
          outputTokens: 10,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          webSearchRequests: 0,
          costUSD: 0.02,
        },
      },
    });
    await pending;

    expect(billed[0]!.fast).toBe(false);
    for (const p of procs) p.exit(0);
    await tick();
  });

  it("still runs the turn when the mode cannot be applied", async () => {
    // An older build may reject the control outright. That should cost a
    // standard turn, not the turn.
    const { client, procs } = liveClient();
    const backend = new ClaudeBackend(client, fakeChatManager(), { idleMs: 60_000 });

    const pending = backend.sendMessage({
      ...baseTurn,
      message: "hi",
      model: "claude-opus-4-6",
      fast: true,
    });
    await tick();
    proc(procs, 0).failControl(
      proc(procs, 0).controls("apply_flag_settings")[0],
      "unsupported control",
    );
    await tick();
    proc(procs, 0).emit({ type: "system", subtype: "init", session_id: "s" });
    proc(procs, 0).emit({ type: "result", result: "answered anyway" });

    expect((await pending).content).toBe("answered anyway");
    for (const p of procs) p.exit(0);
    await tick();
  });
});

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
    expect(proc(procs, 0).command).toContain("--replay-user-messages");
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
    expect(await context).toMatchObject({
      available: true,
      totalTokens: 20_000,
    });
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

    const disposing = backend.disposeChat("c");
    let disposed = false;
    void disposing.then(() => {
      disposed = true;
    });
    await tick();
    expect(disposed).toBe(false);

    proc(procs, 0).exit(0);
    await disposing;
    expect(disposed).toBe(true);

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
