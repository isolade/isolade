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

function sessionFor(proc: FakeProc, onExit: () => void = () => {}) {
  return new ClaudeSession({
    sandboxClient: proc,
    vmId: "vm",
    command: "claude -p --input-format stream-json",
    model: "claude-sonnet-4-6",
    effort: "high",
    onExit,
    // Large enough that the safety-net timers never fire mid-test.
    interruptGraceMs: 60_000,
    shutdownGraceMs: 60_000,
    controlTimeoutMs: 60_000,
  });
}

describe("ClaudeSession", () => {
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

    const changed = session.reconfigure("claude-opus-4-8", "max");
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

    const changed = session.reconfigure("claude-opus-4-8", "high");
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
