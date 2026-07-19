import { beforeEach, describe, expect, it } from "bun:test";
import { localDay } from "@isolade/shared";
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { ChatManager } from "../src/chats";
import { createDb, schema } from "../src/db";

function makeDb() {
  return createDb(":memory:");
}

function makeInstanceId(db: ReturnType<typeof makeDb>, profileId: string | null = "default") {
  const id = randomUUID();
  db.insert(schema.instances)
    .values({
      id,
      vmId: `vm-${id.slice(0, 8)}`,
      status: "running",
      image: "test-image",
      profileId,
    })
    .run();
  return id;
}

describe("ChatManager", () => {
  let db: ReturnType<typeof makeDb>;
  let cm: ChatManager;
  let instanceId: string;

  beforeEach(() => {
    db = makeDb();
    cm = new ChatManager(db);
    instanceId = makeInstanceId(db);
  });

  describe("create / get", () => {
    it("creates a chat and returns it", () => {
      const chat = cm.create(instanceId, "claude-sonnet-4-5", "anthropic", "high");
      expect(chat.id).toBeTruthy();
      expect(chat.instanceId).toBe(instanceId);
      expect(chat.model).toBe("claude-sonnet-4-5");
      expect(chat.provider).toBe("anthropic");
    });

    it("get returns the chat by id", () => {
      const created = cm.create(instanceId, "claude-sonnet-4-5", "anthropic", "high");
      const got = cm.get(created.id);
      expect(got?.id).toBe(created.id);
    });

    it("get returns undefined for unknown id", () => {
      expect(cm.get("nonexistent")).toBeUndefined();
    });
  });

  describe("list / listAll", () => {
    it("list returns only chats for the given instance", () => {
      const id2 = makeInstanceId(db);
      cm.create(instanceId, "claude-sonnet-4-5", "anthropic", "high");
      cm.create(instanceId, "claude-opus-4-5", "anthropic", "high");
      cm.create(id2, "gpt-4.1", "openai", "high");

      const list = cm.list(instanceId);
      expect(list).toHaveLength(2);
      expect(list.every((c) => c.instanceId === instanceId)).toBe(true);
    });

    it("listAll returns all chats across instances", () => {
      const id2 = makeInstanceId(db);
      cm.create(instanceId, "claude-sonnet-4-5", "anthropic", "high");
      cm.create(id2, "gpt-4.1", "openai", "high");

      expect(cm.listAll()).toHaveLength(2);
    });
  });

  describe("remove", () => {
    it("removes the chat and its messages", () => {
      const chat = cm.create(instanceId, "claude-sonnet-4-5", "anthropic", "high");
      cm.addMessage(chat.id, "user", "hello");
      cm.addMessage(chat.id, "assistant", "hi");

      cm.remove(chat.id);

      expect(cm.get(chat.id)).toBeUndefined();
      expect(cm.getMessages(chat.id)).toHaveLength(0);
    });

    it("removeForInstance removes all chats + messages for the instance", () => {
      const chat1 = cm.create(instanceId, "claude-sonnet-4-5", "anthropic", "high");
      const chat2 = cm.create(instanceId, "claude-opus-4-5", "anthropic", "high");
      cm.addMessage(chat1.id, "user", "hello");
      cm.addMessage(chat2.id, "user", "world");

      cm.removeForInstance(instanceId);

      expect(cm.list(instanceId)).toHaveLength(0);
      expect(cm.getMessages(chat1.id)).toHaveLength(0);
      expect(cm.getMessages(chat2.id)).toHaveLength(0);
    });

    it("removeForInstance leaves other instances' chats intact", () => {
      const id2 = makeInstanceId(db);
      cm.create(instanceId, "claude-sonnet-4-5", "anthropic", "high");
      cm.create(id2, "gpt-4.1", "openai", "high");

      cm.removeForInstance(instanceId);

      expect(cm.list(id2)).toHaveLength(1);
    });
  });

  describe("messages", () => {
    it("addMessage stores a message and getMessages returns it", () => {
      const chat = cm.create(instanceId, "claude-sonnet-4-5", "anthropic", "high");
      cm.addMessage(chat.id, "user", "hello");

      const msgs = cm.getMessages(chat.id);
      expect(msgs).toHaveLength(1);
      expect(msgs[0]!.role).toBe("user");
      expect(msgs[0]!.content).toBe("hello");
      expect(msgs[0]!.chatId).toBe(chat.id);
    });

    it("getMessages returns messages in insertion order", () => {
      const chat = cm.create(instanceId, "claude-sonnet-4-5", "anthropic", "high");
      cm.addMessage(chat.id, "user", "first");
      cm.addMessage(chat.id, "assistant", "second");
      cm.addMessage(chat.id, "user", "third");

      const msgs = cm.getMessages(chat.id);
      expect(msgs.map((m) => m.content)).toEqual(["first", "second", "third"]);
    });

    it("getMessages returns empty array for chat with no messages", () => {
      const chat = cm.create(instanceId, "claude-sonnet-4-5", "anthropic", "high");
      expect(cm.getMessages(chat.id)).toHaveLength(0);
    });
  });

  describe("events", () => {
    it("getEventsForMessage returns only that message's events, ordered by seq", () => {
      const chat = cm.create(instanceId, "claude-sonnet-4-5", "anthropic", "high");
      // Two interleaved turns under the same chat, inserted out of order.
      cm.appendEvent(chat.id, "msg-b", 0, "delta", "b0");
      cm.appendEvent(chat.id, "msg-a", 1, "delta", "a1");
      cm.appendEvent(chat.id, "msg-a", 0, "delta", "a0");
      cm.appendEvent(chat.id, "msg-b", 1, "delta", "b1");

      const a = cm.getEventsForMessage("msg-a");
      expect(a.map((e) => e.seq)).toEqual([0, 1]);
      expect(a.map((e) => e.payload)).toEqual([JSON.stringify("a0"), JSON.stringify("a1")]);
    });

    it("getEventsForMessage filters by afterSeq (exclusive)", () => {
      const chat = cm.create(instanceId, "claude-sonnet-4-5", "anthropic", "high");
      for (let seq = 0; seq < 5; seq++) {
        cm.appendEvent(chat.id, "m", seq, "delta", `d${seq}`);
      }
      expect(cm.getEventsForMessage("m", 2).map((e) => e.seq)).toEqual([3, 4]);
      expect(cm.getEventsForMessage("m", -1).map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
    });

    it("getEventsForMessage excludes the seq=-1 turn_started marker by default", () => {
      const chat = cm.create(instanceId, "claude-sonnet-4-5", "anthropic", "high");
      cm.appendEvent(chat.id, "m", -1, "turn_started", null);
      cm.appendEvent(chat.id, "m", 0, "delta", "hi");
      expect(cm.getEventsForMessage("m").map((e) => e.seq)).toEqual([0]);
    });

    it("getEventsForMessage returns empty for an unknown message", () => {
      expect(cm.getEventsForMessage("nope")).toEqual([]);
    });

    it("getEvents returns a chat's events ordered by (messageId, seq)", () => {
      const chat = cm.create(instanceId, "claude-sonnet-4-5", "anthropic", "high");
      // Insert across two messages, out of order.
      cm.appendEvent(chat.id, "m2", 1, "delta", "m2.1");
      cm.appendEvent(chat.id, "m1", 0, "delta", "m1.0");
      cm.appendEvent(chat.id, "m2", 0, "delta", "m2.0");
      cm.appendEvent(chat.id, "m1", 1, "delta", "m1.1");
      const ordered = cm.getEvents(chat.id).map((e) => [e.messageId, e.seq]);
      expect(ordered).toEqual([
        ["m1", 0],
        ["m1", 1],
        ["m2", 0],
        ["m2", 1],
      ]);
    });
  });

  describe("getAggregateTotals", () => {
    const setUsage = (id: string, inputTokens: number, outputTokens: number, costUsd: number) =>
      cm.updateUsage(id, {
        total: {
          inputTokens,
          cachedInputTokens: 0,
          cacheCreationInputTokens: 0,
          outputTokens,
          reasoningOutputTokens: 0,
        },
        last: {
          inputTokens,
          cachedInputTokens: 0,
          cacheCreationInputTokens: 0,
          outputTokens,
          reasoningOutputTokens: 0,
        },
        costUsd,
      });

    it("splits totals per provider and sums tokens + cost", () => {
      const a1 = cm.create(instanceId, "claude-sonnet-4-5", "anthropic", "high");
      const a2 = cm.create(instanceId, "claude-sonnet-4-5", "anthropic", "high");
      const o1 = cm.create(instanceId, "gpt-4.1", "openai", "high");
      setUsage(a1.id, 1000, 100, 0.5);
      setUsage(a2.id, 2000, 200, 1.0);
      setUsage(o1.id, 500, 50, 0.1);

      const agg = cm.getAggregateTotals();
      expect(agg.anthropic.chats).toBe(2);
      expect(agg.openai.chats).toBe(1);
      expect(agg.total.chats).toBe(3);
      expect(agg.anthropic.inputTokens).toBe(3000);
      expect(agg.openai.inputTokens).toBe(500);
      expect(agg.total.inputTokens).toBe(3500);
      expect(agg.total.outputTokens).toBe(350);
      expect(agg.anthropic.costUsd).toBeCloseTo(1.5);
      expect(agg.total.costUsd).toBeCloseTo(1.6);
    });

    it("counts a chat with no usage recorded as zero, not a crash", () => {
      cm.create(instanceId, "claude-sonnet-4-5", "anthropic", "high");
      const agg = cm.getAggregateTotals();
      expect(agg.anthropic.chats).toBe(1);
      expect(agg.anthropic.inputTokens).toBe(0);
      expect(agg.total.costUsd).toBe(0);
    });

    it("can scope totals to one profile", () => {
      const p1 = "profile-one";
      const p2 = "profile-two";
      const p1Instance = makeInstanceId(db, p1);
      const p2Instance = makeInstanceId(db, p2);
      const p1Chat = cm.create(p1Instance, "claude-sonnet-4-5", "anthropic", "high");
      const p2Chat = cm.create(p2Instance, "gpt-4.1", "openai", "high");
      setUsage(p1Chat.id, 1000, 100, 0.5);
      setUsage(p2Chat.id, 2000, 200, 1.0);

      const agg = cm.getAggregateTotals(p1);

      expect(agg.total.chats).toBe(1);
      expect(agg.anthropic.chats).toBe(1);
      expect(agg.openai.chats).toBe(0);
      expect(agg.total.inputTokens).toBe(1000);
      expect(agg.total.costUsd).toBeCloseTo(0.5);
    });

    it("keeps a deleted chat's usage in the lifetime totals", () => {
      const chat = cm.create(instanceId, "claude-sonnet-4-5", "anthropic", "high");
      setUsage(chat.id, 1000, 100, 0.5);

      cm.remove(chat.id);

      // The chats table no longer has the row, but the rollup does.
      expect(cm.get(chat.id)).toBeUndefined();
      const agg = cm.getAggregateTotals();
      expect(agg.total.chats).toBe(1);
      expect(agg.total.inputTokens).toBe(1000);
      expect(agg.total.costUsd).toBeCloseTo(0.5);
    });

    it("keeps a profile's usage after its instance is deleted", () => {
      const p = "profile-x";
      const inst = makeInstanceId(db, p);
      const chat = cm.create(inst, "claude-sonnet-4-5", "anthropic", "high");
      setUsage(chat.id, 1000, 100, 0.5);

      db.delete(schema.instances).where(eq(schema.instances.id, inst)).run();
      cm.remove(chat.id);

      const agg = cm.getAggregateTotals(p);
      expect(agg.total.chats).toBe(1);
      expect(agg.total.inputTokens).toBe(1000);
      expect(agg.total.costUsd).toBeCloseTo(0.5);
    });

    it("derives effective input tokens (pricing-weighted) into the buckets", () => {
      // A real catalog id so pricingFor resolves (unlike the placeholder id the
      // other cases use, which has no pricing → effective 0).
      const chat = cm.create(instanceId, "claude-opus-4-8", "anthropic", "high");
      setUsage(chat.id, 1000, 100, 0.5);
      const agg = cm.getAggregateTotals();
      // effective = input + cacheWrite + cacheRead·ratio + output·outputRatio.
      // With input+output and real pricing it strictly exceeds the raw input,
      // a zero here would mean pricing/derivation was lost.
      expect(agg.anthropic.effectiveInputTokens).toBeGreaterThan(1000);
      expect(agg.total.effectiveInputTokens).toBeCloseTo(agg.anthropic.effectiveInputTokens);
    });
  });

  describe("getUsageHistory", () => {
    // usage events carry the *cumulative* per-chat total. The history series
    // must record only each event's delta.
    const cumulative = (id: string, inputTokens: number, outputTokens: number, costUsd: number) =>
      cm.updateUsage(id, {
        total: {
          inputTokens,
          cachedInputTokens: 0,
          cacheCreationInputTokens: 0,
          outputTokens,
          reasoningOutputTokens: 0,
        },
        last: {
          inputTokens,
          cachedInputTokens: 0,
          cacheCreationInputTokens: 0,
          outputTokens,
          reasoningOutputTokens: 0,
        },
        costUsd,
      });

    it("accumulates deltas (not cumulative totals) into today's bucket", () => {
      const today = localDay(new Date());
      const chat = cm.create(instanceId, "claude-sonnet-4-5", "anthropic", "high");
      cumulative(chat.id, 1000, 100, 0.5); // first event: +1000/+100/+$0.50
      cumulative(chat.id, 2500, 250, 1.25); // running total grows: delta +1500/+150/+$0.75

      const history = cm.getUsageHistory();
      expect(history).toHaveLength(1);
      const day = history[0]!;
      expect(day.day).toBe(today);
      // Sum of the two deltas, not the final cumulative counted twice.
      expect(day.inputTokens).toBe(2500);
      expect(day.outputTokens).toBe(250);
      expect(day.costUsd).toBeCloseTo(1.25);
      expect(day.anthropicCostUsd).toBeCloseTo(1.25);
    });

    it("splits a day's cost across providers but sums the total", () => {
      const a = cm.create(instanceId, "claude-sonnet-4-5", "anthropic", "high");
      const o = cm.create(instanceId, "gpt-4.1", "openai", "high");
      cumulative(a.id, 1000, 100, 2.0);
      cumulative(o.id, 500, 50, 0.5);

      const [day] = cm.getUsageHistory();
      expect(day!.costUsd).toBeCloseTo(2.5);
      expect(day!.anthropicCostUsd).toBeCloseTo(2.0);
      expect(day!.openaiCostUsd).toBeCloseTo(0.5);
    });

    it("records nothing for a usage event that adds no tokens or cost", () => {
      const chat = cm.create(instanceId, "claude-sonnet-4-5", "anthropic", "high");
      cumulative(chat.id, 1000, 100, 0.5);
      // A later event with the same cumulative (e.g. one that only refreshes
      // the context window) contributes a zero delta.
      cumulative(chat.id, 1000, 100, 0.5);

      const [day] = cm.getUsageHistory();
      expect(day!.inputTokens).toBe(1000);
      expect(day!.costUsd).toBeCloseTo(0.5);
    });

    it("returns an empty series when nothing has been recorded", () => {
      expect(cm.getUsageHistory()).toEqual([]);
    });

    it("omits a day where a chat was created but no turns ran", () => {
      cm.create(instanceId, "claude-sonnet-4-5", "anthropic", "high");
      // The chats-only marker must not surface as a heatmap day (spend view)…
      expect(cm.getUsageHistory()).toEqual([]);
      // …but the chat still counts toward the lifetime total.
      expect(cm.getAggregateTotals().total.chats).toBe(1);
    });

    it("can scope daily history to one profile", () => {
      const p1 = "profile-one";
      const p2 = "profile-two";
      const p1Instance = makeInstanceId(db, p1);
      const p2Instance = makeInstanceId(db, p2);
      const p1Chat = cm.create(p1Instance, "claude-sonnet-4-5", "anthropic", "high");
      const p2Chat = cm.create(p2Instance, "gpt-4.1", "openai", "high");
      cumulative(p1Chat.id, 1000, 100, 0.5);
      cumulative(p2Chat.id, 2000, 200, 1.0);

      const history = cm.getUsageHistory(p1);

      expect(history).toHaveLength(1);
      expect(history[0]!.inputTokens).toBe(1000);
      expect(history[0]!.costUsd).toBeCloseTo(0.5);
      expect(cm.getUsageHistory(p2)[0]!.inputTokens).toBe(2000);
    });
  });

  describe("usage event log", () => {
    const usageEvent = (id: string, totalInput: number, deltaInput: number, costUsd: number) =>
      cm.updateUsage(id, {
        total: {
          inputTokens: totalInput,
          cachedInputTokens: 0,
          cacheCreationInputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
        },
        last: {
          inputTokens: deltaInput,
          cachedInputTokens: 0,
          cacheCreationInputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
        },
        costUsd,
      });

    it("appends one row per event, keeping the turn's model and a timestamp", () => {
      const chat = cm.create(instanceId, "claude-opus-4-8", "anthropic", "high");
      usageEvent(chat.id, 1000, 1000, 0.5); // first turn: delta 1000
      usageEvent(chat.id, 2500, 1500, 1.25); // running total grows: delta 1500

      const rows = db.select().from(schema.usageEvents).all();
      // One creation marker + two usage events, not one aggregated bucket.
      expect(rows.filter((r) => r.kind === "chat_created")).toHaveLength(1);
      const usage = rows.filter((r) => r.kind === "usage");
      expect(usage).toHaveLength(2);
      expect(usage.map((r) => r.inputTokens).toSorted((a, b) => a - b)).toEqual([1000, 1500]);
      expect(usage.every((r) => r.model === "claude-opus-4-8")).toBe(true);
      expect(usage.every((r) => r.createdAt instanceof Date)).toBe(true);
    });

    it("drops a zero-delta usage event (context-window-only refresh)", () => {
      const chat = cm.create(instanceId, "claude-opus-4-8", "anthropic", "high");
      usageEvent(chat.id, 1000, 1000, 0.5);
      usageEvent(chat.id, 1000, 0, 0.5); // same cumulative → no new activity
      const usage = db
        .select()
        .from(schema.usageEvents)
        .all()
        .filter((r) => r.kind === "usage");
      expect(usage).toHaveLength(1);
    });
  });

  describe("updateSessionId", () => {
    it("persists claude session id", () => {
      const chat = cm.create(instanceId, "claude-sonnet-4-5", "anthropic", "high");
      cm.updateSessionId(chat.id, "sess-abc");
      expect(cm.get(chat.id)?.claudeSessionId).toBe("sess-abc");
    });

    it("persists codex thread id", () => {
      const chat = cm.create(instanceId, "gpt-4.1", "openai", "high");
      cm.updateSessionId(chat.id, undefined, "thread-xyz");
      expect(cm.get(chat.id)?.codexThreadId).toBe("thread-xyz");
    });

    it("is a no-op when called with no arguments", () => {
      const chat = cm.create(instanceId, "claude-sonnet-4-5", "anthropic", "high");
      cm.updateSessionId(chat.id);
      expect(cm.get(chat.id)?.claudeSessionId).toBeNull();
    });
  });

  describe("message tree", () => {
    // A linear two-turn chat with session snapshots, the shape every branchy
    // structure below grows out of: u1 → a1 → u2 → a2.
    function seedLinearChat() {
      const chat = cm.create(instanceId, "claude-sonnet-4-5", "anthropic", "high");
      const u1 = cm.addMessage(chat.id, "user", "first question");
      const a1 = cm.addMessage(chat.id, "assistant", "first answer", {
        parentId: u1.id,
        sessionId: "sess-1",
        anchorId: "anchor-1",
      });
      const u2 = cm.addMessage(chat.id, "user", "second question", { parentId: a1.id });
      const a2 = cm.addMessage(chat.id, "assistant", "second answer", {
        parentId: u2.id,
        sessionId: "sess-1",
        anchorId: "anchor-2",
      });
      cm.setActiveLeaf(chat.id, a2.id);
      return { chat, u1, a1, u2, a2 };
    }

    it("addMessage persists parent and session metadata", () => {
      const { chat, u1, a1 } = seedLinearChat();
      const msgs = cm.getMessages(chat.id);
      expect(msgs[0]?.parentId).toBeNull();
      expect(msgs[1]?.parentId).toBe(u1.id);
      expect(msgs[1]?.sessionId).toBe("sess-1");
      expect(msgs[1]?.anchorId).toBe("anchor-1");
      expect(msgs[2]?.parentId).toBe(a1.id);
    });

    it("setMessageTurnMeta stamps snapshots onto an existing row", () => {
      const { chat, u2 } = seedLinearChat();
      const a = cm.addMessage(chat.id, "assistant", "partial", { parentId: u2.id });
      cm.setMessageTurnMeta(a.id, { sessionId: "sess-9", anchorId: "anchor-9" });
      const row = cm.getMessage(a.id);
      expect(row?.sessionId).toBe("sess-9");
      expect(row?.anchorId).toBe("anchor-9");
    });

    it("resolveTip follows the active leaf", () => {
      const { chat, a2 } = seedLinearChat();
      expect(cm.resolveTip(chat.id)?.id).toBe(a2.id);
    });

    it("resolveTip descends from a stale mid-branch leaf to the branch end", () => {
      const { chat, u2, a2 } = seedLinearChat();
      cm.setActiveLeaf(chat.id, u2.id);
      expect(cm.resolveTip(chat.id)?.id).toBe(a2.id);
    });

    it("resolveTip falls back to the newest message for legacy rows (null leaf)", () => {
      const { chat, a2 } = seedLinearChat();
      cm.setActiveLeaf(chat.id, null);
      expect(cm.resolveTip(chat.id)?.id).toBe(a2.id);
    });

    it("resolveTip prefers the newest sibling branch when descending", () => {
      const { chat, u1, a1 } = seedLinearChat();
      // Edit of u2: a sibling under a1, whose branch is newer than a2's.
      const u2b = cm.addMessage(chat.id, "user", "second question, edited", { parentId: a1.id });
      cm.setActiveLeaf(chat.id, u1.id);
      expect(cm.resolveTip(chat.id)?.id).toBe(u2b.id);
    });

    it("resolveTip is undefined for an empty chat", () => {
      const chat = cm.create(instanceId, "claude-sonnet-4-5", "anthropic", "high");
      expect(cm.resolveTip(chat.id)).toBeUndefined();
    });

    it("resolveForkPoint finds the nearest anchored assistant ancestor", () => {
      const { u2, a2 } = seedLinearChat();
      // Editing a2's follow-up would fork at a2 itself…
      expect(cm.resolveForkPoint(a2.id)).toEqual({ sessionId: "sess-1", anchorId: "anchor-2" });
      // …and editing u2 forks at a1 (u2's parent path starts at a1).
      const editedParent = cm.getMessage(u2.id)?.parentId ?? null;
      expect(cm.resolveForkPoint(editedParent)).toEqual({
        sessionId: "sess-1",
        anchorId: "anchor-1",
      });
    });

    it("resolveForkPoint skips assistant rows without snapshots", () => {
      const { chat, a2 } = seedLinearChat();
      const u3 = cm.addMessage(chat.id, "user", "third", { parentId: a2.id });
      // An interrupted turn that never reported its anchor.
      const a3 = cm.addMessage(chat.id, "assistant", "partial", {
        parentId: u3.id,
        sessionId: "sess-1",
      });
      expect(cm.resolveForkPoint(a3.id)).toEqual({ sessionId: "sess-1", anchorId: "anchor-2" });
    });

    it("resolveForkPoint is null at the root and for legacy chains", () => {
      const { u1 } = seedLinearChat();
      expect(cm.resolveForkPoint(null)).toBeNull();
      expect(cm.resolveForkPoint(cm.getMessage(u1.id)?.parentId ?? null)).toBeNull();
      const legacyChat = cm.create(instanceId, "claude-sonnet-4-5", "anthropic", "high");
      const lu = cm.addMessage(legacyChat.id, "user", "old");
      const la = cm.addMessage(legacyChat.id, "assistant", "old answer", { parentId: lu.id });
      expect(cm.resolveForkPoint(la.id)).toBeNull();
    });

    it("a provider swap clears per-message session snapshots (stale fork anchors)", () => {
      const { chat, a1, a2 } = seedLinearChat();
      cm.updateModel(chat.id, "gpt-5.4", "openai", "high");
      // The old provider's session ids would be garbage to the new provider's
      // fork mechanism, so edits must fall back to a fresh session.
      expect(cm.getMessage(a1.id)?.sessionId).toBeNull();
      expect(cm.getMessage(a2.id)?.anchorId).toBeNull();
      expect(cm.resolveForkPoint(a2.id)).toBeNull();
    });

    it("a same-provider model swap keeps per-message session snapshots", () => {
      const { chat, a2 } = seedLinearChat();
      cm.updateModel(chat.id, "claude-opus-4-8", "anthropic", "high");
      expect(cm.resolveForkPoint(a2.id)).toEqual({ sessionId: "sess-1", anchorId: "anchor-2" });
    });

    it("resolveBranchSession returns the branch's nearest recorded session", () => {
      const { chat, a1, a2 } = seedLinearChat();
      expect(cm.resolveBranchSession(a2.id)).toBe("sess-1");
      // A forked branch records its own session on its assistant turn.
      const u2b = cm.addMessage(chat.id, "user", "edited", { parentId: a1.id });
      const a2b = cm.addMessage(chat.id, "assistant", "forked answer", {
        parentId: u2b.id,
        sessionId: "sess-2",
        anchorId: "anchor-2b",
      });
      expect(cm.resolveBranchSession(a2b.id)).toBe("sess-2");
      // Before the forked turn lands, the branch still reads the prefix session.
      expect(cm.resolveBranchSession(u2b.id)).toBe("sess-1");
    });
  });
});
