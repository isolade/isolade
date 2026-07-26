import { beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "crypto";
import { ProviderSwitchStore } from "../src/chat/provider-switch-store";
import { ChatManager } from "../src/chats";
import { createDb, schema } from "../src/db";

function makeDb() {
  return createDb(":memory:");
}

function makeInstanceId(db: ReturnType<typeof makeDb>) {
  const id = randomUUID();
  db.insert(schema.instances)
    .values({
      id,
      vmId: `vm-${id.slice(0, 8)}`,
      status: "running",
      image: "img",
      profileId: "default",
    })
    .run();
  return id;
}

describe("ProviderSwitchStore", () => {
  let db: ReturnType<typeof makeDb>;
  let store: ProviderSwitchStore;
  let chatId: string;

  const input = () => ({
    sourceLeafId: "leaf-1",
    sourceProvider: "anthropic" as const,
    sourceModel: "claude-opus-4-8",
    sourceSessionId: "sess-1",
    sourceAnchorId: "anchor-1",
    targetProvider: "openai" as const,
    targetModel: "gpt-5.6-sol",
    targetEffort: "medium",
  });

  beforeEach(() => {
    db = makeDb();
    store = new ProviderSwitchStore(db);
    chatId = randomUUID();
  });

  it("records a pending switch and reads it back", () => {
    const row = store.upsert(chatId, input());
    expect(row.status).toBe("pending");
    expect(row.sourceProvider).toBe("anthropic");
    expect(row.targetProvider).toBe("openai");
    expect(row.targetModel).toBe("gpt-5.6-sol");
    expect(store.get(chatId)?.targetEffort).toBe("medium");
  });

  it("replaces (not stacks) the pending switch on a new selection and resets progress", () => {
    store.upsert(chatId, input());
    store.update(chatId, { status: "activating", auxSessionId: "aux-1", auxTurnId: "turn-1" });

    // Selecting yet another target before sending replaces the row and clears
    // any progress from the previous target.
    const replaced = store.upsert(chatId, { ...input(), targetModel: "gpt-5.6-terra" });
    expect(replaced.status).toBe("pending");
    expect(replaced.targetModel).toBe("gpt-5.6-terra");
    expect(replaced.auxSessionId).toBeNull();
    expect(replaced.auxTurnId).toBeNull();
    // Still exactly one row for the chat.
    expect(store.listAll().filter((r) => r.chatId === chatId)).toHaveLength(1);
  });

  it("advances status without clobbering earlier auxiliary references", () => {
    store.upsert(chatId, input());
    store.update(chatId, { auxSessionId: "aux-fork", auxTurnId: "turn-42" });
    // A later status bump touches only status, preserving the aux refs so a
    // completed source-side summary is reused across a retry.
    const bumped = store.update(chatId, { status: "activating" });
    expect(bumped?.status).toBe("activating");
    expect(bumped?.auxSessionId).toBe("aux-fork");
    expect(bumped?.auxTurnId).toBe("turn-42");
  });

  it("marks a failed step retryable while keeping aux refs", () => {
    store.upsert(chatId, input());
    store.update(chatId, { auxSessionId: "aux-fork", auxTurnId: "turn-42" });
    const failed = store.fail(chatId, "target-unavailable", "429 usage exhausted");
    expect(failed?.status).toBe("failed");
    expect(failed?.errorClass).toBe("target-unavailable");
    expect(failed?.lastError).toBe("429 usage exhausted");
    // The aux summary survives the failure so a retry reuses it.
    expect(failed?.auxSessionId).toBe("aux-fork");
    // The row is still present (retryable), not deleted.
    expect(store.get(chatId)).toBeDefined();
  });

  it("clears the switch on commit / branch change", () => {
    store.upsert(chatId, input());
    store.clear(chatId);
    expect(store.get(chatId)).toBeUndefined();
  });

  it("update on a missing switch is a no-op returning undefined", () => {
    expect(store.update(chatId, { status: "failed" })).toBeUndefined();
  });
});

describe("ChatManager cross-provider helpers", () => {
  let db: ReturnType<typeof makeDb>;
  let cm: ChatManager;
  let instanceId: string;

  beforeEach(() => {
    db = makeDb();
    cm = new ChatManager(db);
    instanceId = makeInstanceId(db);
  });

  it("resetActiveUsage nulls the active-session usage columns", () => {
    const chat = cm.create(instanceId, "claude-opus-4-8", "anthropic", "high");
    cm.updateUsage(chat.id, {
      total: {
        inputTokens: 500_000,
        cachedInputTokens: 10,
        cacheCreationInputTokens: 20,
        outputTokens: 30,
        reasoningOutputTokens: 40,
      },
      last: {
        inputTokens: 100,
        cachedInputTokens: 1,
        cacheCreationInputTokens: 2,
        outputTokens: 3,
        reasoningOutputTokens: 4,
      },
      modelContextWindow: 1_000_000,
      costUsd: 12.5,
    });
    cm.markCompacted(chat.id);
    expect(cm.get(chat.id)?.inputTokens).toBe(500_000);

    cm.resetActiveUsage(chat.id);
    const after = cm.get(chat.id)!;
    expect(after.inputTokens).toBeNull();
    expect(after.outputTokens).toBeNull();
    expect(after.lastInputTokens).toBeNull();
    expect(after.modelContextWindow).toBeNull();
    expect(after.compacted).toBeNull();
    expect(after.costUsd).toBeNull();
  });

  it("resetActiveUsage lets the first target usage event log a real delta", () => {
    const chat = cm.create(instanceId, "claude-opus-4-8", "anthropic", "high");
    // A large source-session total.
    cm.updateUsage(chat.id, {
      total: {
        inputTokens: 800_000,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
      },
      last: {
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
      },
      costUsd: 20,
    });
    const before = db
      .select()
      .from(schema.usageEvents)
      .all()
      .filter((e) => e.kind === "usage").length;

    // Target-session commit resets the active counters ...
    cm.resetActiveUsage(chat.id);
    // ... so the target's first (smaller) cumulative total is not clamped away.
    cm.updateUsage(chat.id, {
      total: {
        inputTokens: 5_000,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
        outputTokens: 1_000,
        reasoningOutputTokens: 0,
      },
      last: {
        inputTokens: 5_000,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
        outputTokens: 1_000,
        reasoningOutputTokens: 0,
      },
      costUsd: 0.3,
    });
    const usageEvents = db
      .select()
      .from(schema.usageEvents)
      .all()
      .filter((e) => e.kind === "usage");
    expect(usageEvents.length).toBe(before + 1);
    const latest = usageEvents.at(-1)!;
    // Without the reset, 5_000 - 800_000 would clamp to 0 and be dropped.
    expect(latest.inputTokens).toBe(5_000);
    expect(latest.outputTokens).toBe(1_000);
    expect(latest.costUsd).toBeCloseTo(0.3, 5);
  });

  it("resolveForkPoint returns null when the edited prefix crosses providers", () => {
    const chat = cm.create(instanceId, "claude-opus-4-8", "anthropic", "high");
    // A Codex turn near the tip, then a Claude turn deeper in the prefix.
    const root = cm.addMessage(chat.id, "user", "u1", { parentId: null });
    const codexTurn = cm.addMessage(chat.id, "assistant", "a1", {
      parentId: root.id,
      provider: "openai",
      sessionId: "codex-thread",
      anchorId: "codex-turn",
    });
    const u2 = cm.addMessage(chat.id, "user", "u2", { parentId: codexTurn.id });

    // Editing after a Codex turn while the chat is (again) on Claude: the
    // nearest anchor is Codex's, so a Claude native fork is invalid.
    expect(cm.resolveForkPoint(u2.id, "anthropic")).toBeNull();
    // Codex itself can still fork its own anchor.
    expect(cm.resolveForkPoint(u2.id, "openai")).toEqual({
      sessionId: "codex-thread",
      anchorId: "codex-turn",
    });
    // With no provider filter, behavior is unchanged (nearest anchor wins).
    expect(cm.resolveForkPoint(u2.id)).toEqual({
      sessionId: "codex-thread",
      anchorId: "codex-turn",
    });
  });

  it("finalizeTurn behavior is unaffected by the new provider column default", () => {
    const chat = cm.create(instanceId, "claude-opus-4-8", "anthropic", "high");
    const user = cm.beginTurn(chat.id, "assist-1", "hi", null);
    const msg = cm.finalizeTurn(
      chat.id,
      "assist-1",
      "hello",
      { parentId: user.id, provider: "anthropic", model: "claude-opus-4-8" },
      [],
    );
    expect(msg?.provider).toBe("anthropic");
    expect(msg?.model).toBe("claude-opus-4-8");
  });
});
