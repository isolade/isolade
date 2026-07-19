import { describe, expect, it } from "bun:test";
import type { ChatEvent } from "../src/chat/backend";
import { CodexBackend } from "../src/chat/codex-backend";
import type { CodexConnection, CodexManager } from "../src/chat/codex-manager";
import type { ChatManager } from "../src/chats";
import { codexPricingFor } from "../src/contracts";
import type { SandboxClient } from "../src/sandbox-client";

// Fake JSON-RPC connection: records the handlers CodexBackend registers, then,
// once the backend sends `turn/start`, replays a scripted notification
// sequence through them, mimicking the codex app-server's event stream.
class FakeCodexConn {
  private handlers = new Map<string, ((p: unknown) => void)[]>();
  private anyHandlers: ((m: string, p: unknown) => void)[] = [];
  script: Array<[string, unknown]> = [];
  sent: Array<{ method: string; params: unknown }> = [];
  // When set, `thread/resume` rejects with this error, mimicking codex refusing
  // to reload a thread (e.g. a missing rollout after a home reset).
  resumeError: Error | null = null;
  // When set, `thread/fork` rejects with this error (e.g. an old app-server
  // without the method, or a missing rollout).
  forkError: Error | null = null;
  // When set, `turn/start` records the request but withholds its response until
  // this resolves, letting a test abort while the turn id is still pending.
  turnStartGate: Promise<void> | null = null;

  on(method: string, h: (p: unknown) => void) {
    const a = this.handlers.get(method) ?? [];
    a.push(h);
    this.handlers.set(method, a);
    return () => {
      this.handlers.set(
        method,
        (this.handlers.get(method) ?? []).filter((x) => x !== h),
      );
    };
  }
  onAny(h: (m: string, p: unknown) => void) {
    this.anyHandlers.push(h);
    return () => {};
  }
  async send(method: string, params: unknown): Promise<unknown> {
    this.sent.push({ method, params });
    if (method === "thread/start") {
      return { thread: { id: "thread-new" } };
    }
    if (method === "thread/resume") {
      if (this.resumeError) throw this.resumeError;
      return { thread: { id: (params as { threadId: string }).threadId } };
    }
    if (method === "thread/fork") {
      if (this.forkError) throw this.forkError;
      return { thread: { id: "thread-forked" } };
    }
    if (method === "turn/start") {
      // Hold the response when a test wants to abort before the turn id lands.
      if (this.turnStartGate) await this.turnStartGate;
      // Fire after the current microtask so all handlers are registered.
      queueMicrotask(() => {
        for (const [m, p] of this.script) this.fire(m, p);
      });
      return { turn: { id: "turn-1" } };
    }
    return {};
  }
  private fire(method: string, params: unknown) {
    const hs = this.handlers.get(method);
    if (hs && hs.length) hs.forEach((h) => h(params));
    else this.anyHandlers.forEach((h) => h(method, params));
  }
}

class FakeCodexManager {
  readonly conn = new FakeCodexConn();
  refreshAuthCalls = 0;

  async getOrCreate(): Promise<CodexConnection> {
    return this.conn as unknown as CodexConnection;
  }

  async refreshAuth(): Promise<void> {
    this.refreshAuthCalls += 1;
  }
}

const noopChatManager = { updateSessionId: () => {} } as unknown as ChatManager;

function backendWith(script: Array<[string, unknown]>) {
  const mgr = new FakeCodexManager();
  mgr.conn.script = script;
  const backend = new CodexBackend(
    {} as unknown as SandboxClient,
    noopChatManager,
    mgr as unknown as CodexManager,
  );
  return { backend, mgr };
}

async function run(script: Array<[string, unknown]>, model = "gpt-5-codex") {
  const deltas: string[] = [];
  const events: ChatEvent[] = [];
  const { backend } = backendWith(script);
  const result = await backend.sendMessage({
    vmId: "vm",
    chatId: "chat",
    message: "hi",
    model,
    effort: "medium",
    sessionId: "thread-1", // skip thread/start
    onDelta: (t) => deltas.push(t),
    onEvent: (e) => events.push(e),
  });
  return { result, deltas, events };
}

describe("CodexBackend notification parsing", () => {
  it("starts new chat threads as persistent", async () => {
    const mgr = new FakeCodexManager();
    mgr.conn.script = [["turn/completed", { turn: { status: "completed" } }]];
    const updated: Array<{ chatId: string; codexThreadId?: string }> = [];
    const chatManager = {
      updateSessionId: (chatId: string, _claudeSessionId?: string, codexThreadId?: string) => {
        updated.push({ chatId, codexThreadId });
      },
    } as unknown as ChatManager;
    const backend = new CodexBackend(
      {} as unknown as SandboxClient,
      chatManager,
      mgr as unknown as CodexManager,
    );

    const result = await backend.sendMessage({
      vmId: "vm",
      chatId: "chat",
      message: "hi",
      model: "gpt-5-codex",
      effort: "medium",
      onDelta: () => {},
    });

    expect(mgr.conn.sent).toContainEqual({
      method: "thread/start",
      params: { ephemeral: false },
    });
    expect(updated).toEqual([{ chatId: "chat", codexThreadId: "thread-new" }]);
    expect(result.sessionId).toBe("thread-new");
  });

  it("resumes an existing thread before starting the turn", async () => {
    // After a VM restart the app-server is a fresh process that only has the
    // thread's persisted rollout on disk, so a turn/start without a preceding
    // thread/resume fails with "thread not found". The backend must resume the
    // existing thread first, and never re-create one it already has.
    const { backend, mgr } = backendWith([["turn/completed", { turn: { status: "completed" } }]]);
    const result = await backend.sendMessage({
      vmId: "vm",
      chatId: "chat",
      message: "hi",
      model: "gpt-5-codex",
      effort: "medium",
      sessionId: "thread-1",
      onDelta: () => {},
    });
    const methods = mgr.conn.sent.map((s) => s.method);
    expect(mgr.conn.sent).toContainEqual({
      method: "thread/resume",
      params: { threadId: "thread-1" },
    });
    expect(methods.indexOf("thread/resume")).toBeLessThan(methods.indexOf("turn/start"));
    expect(methods).not.toContain("thread/start");
    expect(result.sessionId).toBe("thread-1");
  });

  it("resumes a thread only once per connection", async () => {
    // The rollout is loaded into the app-server on the first resume. Further
    // turns on the same connection must reuse it rather than resume again.
    const { backend, mgr } = backendWith([["turn/completed", { turn: { status: "completed" } }]]);
    const send = () =>
      backend.sendMessage({
        vmId: "vm",
        chatId: "chat",
        message: "hi",
        model: "gpt-5-codex",
        effort: "medium",
        sessionId: "thread-1",
        onDelta: () => {},
      });
    await send();
    await send();
    expect(mgr.conn.sent.filter((s) => s.method === "thread/resume")).toHaveLength(1);
    expect(mgr.conn.sent.filter((s) => s.method === "turn/start")).toHaveLength(2);
  });

  it("starts a fresh thread when the persisted rollout is gone", async () => {
    // A missing rollout (e.g. the codex home was reset) can't be resumed, so
    // rather than erroring every turn the backend starts a fresh thread and
    // repoints the chat at it.
    const mgr = new FakeCodexManager();
    mgr.conn.script = [["turn/completed", { turn: { status: "completed" } }]];
    mgr.conn.resumeError = new Error("no rollout found for thread id thread-1");
    const updated: Array<{ codexThreadId?: string }> = [];
    const chatManager = {
      updateSessionId: (_chatId: string, _claude?: string, codexThreadId?: string) => {
        updated.push({ codexThreadId });
      },
    } as unknown as ChatManager;
    const backend = new CodexBackend(
      {} as unknown as SandboxClient,
      chatManager,
      mgr as unknown as CodexManager,
    );
    const result = await backend.sendMessage({
      vmId: "vm",
      chatId: "chat",
      message: "hi",
      model: "gpt-5-codex",
      effort: "medium",
      sessionId: "thread-1",
      onDelta: () => {},
    });
    expect(mgr.conn.sent).toContainEqual({
      method: "thread/start",
      params: { ephemeral: false },
    });
    expect(updated).toEqual([{ codexThreadId: "thread-new" }]);
    expect(result.sessionId).toBe("thread-new");
  });

  it("propagates a resume failure that isn't a missing rollout", async () => {
    // Transport/auth failures must not be mistaken for a gone thread: we keep
    // the thread, refresh auth, and surface the error instead of silently
    // discarding a resumable conversation.
    const { backend, mgr } = backendWith([["turn/completed", { turn: { status: "completed" } }]]);
    mgr.conn.resumeError = new Error("unauthorized");
    await expect(
      backend.sendMessage({
        vmId: "vm",
        chatId: "chat",
        message: "hi",
        model: "gpt-5-codex",
        effort: "medium",
        sessionId: "thread-1",
        onDelta: () => {},
      }),
    ).rejects.toThrow("unauthorized");
    const methods = mgr.conn.sent.map((s) => s.method);
    expect(methods).not.toContain("thread/start");
    expect(methods).not.toContain("turn/start");
    expect(mgr.refreshAuthCalls).toBe(1);
  });

  it("accumulates agentMessage deltas into the content", async () => {
    const { result, deltas } = await run([
      ["item/agentMessage/delta", { delta: "Hi " }],
      ["item/agentMessage/delta", { delta: "there" }],
      ["turn/completed", { turn: { status: "completed" } }],
    ]);
    expect(deltas).toEqual(["Hi ", "there"]);
    expect(result.content).toBe("Hi there");
    expect(result.sessionId).toBe("thread-1");
  });

  it("maps a command item to tool_call_start/result with a humanized name", async () => {
    const { events } = await run([
      [
        "item/started",
        {
          item: {
            id: "i1",
            type: "commandExecution",
            status: "inProgress",
            command: "ls",
          },
        },
      ],
      [
        "item/completed",
        {
          item: {
            id: "i1",
            type: "commandExecution",
            status: "completed",
            command: "ls",
            aggregatedOutput: "file.txt",
            exitCode: 0,
          },
        },
      ],
      ["turn/completed", { turn: { status: "completed" } }],
    ]);
    expect(events).toContainEqual({
      type: "tool_call_start",
      id: "i1",
      name: "Shell",
    });
    const result = events.find(
      (e): e is Extract<ChatEvent, { type: "tool_call_result" }> => e.type === "tool_call_result",
    );
    expect(result?.id).toBe("i1");
    expect(result?.isError).toBe(false);
    expect(result?.output).toContain("file.txt");
  });

  it("flags a non-zero exit code as an error result", async () => {
    const { events } = await run([
      [
        "item/completed",
        {
          item: {
            id: "i2",
            type: "commandExecution",
            status: "completed",
            command: "false",
            aggregatedOutput: "",
            exitCode: 1,
          },
        },
      ],
      ["turn/completed", { turn: { status: "completed" } }],
    ]);
    const result = events.find(
      (e): e is Extract<ChatEvent, { type: "tool_call_result" }> => e.type === "tool_call_result",
    );
    expect(result?.isError).toBe(true);
  });

  it("renders a reasoning item as a thinking event, not a tool call", async () => {
    const { events } = await run([
      ["item/started", { item: { id: "r1", type: "reasoning", status: "inProgress" } }],
      ["turn/completed", { turn: { status: "completed" } }],
    ]);
    expect(events.some((e) => e.type === "thinking")).toBe(true);
    expect(events.some((e) => e.type === "tool_call_start")).toBe(false);
  });

  it("rejects on turn/failed", async () => {
    await expect(run([["turn/failed", { error: { message: "rate limited" } }]])).rejects.toThrow(
      "rate limited",
    );
  });

  it("refreshes live auth after a rate-limit style failure", async () => {
    const { backend, mgr } = backendWith([
      ["turn/failed", { error: { message: "usage was exhausted" } }],
    ]);
    await expect(
      backend.sendMessage({
        vmId: "vm",
        chatId: "chat",
        message: "hi",
        model: "gpt-5-codex",
        effort: "medium",
        sessionId: "thread-1",
        onDelta: () => {},
      }),
    ).rejects.toThrow("usage was exhausted");
    expect(mgr.refreshAuthCalls).toBe(1);
  });

  it("rejects on turn/completed with status failed", async () => {
    await expect(
      run([
        [
          "turn/completed",
          {
            turn: { status: "failed", error: { message: "context exhausted" } },
          },
        ],
      ]),
    ).rejects.toThrow("context exhausted");
  });

  it("normalizes usage so input and cached are disjoint", async () => {
    // codex reports inputTokens as the FULL prompt (cached included). Our
    // schema keeps them disjoint, so the backend subtracts the cached subset.
    const { events } = await run([
      [
        "thread/tokenUsage/updated",
        {
          tokenUsage: {
            last: { inputTokens: 100, cachedInputTokens: 30, outputTokens: 50 },
            total: {
              inputTokens: 200,
              cachedInputTokens: 60,
              outputTokens: 100,
            },
            modelContextWindow: 400000,
          },
        },
      ],
      ["turn/completed", { turn: { status: "completed" } }],
    ]);
    const u = events.find((e): e is Extract<ChatEvent, { type: "usage" }> => e.type === "usage");
    expect(u?.last.inputTokens).toBe(70); // 100 - 30
    expect(u?.last.cachedInputTokens).toBe(30);
    expect(u?.total.inputTokens).toBe(140); // 200 - 60
    expect(u?.modelContextWindow).toBe(400000);
  });

  it("normalizes usage so output and reasoning are disjoint (reasoning billed once)", async () => {
    // codex reports outputTokens as the FULL completion with reasoning included
    // (OpenAI Responses API semantics). Our schema keeps them disjoint, so the
    // backend subtracts the reasoning subset. Without this the API-$ estimate
    // adds output + reasoning and bills the reasoning tokens a second time.
    const { events } = await run(
      [
        [
          "thread/tokenUsage/updated",
          {
            tokenUsage: {
              last: { inputTokens: 100, outputTokens: 80, reasoningOutputTokens: 50 },
              total: { inputTokens: 100, outputTokens: 80, reasoningOutputTokens: 50 },
              modelContextWindow: 400000,
            },
          },
        ],
        ["turn/completed", { turn: { status: "completed" } }],
      ],
      "gpt-5.6-sol",
    );
    const u = events.find((e): e is Extract<ChatEvent, { type: "usage" }> => e.type === "usage");
    expect(u?.total.outputTokens).toBe(30); // 80 completion - 50 reasoning
    expect(u?.total.reasoningOutputTokens).toBe(50);
    // The 80 completion tokens are billed once, not 80 + 50. Expected cost is
    // derived from the live catalog rate so it can't drift out of sync.
    const pricing = codexPricingFor("gpt-5.6-sol");
    if (!pricing) throw new Error("expected gpt-5.6-sol to be priced");
    const expected =
      (100 * pricing.inputPerMTok) / 1_000_000 + (80 * pricing.outputPerMTok) / 1_000_000;
    expect(u?.costUsd).toBeCloseTo(expected, 10);
  });

  it("surfaces an unrecognized notification as a raw event", async () => {
    const { events } = await run([
      ["thread/somethingNew", { foo: "bar" }],
      ["turn/completed", { turn: { status: "completed" } }],
    ]);
    expect(events.some((e) => e.type === "raw")).toBe(true);
  });

  it("interrupts the active Codex turn when aborted", async () => {
    const { backend, mgr } = backendWith([]);
    const ac = new AbortController();
    const sending = backend.sendMessage({
      vmId: "vm",
      chatId: "chat",
      message: "hi",
      model: "gpt-5-codex",
      effort: "medium",
      sessionId: "thread-1",
      signal: ac.signal,
      onDelta: () => {},
    });

    // Let thread/resume and turn/start settle so the backend has the Codex
    // turn id required by turn/interrupt.
    await new Promise((resolve) => setTimeout(resolve, 0));
    ac.abort();

    await expect(sending).rejects.toThrow("aborted");
    expect(mgr.conn.sent).toContainEqual({
      method: "turn/interrupt",
      params: { threadId: "thread-1", turnId: "turn-1" },
    });
  });

  it("defers the interrupt until the turn id lands for an early Stop", async () => {
    const { backend, mgr } = backendWith([]);
    let releaseTurnStart!: () => void;
    mgr.conn.turnStartGate = new Promise<void>((resolve) => {
      releaseTurnStart = resolve;
    });
    const ac = new AbortController();
    const sending = backend.sendMessage({
      vmId: "vm",
      chatId: "chat",
      message: "hi",
      model: "gpt-5-codex",
      effort: "medium",
      sessionId: "thread-1",
      signal: ac.signal,
      onDelta: () => {},
    });

    // turn/start has been sent but its response is withheld, so the backend
    // doesn't yet know the turn id. Aborting now can't interrupt anything.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mgr.conn.sent.some((s) => s.method === "turn/start")).toBe(true);
    ac.abort();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mgr.conn.sent.some((s) => s.method === "turn/interrupt")).toBe(false);

    // Once turn/start resolves and hands over the turn id, the queued Stop
    // fires the interrupt before the send rejects.
    releaseTurnStart();
    await expect(sending).rejects.toThrow("aborted");
    expect(mgr.conn.sent).toContainEqual({
      method: "turn/interrupt",
      params: { threadId: "thread-1", turnId: "turn-1" },
    });
  });

  it("reports thread and turn ids through onMeta", async () => {
    const { backend } = backendWith([["turn/completed", { turn: { status: "completed" } }]]);
    const metas: Array<{ sessionId?: string; anchorId?: string }> = [];
    await backend.sendMessage({
      vmId: "vm",
      chatId: "chat",
      message: "hi",
      model: "gpt-5-codex",
      effort: "medium",
      sessionId: "thread-1",
      onDelta: () => {},
      onMeta: (m) => metas.push(m),
    });
    expect(metas).toContainEqual({ sessionId: "thread-1" });
    expect(metas).toContainEqual({ anchorId: "turn-1" });
  });

  it("forks the thread at the anchor turn and runs the turn on the fork", async () => {
    const mgr = new FakeCodexManager();
    mgr.conn.script = [["turn/completed", { turn: { status: "completed" } }]];
    const updated: Array<{ chatId: string; codexThreadId?: string }> = [];
    const chatManager = {
      updateSessionId: (chatId: string, _claudeSessionId?: string, codexThreadId?: string) => {
        updated.push({ chatId, codexThreadId });
      },
    } as unknown as ChatManager;
    const backend = new CodexBackend(
      {} as unknown as SandboxClient,
      chatManager,
      mgr as unknown as CodexManager,
    );

    const metas: Array<{ sessionId?: string; anchorId?: string }> = [];
    await backend.sendMessage({
      vmId: "vm",
      chatId: "chat-1",
      message: "edited question",
      model: "gpt-5-codex",
      effort: "medium",
      sessionId: "thread-1",
      fork: { anchorId: "turn-7" },
      onDelta: () => {},
      onMeta: (m) => metas.push(m),
    });

    expect(mgr.conn.sent).toContainEqual({
      method: "thread/fork",
      params: { threadId: "thread-1", lastTurnId: "turn-7", ephemeral: false },
    });
    // No resume of the source thread: thread/fork loads the rollout itself.
    expect(mgr.conn.sent.some((s) => s.method === "thread/resume")).toBe(false);
    const turnStart = mgr.conn.sent.find((s) => s.method === "turn/start");
    expect((turnStart!.params as { threadId: string }).threadId).toBe("thread-forked");
    // The chat's session column follows the forked thread immediately.
    expect(updated).toContainEqual({ chatId: "chat-1", codexThreadId: "thread-forked" });
    expect(metas).toContainEqual({ sessionId: "thread-forked" });
  });

  it("propagates a failed fork instead of degrading to a fresh thread", async () => {
    const mgr = new FakeCodexManager();
    mgr.conn.forkError = new Error("no rollout found for thread id thread-1");
    const backend = new CodexBackend(
      {} as unknown as SandboxClient,
      noopChatManager,
      mgr as unknown as CodexManager,
    );
    await expect(
      backend.sendMessage({
        vmId: "vm",
        chatId: "chat-1",
        message: "edited question",
        model: "gpt-5-codex",
        effort: "medium",
        sessionId: "thread-1",
        fork: { anchorId: "turn-7" },
        onDelta: () => {},
      }),
    ).rejects.toThrow("no rollout found");
    expect(mgr.conn.sent.some((s) => s.method === "thread/start")).toBe(false);
  });
});
