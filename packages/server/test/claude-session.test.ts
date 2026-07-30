import { describe, expect, it } from "bun:test";
import { ClaudeSession, type TurnHooks } from "../src/chat/claude-session";
import { FakeProc, tick } from "./fake-proc";

// Minimal turn hooks: accumulate text deltas (overridden by a non-empty
// `result`), the same shape the real backend produces, so getContent() returns
// the final assistant text.
function makeHooks() {
  let content = "";
  const events: any[] = [];
  const hooks: TurnHooks = {
    onEvent: (event: any) => {
      events.push(event);
      const inner = event.event;
      if (inner?.type === "content_block_delta" && inner?.delta?.type === "text_delta") {
        content += inner.delta.text;
      }
      if (event.type === "result" && event.result) content = event.result;
    },
    onNonJsonLine: () => {},
    getContent: () => content,
  };
  return { hooks, events };
}

// Fast mode is applied through the same in-memory flag-settings layer as
// effort, so the CLI picks it up without a restart and without touching the
// user's settings file. Asserted at the control-protocol level rather than by
// running a fast turn, which would bill at a premium rate for no information.
function sessionFor(proc: FakeProc, onExit: () => void = () => {}) {
  return new ClaudeSession({
    sandboxClient: proc,
    vmId: "vm",
    command: "claude -p --input-format stream-json",
    model: "claude-sonnet-4-6",
    effort: "high",
    fast: false,
    onExit,
    // Large enough that the safety-net timers never fire mid-test.
    interruptGraceMs: 60_000,
    shutdownGraceMs: 60_000,
    controlTimeoutMs: 60_000,
  });
}

describe("ClaudeSession", () => {
  it("correlates replay acknowledgements and sends steering priority", async () => {
    const proc = new FakeProc();
    const session = sessionFor(proc);
    let acknowledged = 0;
    const turn = session.runTurn({
      userText: "hi",
      userMessageId: "user-1",
      onUserMessageAcknowledged: () => acknowledged++,
      hooks: makeHooks().hooks,
    });
    await tick();
    expect(proc.userMessages()[0]).toMatchObject({ uuid: "user-1" });
    proc.emit({ type: "system", subtype: "init", session_id: "session-1" });
    proc.emit({ type: "user", uuid: "user-1", isReplay: true });
    await tick();
    expect(acknowledged).toBe(1);

    const steered = session.steer({
      userText: "do this next",
      userMessageId: "user-2",
      priority: "next",
    });
    await tick();
    expect(proc.userMessages()[1]).toMatchObject({
      uuid: "user-2",
      priority: "next",
    });
    proc.emit({ type: "assistant", uuid: "assistant-before-steer" });
    proc.emit({ type: "user", uuid: "user-2", isReplay: true });
    expect(await steered).toEqual({
      sessionId: "session-1",
      priorAnchorId: "assistant-before-steer",
    });
    proc.emit({ type: "result", result: "done" });
    await turn;
    const shutdown = session.shutdown();
    proc.exit(0);
    await shutdown;
  });

  it("atomically cancels a pending steering message by UUID", async () => {
    const proc = new FakeProc();
    const session = sessionFor(proc);
    const turn = session.runTurn({
      userText: "hi",
      userMessageId: "user-1",
      hooks: makeHooks().hooks,
    });
    await tick();
    proc.emit({ type: "user", uuid: "user-1", isReplay: true });

    const steered = session.steer({
      userText: "do this next",
      userMessageId: "user-2",
      priority: "next",
    });
    const steeringResult = steered.then(
      () => undefined,
      (error) => error,
    );
    await tick();

    const cancelled = session.cancelSteer("user-2");
    await tick();
    const control = proc.controls("cancel_async_message")[0];
    expect(control.request).toEqual({
      subtype: "cancel_async_message",
      message_uuid: "user-2",
    });
    proc.succeedControl(control, { cancelled: true });

    expect(await cancelled).toBe(true);
    expect(await steeringResult).toEqual(
      expect.objectContaining({ message: expect.stringMatching(/cancelled/) }),
    );
    proc.emit({ type: "result", result: "done" });
    await turn;
    const shutdown = session.shutdown();
    proc.exit(0);
    await shutdown;
  });

  it("reports when Claude already dequeued a steering message", async () => {
    const proc = new FakeProc();
    const session = sessionFor(proc);
    const turn = session.runTurn({
      userText: "hi",
      userMessageId: "user-1",
      hooks: makeHooks().hooks,
    });
    await tick();
    proc.emit({ type: "user", uuid: "user-1", isReplay: true });

    const steered = session.steer({
      userText: "do this next",
      userMessageId: "user-2",
      priority: "next",
    });
    await tick();
    const cancelled = session.cancelSteer("user-2");
    await tick();
    proc.succeedControl(proc.controls("cancel_async_message")[0], { cancelled: false });
    expect(await cancelled).toBe(false);

    proc.emit({ type: "user", uuid: "user-2", isReplay: true });
    await steered;
    proc.emit({ type: "result", result: "done" });
    await turn;
    const shutdown = session.shutdown();
    proc.exit(0);
    await shutdown;
  });

  it("keeps a turn open across Claude's native now interrupt boundary", async () => {
    const proc = new FakeProc();
    const session = sessionFor(proc);
    const { hooks, events } = makeHooks();
    let turnSettled = false;
    const turn = session
      .runTurn({
        userText: "start",
        userMessageId: "user-1",
        hooks,
      })
      .finally(() => {
        turnSettled = true;
      });
    await tick();
    proc.emit({ type: "user", uuid: "user-1", isReplay: true });

    const steered = session.steer({
      userText: "change now",
      userMessageId: "user-now",
      priority: "now",
    });
    await tick();
    expect(proc.userMessages()[1]).toMatchObject({
      uuid: "user-now",
      priority: "now",
    });

    // Claude terminates the interrupted ask before it dequeues the immediate
    // prompt. This is an internal boundary, not the end of Isolade's turn.
    proc.emit({ type: "result", result: "partial before interruption" });
    await tick();
    expect(turnSettled).toBe(false);

    proc.emit({ type: "user", uuid: "user-now", isReplay: true });
    await steered;
    proc.emit({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "replacement" },
      },
    });
    proc.emit({ type: "result", result: "replacement" });

    expect(await turn).toEqual({ content: "replacement", sessionId: undefined });
    expect(events.filter((event) => event.type === "result")).toHaveLength(2);
    const shutdown = session.shutdown();
    proc.exit(0);
    await shutdown;
  });

  it("runs multiple turns on one persistent process", async () => {
    const proc = new FakeProc();
    let exits = 0;
    const session = sessionFor(proc, () => exits++);

    const p1 = session.runTurn({ userText: "hi", hooks: makeHooks().hooks });
    proc.emit({ type: "system", subtype: "init", session_id: "s" });
    proc.emit({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "one" },
      },
    });
    proc.emit({ type: "result", result: "one" });
    expect(await p1).toEqual({ content: "one", sessionId: "s" });

    const p2 = session.runTurn({ userText: "again", hooks: makeHooks().hooks });
    proc.emit({ type: "result", result: "two" });
    expect(await p2).toEqual({ content: "two", sessionId: "s" });

    await tick();
    // One process (one execStream) served both turns.
    expect(proc.userMessages().length).toBe(2);
    expect(exits).toBe(0);
    expect(session.isDead()).toBe(false);

    const sd = session.shutdown();
    proc.exit(0);
    await sd;
    expect(session.isDead()).toBe(true);
    expect(exits).toBe(1);
  });

  it("rejects concurrent turns on the same session", async () => {
    const proc = new FakeProc();
    const session = sessionFor(proc);
    const p1 = session.runTurn({ userText: "hi", hooks: makeHooks().hooks });
    await expect(
      session.runTurn({ userText: "overlap", hooks: makeHooks().hooks }),
    ).rejects.toThrow(/already in progress/);
    proc.emit({ type: "result", result: "done" });
    await p1;
    const sd = session.shutdown();
    proc.exit(0);
    await sd;
  });

  it("interrupts a turn without killing the process, leaving it reusable", async () => {
    const proc = new FakeProc();
    let exits = 0;
    const session = sessionFor(proc, () => exits++);
    const ac = new AbortController();

    const p1 = session.runTurn({
      userText: "long",
      signal: ac.signal,
      hooks: makeHooks().hooks,
    });
    proc.emit({ type: "system", subtype: "init", session_id: "s" });
    proc.emit({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "partial" },
      },
    });

    ac.abort();
    await tick();
    // A graceful interrupt control message went out, not a process kill.
    expect(proc.interrupts().length).toBe(1);

    // The CLI acks (swallowed), injects the synthetic turn, and ends the turn.
    proc.succeedControl(proc.interrupts()[0]);
    proc.emit({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: "[Request interrupted by user]" }],
      },
    });
    proc.emit({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
    });

    await expect(p1).rejects.toThrow(/abort/i);
    expect(exits).toBe(0);
    expect(proc.killed).toBe(false);
    expect(session.isDead()).toBe(false);

    // The same warm process serves the next turn.
    const p2 = session.runTurn({
      userText: "carry on",
      hooks: makeHooks().hooks,
    });
    proc.emit({ type: "result", result: "recovered" });
    expect(await p2).toEqual({ content: "recovered", sessionId: "s" });

    const sd = session.shutdown();
    proc.exit(0);
    await sd;
  });

  it("rejects the in-flight turn and goes dead when the process exits non-zero", async () => {
    const proc = new FakeProc();
    let exits = 0;
    const session = sessionFor(proc, () => exits++);

    const p1 = session.runTurn({ userText: "hi", hooks: makeHooks().hooks });
    proc.emit({ type: "system", subtype: "init", session_id: "s" });
    proc.exit(1);

    await expect(p1).rejects.toThrow(/exited with code 1/);
    expect(session.isDead()).toBe(true);
    expect(exits).toBe(1);
  });

  it("refuses new turns once the process has died", async () => {
    const proc = new FakeProc();
    const session = sessionFor(proc);
    const p1 = session.runTurn({ userText: "hi", hooks: makeHooks().hooks });
    proc.exit(0); // exits with no result → in-flight turn rejected
    await p1.catch(() => {});
    expect(session.isDead()).toBe(true);
    await expect(session.runTurn({ userText: "again", hooks: makeHooks().hooks })).rejects.toThrow(
      /no longer alive/,
    );
  });

  it("throws immediately if the caller's signal is already aborted", async () => {
    const proc = new FakeProc();
    const session = sessionFor(proc);
    const ac = new AbortController();
    ac.abort();
    await expect(
      session.runTurn({
        userText: "hi",
        signal: ac.signal,
        hooks: makeHooks().hooks,
      }),
    ).rejects.toThrow(/abort/i);
  });

  it("changes model and effort through correlated controls without restarting", async () => {
    const proc = new FakeProc();
    const session = sessionFor(proc);

    const changed = session.reconfigure("claude-opus-4-8", "max", false);
    await tick();
    const modelControl = proc.controls("set_model")[0];
    expect(modelControl.request).toEqual({
      subtype: "set_model",
      model: "claude-opus-4-8",
    });
    proc.succeedControl(modelControl);

    await tick();
    const effortControl = proc.controls("apply_flag_settings")[0];
    expect(effortControl.request).toEqual({
      subtype: "apply_flag_settings",
      settings: { effortLevel: "max" },
    });
    proc.succeedControl(effortControl);

    await changed;
    expect(session.model).toBe("claude-opus-4-8");
    expect(session.effort).toBe("max");
    expect(session.isDead()).toBe(false);

    const sd = session.shutdown();
    proc.exit(0);
    await sd;
  });

  it("rejects a failed control and keeps the prior configuration", async () => {
    const proc = new FakeProc();
    const session = sessionFor(proc);

    const changed = session.reconfigure("claude-opus-4-8", "high", false);
    await tick();
    proc.failControl(proc.controls("set_model")[0], "unsupported control");

    await expect(changed).rejects.toThrow(/set_model.*unsupported control/);
    expect(session.model).toBe("claude-sonnet-4-6");
    expect(session.isDead()).toBe(false);

    const sd = session.shutdown();
    proc.exit(0);
    await sd;
  });

  it("rejects pending controls when the process exits", async () => {
    const proc = new FakeProc();
    const session = sessionFor(proc);

    const context = session.getContextUsage();
    await tick();
    proc.exit(1);

    await expect(context).rejects.toThrow(/exited with code 1/);
    expect(session.isDead()).toBe(true);
  });

  it("preserves UTF-8 characters split across stdout chunks", async () => {
    const proc = new FakeProc();
    const session = sessionFor(proc);
    const turn = session.runTurn({ userText: "hi", hooks: makeHooks().hooks });
    const encoded = Buffer.from(`${JSON.stringify({ type: "result", result: "café 🦀" })}\n`);
    const emojiStart = encoded.indexOf(Buffer.from("🦀"));
    proc.emitStdout(encoded.subarray(0, emojiStart + 2));
    proc.emitStdout(encoded.subarray(emojiStart + 2));

    expect((await turn).content).toBe("café 🦀");
    const sd = session.shutdown();
    proc.exit(0);
    await sd;
  });

  it("bounds stderr retained for process errors", async () => {
    const proc = new FakeProc();
    const session = sessionFor(proc);
    const turn = session.runTurn({ userText: "hi", hooks: makeHooks().hooks });
    proc.emitStderr(`discard-me-${"x".repeat(20_000)}`);
    proc.emitStderr("tail-marker");
    proc.exit(1);

    try {
      await turn;
      throw new Error("expected turn to reject");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message.length).toBeLessThan(17_000);
      expect(message).not.toContain("discard-me");
      expect(message).toContain("tail-marker");
    }
  });
});

describe("ClaudeSession fast mode", () => {
  it("switches the live process over through flag settings", async () => {
    const proc = new FakeProc();
    const session = sessionFor(proc);

    const enabling = session.reconfigure("claude-sonnet-4-6", "high", true);
    await tick();
    const control = proc.controls("apply_flag_settings")[0];
    expect(control).toBeDefined();
    expect(control.request.settings).toEqual({ fastMode: true });
    proc.succeedControl(control);
    await enabling;
    expect(session.fast).toBe(true);

    // Turning it off clears the key rather than writing false: the CLI reads a
    // null as a deletion, which drops back to whatever the settings files say.
    const disabling = session.reconfigure("claude-sonnet-4-6", "high", false);
    await tick();
    const off = proc.controls("apply_flag_settings")[1];
    expect(off.request.settings).toEqual({ fastMode: null });
    proc.succeedControl(off);
    await disabling;
    expect(session.fast).toBe(false);
  });

  it("says nothing when the mode has not changed", async () => {
    const proc = new FakeProc();
    const session = sessionFor(proc);
    await session.reconfigure("claude-sonnet-4-6", "high", false);
    expect(proc.controls("apply_flag_settings")).toHaveLength(0);
  });
});
