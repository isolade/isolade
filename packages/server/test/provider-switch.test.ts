import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { HANDOFF_OPEN_TAG } from "../src/chat/handoff";
import {
  DEFAULT_ANTHROPIC_MODEL_ID,
  DEFAULT_OPENAI_MODEL_ID,
  type PendingSwitch,
} from "../src/contracts";
import { createTestServer } from "./helpers";

// A minimal controllable backend: it records the last sendMessage opts (so the
// test can inspect the injected handoff) and replays a per-turn script of
// deltas/meta/usage. Both provider slots point at this one fake, so a
// cross-provider switch just runs the next turn through it.
interface FakeOpts {
  chatId: string;
  message: string;
  model: string;
  effort: string;
  sessionId?: string;
  fork?: { anchorId: string };
  onDelta: (t: string) => void;
  onEvent?: (e: unknown) => void;
  onMeta?: (m: { sessionId?: string; anchorId?: string }) => void;
}

type Action =
  | { kind: "delta"; text: string }
  | { kind: "meta"; meta: { sessionId?: string; anchorId?: string } }
  | { kind: "usage"; totalInput: number; window?: number }
  | { kind: "throw"; message: string };

class FakeBackend {
  script: Action[] = [];
  lastOpts: FakeOpts | null = null;
  calls = 0;
  // Scratch "handoff-reduce-*" summarization turns. Their canned reply stands in
  // for a real summary; `fork`/`sessionId` distinguish the cheap fork path from
  // the chunked re-feed fallback.
  reduceCalls: Array<{ message: string; fork?: { anchorId: string }; sessionId?: string }> = [];

  setScript(actions: Action[]) {
    this.script = actions;
  }

  sendMessage = async (opts: FakeOpts): Promise<{ content: string; sessionId?: string }> => {
    this.calls++;
    // A reduction scratch turn: answer with a compact canned summary rather than
    // the per-turn script, exactly as a real summarizer would.
    if (opts.chatId.startsWith("handoff-reduce-")) {
      this.reduceCalls.push({ message: opts.message, fork: opts.fork, sessionId: opts.sessionId });
      return { content: "ROLLED SUMMARY of the earlier conversation" };
    }
    this.lastOpts = opts;
    let content = "";
    for (const action of this.script) {
      if (action.kind === "throw") {
        throw new Error(action.message);
      } else if (action.kind === "delta") {
        content += action.text;
        opts.onDelta(action.text);
      } else if (action.kind === "meta") {
        opts.onMeta?.(action.meta);
      } else if (action.kind === "usage") {
        const zero = {
          inputTokens: 0,
          cachedInputTokens: 0,
          cacheCreationInputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
          totalTokens: 0,
        };
        opts.onEvent?.({
          type: "usage",
          total: { ...zero, inputTokens: action.totalInput, totalTokens: action.totalInput },
          last: { ...zero, inputTokens: action.totalInput, totalTokens: action.totalInput },
          modelContextWindow: action.window,
          costUsd: action.totalInput / 1_000_000,
        });
      }
    }
    return { content };
  };

  probeContext = async () => ({ available: false as const, reason: "fake" });
  generateTitle = async () => null;
}

// Drain an SSE turn response to completion.
async function drain(res: Response): Promise<void> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = dec.decode(value, { stream: true });
    if (text.includes("event: done") || text.includes("event: error")) {
      // Keep reading until the stream actually closes so the producer settles.
    }
  }
}

describe("cross-provider switch", () => {
  let baseUrl: string;
  let seedInstance: () => string;
  let chatManager: ReturnType<typeof createTestServer>["chatManager"];
  let backend: FakeBackend;
  let cleanup: () => Promise<void>;

  beforeAll(() => {
    backend = new FakeBackend();
    const server = createTestServer({
      backendForTest: backend as never,
      hubOptions: { idleCancelMs: 30_000, evictionMs: 30_000 },
    });
    baseUrl = server.baseUrl;
    seedInstance = server.seedInstance;
    chatManager = server.chatManager;
    cleanup = server.cleanup;
  });

  afterAll(async () => {
    await cleanup();
  });

  async function makeChat(model: string): Promise<{ instanceId: string; chatId: string }> {
    const instanceId = seedInstance();
    const res = await fetch(`${baseUrl}/api/instances/${instanceId}/chats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
    });
    const { id } = (await res.json()) as { id: string };
    return { instanceId, chatId: id };
  }

  async function send(instanceId: string, chatId: string, content: string): Promise<void> {
    const res = await fetch(`${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    expect(res.status).toBe(200);
    await drain(res);
  }

  // Read a chat back through the list endpoint (which applies pendingSwitch),
  // without mutating it.
  async function getChat(
    instanceId: string,
    chatId: string,
  ): Promise<{ id: string; provider: string; model: string; pendingSwitch?: PendingSwitch }> {
    const res = await fetch(`${baseUrl}/api/instances/${instanceId}/chats`);
    const chats = (await res.json()) as Array<{
      id: string;
      provider: string;
      model: string;
      pendingSwitch?: PendingSwitch;
    }>;
    return chats.find((c) => c.id === chatId)!;
  }

  async function patchModel(
    instanceId: string,
    chatId: string,
    model: string,
  ): Promise<{ provider: string; model: string; pendingSwitch?: PendingSwitch }> {
    const res = await fetch(`${baseUrl}/api/instances/${instanceId}/chats/${chatId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as never;
  }

  it("selecting the other provider records a pending switch without switching now", async () => {
    const { instanceId, chatId } = await makeChat(DEFAULT_ANTHROPIC_MODEL_ID);
    backend.setScript([{ kind: "delta", text: "hi from claude" }]);
    await send(instanceId, chatId, "first question");

    const patched = await patchModel(instanceId, chatId, DEFAULT_OPENAI_MODEL_ID);
    // The chat still runs on the source provider; the switch is only pending.
    expect(patched.provider).toBe("anthropic");
    expect(patched.model).toBe(DEFAULT_ANTHROPIC_MODEL_ID);
    expect(patched.pendingSwitch?.targetProvider).toBe("openai");
    expect(patched.pendingSwitch?.targetModel).toBe(DEFAULT_OPENAI_MODEL_ID);
    expect(patched.pendingSwitch?.status).toBe("pending");
    // The source session id is preserved (not cleared like the old path).
    expect(chatManager.get(chatId)?.provider).toBe("anthropic");
  });

  it("the next send activates the switch with a handoff-injected fresh session", async () => {
    const { instanceId, chatId } = await makeChat(DEFAULT_ANTHROPIC_MODEL_ID);
    backend.setScript([
      { kind: "meta", meta: { sessionId: "claude-sess", anchorId: "claude-anchor" } },
      { kind: "delta", text: "claude answer" },
      { kind: "usage", totalInput: 500_000 },
    ]);
    await send(instanceId, chatId, "explain the parser");
    expect(chatManager.get(chatId)?.inputTokens).toBe(500_000);

    await patchModel(instanceId, chatId, DEFAULT_OPENAI_MODEL_ID);

    backend.setScript([
      { kind: "delta", text: "codex answer" },
      { kind: "usage", totalInput: 4_000 },
    ]);
    await send(instanceId, chatId, "now port it to rust");

    // The target turn ran on a FRESH session (no resume) ...
    expect(backend.lastOpts?.sessionId).toBeUndefined();
    expect(backend.lastOpts?.fork).toBeUndefined();
    expect(backend.lastOpts?.model).toBe(DEFAULT_OPENAI_MODEL_ID);
    // ... with the handoff envelope carrying the prior conversation, plus the
    // current user message.
    const sent = backend.lastOpts?.message ?? "";
    expect(sent).toContain(HANDOFF_OPEN_TAG);
    expect(sent).toContain("explain the parser");
    expect(sent).toContain("claude answer");
    expect(sent).toContain("now port it to rust");

    // The chat committed to the target provider/model, and the pending switch
    // is cleared.
    const after = chatManager.get(chatId)!;
    expect(after.provider).toBe("openai");
    expect(after.model).toBe(DEFAULT_OPENAI_MODEL_ID);
    expect((await getChat(instanceId, chatId)).pendingSwitch).toBeUndefined();

    // Active-session usage was reset before the first target usage event, so the
    // smaller target total is recorded (not clamped away against 500k).
    expect(after.inputTokens).toBe(4_000);
  });

  it("does not leak the handoff into the visible transcript", async () => {
    const { instanceId, chatId } = await makeChat(DEFAULT_ANTHROPIC_MODEL_ID);
    backend.setScript([{ kind: "delta", text: "a" }]);
    await send(instanceId, chatId, "source message");
    await patchModel(instanceId, chatId, DEFAULT_OPENAI_MODEL_ID);
    backend.setScript([{ kind: "delta", text: "b" }]);
    await send(instanceId, chatId, "target message");

    const transcript = (await (
      await fetch(`${baseUrl}/api/instances/${instanceId}/chats/${chatId}/transcript`)
    ).json()) as { messages: { role: string; content: string }[] };
    const contents = transcript.messages.map((m) => m.content);
    // The stored rows are the user's own text and the assistant answers only:
    // no prelude, no handoff envelope.
    expect(contents).toContain("source message");
    expect(contents).toContain("target message");
    expect(contents.some((c) => c.includes(HANDOFF_OPEN_TAG))).toBe(false);
    expect(contents.some((c) => c.includes("<prelude>"))).toBe(false);
  });

  it("persists a provider_switch divider chunk on the target turn", async () => {
    const { instanceId, chatId } = await makeChat(DEFAULT_ANTHROPIC_MODEL_ID);
    backend.setScript([{ kind: "delta", text: "claude reply" }]);
    await send(instanceId, chatId, "hello");
    await patchModel(instanceId, chatId, DEFAULT_OPENAI_MODEL_ID);
    backend.setScript([{ kind: "delta", text: "codex reply" }]);
    await send(instanceId, chatId, "continue");

    const tip = chatManager.resolveTip(chatId)!;
    expect(tip.role).toBe("assistant");
    const chunks = chatManager.getMessageRenderChunks(chatId, [tip.id], false, false)[tip.id] ?? [];
    const marker = chunks.find((c) => c.kind === "provider_switch");
    expect(marker).toBeDefined();
    if (marker?.kind === "provider_switch") {
      expect(marker.fromProvider).toBe("anthropic");
      expect(marker.fromModel).toBe(DEFAULT_ANTHROPIC_MODEL_ID);
      expect(marker.toProvider).toBe("openai");
      expect(marker.toModel).toBe(DEFAULT_OPENAI_MODEL_ID);
    }
    // The divider leads the turn, before the assistant's reply.
    expect(chunks[0]?.kind).toBe("provider_switch");
    expect(chunks.some((c) => c.kind === "text" && c.text.includes("codex reply"))).toBe(true);

    // It survives a fresh read (persisted in the render projection, and the
    // prior Claude turn carries no divider).
    const refetched =
      chatManager.getMessageRenderChunks(chatId, [tip.id], false, false)[tip.id] ?? [];
    expect(refetched.some((c) => c.kind === "provider_switch")).toBe(true);
    const messages = chatManager.getMessages(chatId);
    const firstAssistant = messages.find((m) => m.role === "assistant")!;
    const firstChunks =
      chatManager.getMessageRenderChunks(chatId, [firstAssistant.id], false, false)[
        firstAssistant.id
      ] ?? [];
    expect(firstChunks.some((c) => c.kind === "provider_switch")).toBe(false);
  });

  it("summarizes an oversized conversation instead of dumping it raw", async () => {
    const { instanceId, chatId } = await makeChat(DEFAULT_ANTHROPIC_MODEL_ID);
    // A big source turn that also reports a small context window, so the whole
    // conversation cannot be handed to the target verbatim.
    const bigText = `RAWNEEDLE ${"x".repeat(180_000)}`;
    backend.setScript([
      { kind: "delta", text: "ok, working on it" },
      { kind: "usage", totalInput: 1_000, window: 80_000 },
    ]);
    await send(instanceId, chatId, bigText);
    expect(chatManager.get(chatId)?.modelContextWindow).toBe(80_000);

    await patchModel(instanceId, chatId, DEFAULT_OPENAI_MODEL_ID);
    backend.reduceCalls = [];
    backend.setScript([{ kind: "delta", text: "codex reply" }]);
    await send(instanceId, chatId, "continue please");

    // No forkable source session in this test (the fake never persisted one),
    // so the chunked fallback runs: at least one scratch turn, re-feeding the
    // raw conversation, with no fork.
    expect(backend.reduceCalls.length).toBeGreaterThanOrEqual(1);
    expect(backend.reduceCalls[0]!.message).toContain("RAWNEEDLE");
    expect(backend.reduceCalls[0]!.fork).toBeUndefined();

    // The target got the COMPACT summary, not the raw transcript.
    const sent = backend.lastOpts?.message ?? "";
    expect(sent).toContain(HANDOFF_OPEN_TAG);
    expect(sent).toContain("ROLLED SUMMARY");
    expect(sent).toContain("continue please");
    expect(sent).not.toContain("RAWNEEDLE");
    // Small: a summary, not 180 KB of transcript.
    expect(sent.length).toBeLessThan(30_000);
    // The switch still committed.
    expect(chatManager.get(chatId)?.provider).toBe("openai");
  });

  it("summarizes cheaply via a source-session fork when one is available", async () => {
    const { instanceId, chatId } = await makeChat(DEFAULT_ANTHROPIC_MODEL_ID);
    const bigText = `RAWNEEDLE ${"x".repeat(180_000)}`;
    // The source turn records a session anchor and a small window.
    backend.setScript([
      { kind: "meta", meta: { sessionId: "src-sess", anchorId: "src-anchor" } },
      { kind: "delta", text: "ok" },
      { kind: "usage", totalInput: 1_000, window: 80_000 },
    ]);
    await send(instanceId, chatId, bigText);
    // The fake backend doesn't persist the chat's session id (the real one
    // would), so set it explicitly; the switch captures it as the source.
    chatManager.updateSessionId(chatId, "src-sess");

    await patchModel(instanceId, chatId, DEFAULT_OPENAI_MODEL_ID);
    backend.reduceCalls = [];
    backend.setScript([{ kind: "delta", text: "codex reply" }]);
    await send(instanceId, chatId, "continue please");

    // Exactly one summarization turn, and it FORKED the source session (the
    // conversation is not re-fed: the fork already holds it).
    expect(backend.reduceCalls).toHaveLength(1);
    expect(backend.reduceCalls[0]!.sessionId).toBe("src-sess");
    expect(backend.reduceCalls[0]!.fork?.anchorId).toBe("src-anchor");
    expect(backend.reduceCalls[0]!.message).not.toContain("RAWNEEDLE");

    // Target got the compact summary and the switch committed.
    const sent = backend.lastOpts?.message ?? "";
    expect(sent).toContain("ROLLED SUMMARY");
    expect(sent).not.toContain("RAWNEEDLE");
    expect(chatManager.get(chatId)?.provider).toBe("openai");
  });

  it("stays retryable after a switch turn fails before committing", async () => {
    const { instanceId, chatId } = await makeChat(DEFAULT_ANTHROPIC_MODEL_ID);
    backend.setScript([{ kind: "delta", text: "on it" }]);
    await send(instanceId, chatId, "first");

    await patchModel(instanceId, chatId, DEFAULT_OPENAI_MODEL_ID);

    // The activation turn fails before the target accepts (no commit).
    backend.setScript([{ kind: "throw", message: "target boom" }]);
    await send(instanceId, chatId, "switch now");
    // The chat stays on the source and the switch is still pending.
    expect(chatManager.get(chatId)?.provider).toBe("anthropic");
    expect((await getChat(instanceId, chatId)).pendingSwitch).toBeDefined();

    // The retry (a new message on the same branch, past the failed turn's
    // orphan user row) still activates the switch thanks to the lineage check.
    backend.setScript([{ kind: "delta", text: "codex reply" }]);
    await send(instanceId, chatId, "try again");
    expect(backend.lastOpts?.model).toBe(DEFAULT_OPENAI_MODEL_ID);
    expect(backend.lastOpts?.message).toContain(HANDOFF_OPEN_TAG);
    expect(chatManager.get(chatId)?.provider).toBe("openai");
  });

  it("a branch change invalidates a pending switch", async () => {
    const { instanceId, chatId } = await makeChat(DEFAULT_ANTHROPIC_MODEL_ID);
    backend.setScript([{ kind: "delta", text: "one" }]);
    await send(instanceId, chatId, "m1");
    const originalTip = chatManager.resolveTip(chatId)!; // a1

    // Edit m1 to fork a sibling branch; the chat's active leaf moves to it.
    const m1 = chatManager.getMessages(chatId).find((m) => m.role === "user")!;
    backend.setScript([{ kind: "delta", text: "one-b" }]);
    const editRes = await fetch(
      `${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages/${m1.id}/edit`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "m1 edited" }),
      },
    );
    expect(editRes.status).toBe(200);
    await drain(editRes);
    // The switch is recorded on the edited branch's tip.
    const patched = await patchModel(instanceId, chatId, DEFAULT_OPENAI_MODEL_ID);
    expect(patched.pendingSwitch).toBeDefined();

    // Navigate back to the original branch: a genuinely different tip.
    const res = await fetch(`${baseUrl}/api/instances/${instanceId}/chats/${chatId}/active-leaf`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ leafId: originalTip.id }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pendingSwitch?: unknown };
    expect(body.pendingSwitch).toBeUndefined();

    // A subsequent send stays on the source provider (switch was dropped).
    backend.setScript([{ kind: "delta", text: "three" }]);
    await send(instanceId, chatId, "m3");
    expect(chatManager.get(chatId)?.provider).toBe("anthropic");
  });

  it("selecting back to the current provider reverts a pending switch", async () => {
    const { instanceId, chatId } = await makeChat(DEFAULT_ANTHROPIC_MODEL_ID);
    backend.setScript([{ kind: "delta", text: "x" }]);
    await send(instanceId, chatId, "hello");
    const toCodex = await patchModel(instanceId, chatId, DEFAULT_OPENAI_MODEL_ID);
    expect(toCodex.pendingSwitch).toBeDefined();
    // Pick a different anthropic model (same provider as the chat) → revert.
    const back = await patchModel(instanceId, chatId, "claude-sonnet-5");
    expect(back.pendingSwitch).toBeUndefined();
    expect(back.provider).toBe("anthropic");
    expect(back.model).toBe("claude-sonnet-5");

    backend.setScript([{ kind: "delta", text: "y" }]);
    await send(instanceId, chatId, "again");
    // No handoff was injected: still a same-provider chat.
    expect(backend.lastOpts?.message.includes(HANDOFF_OPEN_TAG)).toBe(false);
    expect(chatManager.get(chatId)?.provider).toBe("anthropic");
  });
});
