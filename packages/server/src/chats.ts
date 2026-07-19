import { randomUUID } from "crypto";
import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import { effectiveInputTokens, pricingFor } from "./chat/subscription-share";
import type {
  AggregateTotals,
  AggregateTotalsBucket,
  ChatEffort,
  ChatProvider,
  UsageDay,
} from "./contracts";
import { localDay, resolveEffort } from "./contracts";
import type { Db } from "./db";
import { schema } from "./db";
import type { ChatMessage, Chat as ChatRow } from "./db/schema";

// Optional tree/session metadata for a message insert. `parentId` links the
// message into the tree (null = chat root). `sessionId`/`anchorId` snapshot
// the provider session an assistant turn ran in and where it ended, so a
// later edit can fork the session at that point (see db/schema.ts).
export interface MessageMeta {
  parentId?: string | null;
  sessionId?: string | null;
  anchorId?: string | null;
}

// Row shape returned from manager methods. Effort is always non-null at this
// layer. Legacy rows (effort=null in the DB) resolve to the model's catalog
// default before leaving the manager.
export type Chat = Omit<ChatRow, "effort"> & { effort: ChatEffort };

function hydrate(row: ChatRow): Chat {
  return { ...row, effort: resolveEffort(row.effort as ChatEffort | null) };
}

export class ChatManager {
  constructor(private db: Db) {}

  create(instanceId: string, model: string, provider: ChatProvider, effort: ChatEffort) {
    const id = randomUUID();
    this.db.insert(schema.chats).values({ id, instanceId, model, provider, effort }).run();
    // Log a chat-creation event now so the "across N chats" figure (a count of
    // these markers in the usage log) survives the chat (or its instance) being
    // deleted later.
    this.recordChatCreated(this.profileIdForInstance(instanceId), provider, model);
    return this.get(id)!;
  }

  get(id: string): Chat | undefined {
    const row = this.db.select().from(schema.chats).where(eq(schema.chats.id, id)).get();
    return row ? hydrate(row) : undefined;
  }

  list(instanceId: string) {
    return this.db
      .select()
      .from(schema.chats)
      .where(eq(schema.chats.instanceId, instanceId))
      .all()
      .map(hydrate);
  }

  listAll() {
    return this.db.select().from(schema.chats).all().map(hydrate);
  }

  remove(id: string) {
    this.db.delete(schema.chatEvents).where(eq(schema.chatEvents.chatId, id)).run();
    this.db.delete(schema.chatMessages).where(eq(schema.chatMessages.chatId, id)).run();
    this.db.delete(schema.chats).where(eq(schema.chats.id, id)).run();
  }

  removeForInstance(instanceId: string) {
    const chats = this.list(instanceId);
    for (const chat of chats) {
      this.remove(chat.id);
    }
  }

  addMessage(chatId: string, role: "user" | "assistant", content: string, meta: MessageMeta = {}) {
    return this.addMessageWithId(chatId, randomUUID(), role, content, meta);
  }

  // Insert with an explicit id. The SSE message handler reserves the
  // assistant id at turn start (so chat_events can link to it before the
  // row exists) and then calls this on `done`.
  addMessageWithId(
    chatId: string,
    id: string,
    role: "user" | "assistant",
    content: string,
    meta: MessageMeta = {},
  ) {
    this.db
      .insert(schema.chatMessages)
      .values({
        id,
        chatId,
        role,
        content,
        parentId: meta.parentId ?? null,
        sessionId: meta.sessionId ?? null,
        anchorId: meta.anchorId ?? null,
      })
      .run();
    return this.db.select().from(schema.chatMessages).where(eq(schema.chatMessages.id, id)).get()!;
  }

  getMessage(id: string): ChatMessage | undefined {
    return this.db.select().from(schema.chatMessages).where(eq(schema.chatMessages.id, id)).get();
  }

  // Insertion order (rowid), NOT created_at: the column has second precision,
  // so a turn's user and assistant rows routinely tie. Sibling versions of an
  // edited message rely on this order too (version 1, 2, … = insert order).
  getMessages(chatId: string) {
    return this.db
      .select()
      .from(schema.chatMessages)
      .where(eq(schema.chatMessages.chatId, chatId))
      .orderBy(asc(sql`rowid`))
      .all();
  }

  // Stamp the provider-session snapshot onto an assistant row after (or
  // while) its turn runs, so a later edit can fork the session at this turn.
  setMessageTurnMeta(messageId: string, meta: { sessionId?: string; anchorId?: string }) {
    const updates: Partial<{ sessionId: string; anchorId: string }> = {};
    if (meta.sessionId !== undefined) updates.sessionId = meta.sessionId;
    if (meta.anchorId !== undefined) updates.anchorId = meta.anchorId;
    if (Object.keys(updates).length === 0) return;
    this.db
      .update(schema.chatMessages)
      .set(updates)
      .where(eq(schema.chatMessages.id, messageId))
      .run();
  }

  setActiveLeaf(chatId: string, messageId: string | null) {
    this.db
      .update(schema.chats)
      .set({ activeLeafId: messageId })
      .where(eq(schema.chats.id, chatId))
      .run();
  }

  // The tip of the chat's active branch: where the next (non-edit) turn
  // attaches. Starts from activeLeafId (falling back to the newest message,
  // which is what legacy pre-tree rows mean) and descends to the branch's
  // end by newest child, so a stale leaf (e.g. a crash before the leaf
  // advanced past a finished assistant turn) still lands on the real tip.
  // Undefined only for an empty chat.
  resolveTip(chatId: string): ChatMessage | undefined {
    const chat = this.get(chatId);
    if (!chat) return undefined;
    let current = (chat.activeLeafId ? this.getMessage(chat.activeLeafId) : undefined) ?? undefined;
    if (current && current.chatId !== chatId) current = undefined;
    if (!current) {
      current = this.db
        .select()
        .from(schema.chatMessages)
        .where(eq(schema.chatMessages.chatId, chatId))
        .orderBy(desc(sql`rowid`))
        .limit(1)
        .get();
    }
    if (!current) return undefined;
    return this.descendToTip(chatId, current);
  }

  // Follow newest-child links from `from` down to the end of its branch.
  // Selecting a message version means "show the newest continuation under
  // it", and this resolves that continuation. Returns `from` itself when it
  // has no children.
  descendToTip(chatId: string, from: ChatMessage): ChatMessage {
    let current = from;
    // Bounded like walkToRoot, so a corrupt cycle can't hang the server.
    for (let i = 0; i < 100_000; i++) {
      const child = this.newestChild(chatId, current.id);
      if (!child) return current;
      current = child;
    }
    return current;
  }

  // The provider-session fork point for a turn that replies to `parentId`:
  // the nearest message on the path from `parentId` (inclusive) to the root
  // that has both a session snapshot and an anchor. Null means "no usable
  // snapshot" (chat root, or legacy rows that predate the columns), and the
  // caller starts a fresh provider session instead.
  resolveForkPoint(parentId: string | null): { sessionId: string; anchorId: string } | null {
    for (const msg of this.walkToRoot(parentId)) {
      if (msg.role === "assistant" && msg.sessionId && msg.anchorId) {
        return { sessionId: msg.sessionId, anchorId: msg.anchorId };
      }
    }
    return null;
  }

  // The provider session the branch ending at `leafId` runs in: the nearest
  // assistant message on the root path that recorded one. Null for branches
  // with no session snapshot (legacy rows, turns that died early). Used to
  // re-point the chat's session columns when the user switches branches.
  resolveBranchSession(leafId: string | null): string | null {
    for (const msg of this.walkToRoot(leafId)) {
      if (msg.role === "assistant" && msg.sessionId) return msg.sessionId;
    }
    return null;
  }

  // The path from `fromId` up to the chat's root, starting at `fromId`
  // itself. Yields nothing for null/unknown ids.
  pathToRoot(fromId: string | null): Generator<ChatMessage> {
    return this.walkToRoot(fromId);
  }

  private *walkToRoot(fromId: string | null): Generator<ChatMessage> {
    // Bounded so a corrupt parent cycle can't hang the server. Any real path
    // is far shorter.
    let currentId = fromId;
    for (let i = 0; currentId && i < 100_000; i++) {
      const msg = this.getMessage(currentId);
      if (!msg) return;
      yield msg;
      currentId = msg.parentId;
    }
  }

  private newestChild(chatId: string, parentId: string): ChatMessage | undefined {
    return this.db
      .select()
      .from(schema.chatMessages)
      .where(
        and(eq(schema.chatMessages.chatId, chatId), eq(schema.chatMessages.parentId, parentId)),
      )
      .orderBy(desc(sql`rowid`))
      .limit(1)
      .get();
  }

  // Append a structured SSE event. Callers supply the per-message seq (a
  // local counter in the streaming handler) so we never need a SELECT
  // MAX(seq) on the hot path.
  appendEvent(chatId: string, messageId: string, seq: number, type: string, payload: unknown) {
    this.db
      .insert(schema.chatEvents)
      .values({
        id: randomUUID(),
        chatId,
        messageId,
        seq,
        type,
        payload: JSON.stringify(payload),
      })
      .run();
  }

  // All events for a chat, ordered by message + seq. The caller groups by
  // messageId. Returns events even for messages still in flight (no
  // chat_messages row yet) so a mid-turn reload can show what we have.
  //
  // Ordered in SQL via idx_chat_events_lookup (chat_id, message_id, seq).
  // messageId is a UUID (ASCII), so binary collation matches the previous
  // JS string sort. Saves a full in-JS sort on every /events page load.
  getEvents(chatId: string) {
    return this.db
      .select()
      .from(schema.chatEvents)
      .where(eq(schema.chatEvents.chatId, chatId))
      .orderBy(asc(schema.chatEvents.messageId), asc(schema.chatEvents.seq))
      .all();
  }

  // All events for a single assistant turn, ordered by seq, with seq >
  // afterSeq. Used by the resume endpoint to replay events the client
  // hasn't seen yet without re-emitting ones it already applied.
  //
  // Filter + order in SQL (backed by idx_chat_events_message on
  // (message_id, seq)) rather than scanning the whole table and sorting in
  // JS. Resume and the existence probe call this on a path that the chat
  // client now retries more aggressively.
  getEventsForMessage(messageId: string, afterSeq = -1) {
    return this.db
      .select()
      .from(schema.chatEvents)
      .where(and(eq(schema.chatEvents.messageId, messageId), gt(schema.chatEvents.seq, afterSeq)))
      .orderBy(asc(schema.chatEvents.seq))
      .all();
  }

  // `null` clears a session id (the active branch has no known session yet,
  // e.g. an edit just started forking), `undefined` leaves it untouched.
  updateSessionId(chatId: string, claudeSessionId?: string | null, codexThreadId?: string | null) {
    const updates: Partial<{ claudeSessionId: string | null; codexThreadId: string | null }> = {};
    if (claudeSessionId !== undefined) updates.claudeSessionId = claudeSessionId;
    if (codexThreadId !== undefined) updates.codexThreadId = codexThreadId;
    if (Object.keys(updates).length === 0) return;
    this.db.update(schema.chats).set(updates).where(eq(schema.chats.id, chatId)).run();
  }

  updateModel(chatId: string, model: string, provider: ChatProvider, effort: ChatEffort) {
    const chat = this.get(chatId);
    if (!chat) return;
    const updates: {
      model: string;
      provider: ChatProvider;
      effort: ChatEffort;
      claudeSessionId?: null;
      codexThreadId?: null;
      compacted?: null;
      modelContextWindow?: null;
    } = { model, provider, effort };
    // Switching provider invalidates both session IDs. The next message starts fresh.
    // The UI blocks cross-provider swaps, but defend in depth.
    if (chat.provider !== provider) {
      updates.claudeSessionId = null;
      updates.codexThreadId = null;
      // The per-message session snapshots (fork anchors for message editing)
      // are the old provider's too. Left in place, a later edit would hand
      // e.g. a Claude session id to codex's thread/fork. Clear them so edits
      // recompute with a fresh session, consistent with the context already
      // being lost by the swap.
      this.db
        .update(schema.chatMessages)
        .set({ sessionId: null, anchorId: null })
        .where(eq(schema.chatMessages.chatId, chatId))
        .run();
    }
    // A model swap changes context capacity and compaction semantics, even
    // when the provider can apply it to the existing live process.
    if (chat.model !== model) {
      updates.compacted = null;
      updates.modelContextWindow = null;
    }
    this.db.update(schema.chats).set(updates).where(eq(schema.chats.id, chatId)).run();
  }

  updateEffort(chatId: string, effort: ChatEffort) {
    this.db.update(schema.chats).set({ effort }).where(eq(schema.chats.id, chatId)).run();
  }

  // Snapshot the running per-chat totals + the latest turn's breakdown +
  // the provider-reported context window onto the row. Called from the SSE
  // `usage` handler on every event so a page reload mid-chat can rehydrate
  // the context-pressure bar and cost panel without waiting for a new turn.
  updateUsage(
    chatId: string,
    usage: {
      total: {
        inputTokens: number;
        cachedInputTokens: number;
        cacheCreationInputTokens: number;
        outputTokens: number;
        reasoningOutputTokens: number;
      };
      last: {
        inputTokens: number;
        cachedInputTokens: number;
        cacheCreationInputTokens: number;
        outputTokens: number;
        reasoningOutputTokens: number;
      };
      modelContextWindow?: number;
      costUsd?: number;
    },
  ) {
    // Read the prior cumulative *before* overwriting it: the difference is this
    // event's incremental usage, which feeds the daily time series. The chat
    // columns store running totals, so without the diff we couldn't tell a
    // 10k-token turn from the 500k total it pushed the chat to.
    const prev = this.get(chatId);

    this.db
      .update(schema.chats)
      .set({
        inputTokens: usage.total.inputTokens,
        cachedInputTokens: usage.total.cachedInputTokens,
        cacheCreationInputTokens: usage.total.cacheCreationInputTokens,
        outputTokens: usage.total.outputTokens,
        reasoningOutputTokens: usage.total.reasoningOutputTokens,
        lastInputTokens: usage.last.inputTokens,
        lastCachedInputTokens: usage.last.cachedInputTokens,
        lastCacheCreationInputTokens: usage.last.cacheCreationInputTokens,
        lastOutputTokens: usage.last.outputTokens,
        lastReasoningOutputTokens: usage.last.reasoningOutputTokens,
        ...(usage.modelContextWindow != null
          ? { modelContextWindow: usage.modelContextWindow }
          : {}),
        ...(usage.costUsd != null ? { costUsd: usage.costUsd } : {}),
      })
      .where(eq(schema.chats.id, chatId))
      .run();

    if (prev) {
      // Deltas are clamped to ≥0: cumulative totals are monotonic within a
      // chat, but a model/provider swap can re-seat the running cost, and we
      // never want a daily bucket to go backwards from a transient dip.
      const delta = {
        inputTokens: Math.max(0, usage.total.inputTokens - (prev.inputTokens ?? 0)),
        cachedInputTokens: Math.max(
          0,
          usage.total.cachedInputTokens - (prev.cachedInputTokens ?? 0),
        ),
        cacheCreationInputTokens: Math.max(
          0,
          usage.total.cacheCreationInputTokens - (prev.cacheCreationInputTokens ?? 0),
        ),
        outputTokens: Math.max(0, usage.total.outputTokens - (prev.outputTokens ?? 0)),
        reasoningOutputTokens: Math.max(
          0,
          usage.total.reasoningOutputTokens - (prev.reasoningOutputTokens ?? 0),
        ),
        costUsd: usage.costUsd != null ? Math.max(0, usage.costUsd - (prev.costUsd ?? 0)) : 0,
      };
      const profileId = this.profileIdForInstance(prev.instanceId);
      const provider = prev.provider as ChatProvider;
      // Pricing-weighted input-equivalent for THIS turn, at the model in effect
      // for it, summed into the lifetime rollup so the subscription-share %
      // stays correct across a mid-chat model swap (unlike weighting the final
      // cumulative by whatever model the chat happens to end on).
      const pricing = pricingFor(provider, prev.model);
      const effectiveDelta = pricing
        ? effectiveInputTokens(
            {
              inputTokens: delta.inputTokens,
              cachedInputTokens: delta.cachedInputTokens,
              cacheCreationInputTokens: delta.cacheCreationInputTokens,
              outputTokens: delta.outputTokens,
              reasoningOutputTokens: delta.reasoningOutputTokens,
              totalTokens: 0, // unused by effectiveInputTokens
            },
            pricing,
          )
        : 0;
      this.recordUsageEvent(profileId, provider, prev.model, delta, effectiveDelta);
    }
  }

  // Every instance is created with a profile (InstanceManager.create requires
  // one). The column is nullable only because it was added by a later ALTER and
  // backfilled. So a missing profile here is an invariant violation, not a case
  // to bucket. Surface it rather than silently mis-attributing usage.
  private profileIdForInstance(instanceId: string): string {
    const profileId = this.db
      .select({ profileId: schema.instances.profileId })
      .from(schema.instances)
      .where(eq(schema.instances.id, instanceId))
      .get()?.profileId;
    if (!profileId) throw new Error(`instance ${instanceId} has no profile`);
    return profileId;
  }

  // Append one usage event to the log, the source of truth for the whole Usage
  // page. A no-op delta (every field zero, common for usage events that only
  // refresh the context window) is dropped so the log holds only real activity.
  // `effectiveDelta` is the pricing-weighted input-equivalent for this turn, at
  // the model in effect for it.
  private recordUsageEvent(
    profileId: string,
    provider: ChatProvider,
    model: string,
    delta: {
      inputTokens: number;
      cachedInputTokens: number;
      cacheCreationInputTokens: number;
      outputTokens: number;
      reasoningOutputTokens: number;
      costUsd: number;
    },
    effectiveDelta: number,
  ) {
    const empty =
      delta.inputTokens === 0 &&
      delta.cachedInputTokens === 0 &&
      delta.cacheCreationInputTokens === 0 &&
      delta.outputTokens === 0 &&
      delta.reasoningOutputTokens === 0 &&
      delta.costUsd === 0;
    if (empty) return;

    this.db
      .insert(schema.usageEvents)
      .values({
        id: randomUUID(),
        profileId,
        provider,
        model,
        kind: "usage",
        ...delta,
        effectiveInputTokens: effectiveDelta,
      })
      .run();
  }

  // Append a chat-creation marker to the usage log. Separate from usage events
  // so the count reflects chats created, independent of whether they ever
  // produced usage, matching the "across N chats" figure's meaning. The log is
  // append-only, so the count survives the chat's later deletion.
  private recordChatCreated(profileId: string, provider: ChatProvider, model: string) {
    this.db
      .insert(schema.usageEvents)
      .values({
        id: randomUUID(),
        profileId,
        provider,
        model,
        kind: "chat_created",
      })
      .run();
  }

  // The usage series for the contribution heatmap: every event bucketed into its
  // local calendar day, summed across providers (cost split kept for the
  // tooltip), ascending by day. The day is derived from each event's timestamp
  // at read time, local (not UTC) so it matches the user's "today". This is a
  // single machine, so server and client share a timezone.
  getUsageHistory(profileId?: string | null): UsageDay[] {
    const rows = this.db
      .select()
      .from(schema.usageEvents)
      .where(profileId == null ? undefined : eq(schema.usageEvents.profileId, profileId))
      .orderBy(asc(schema.usageEvents.createdAt))
      .all();

    const byDay = new Map<string, UsageDay>();
    for (const r of rows) {
      const key = localDay(r.createdAt);
      let day = byDay.get(key);
      if (!day) {
        day = {
          day: key,
          costUsd: 0,
          inputTokens: 0,
          cachedInputTokens: 0,
          cacheCreationInputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
          anthropicCostUsd: 0,
          openaiCostUsd: 0,
        };
        byDay.set(key, day);
      }
      day.costUsd += r.costUsd;
      day.inputTokens += r.inputTokens;
      day.cachedInputTokens += r.cachedInputTokens;
      day.cacheCreationInputTokens += r.cacheCreationInputTokens;
      day.outputTokens += r.outputTokens;
      day.reasoningOutputTokens += r.reasoningOutputTokens;
      if (r.provider === "anthropic") day.anthropicCostUsd += r.costUsd;
      else day.openaiCostUsd += r.costUsd;
    }
    // chat_created markers carry zero tokens/cost, so a day with only creations
    // sums to nothing. The heatmap is a spend-over-time view, so drop days with
    // no token/cost activity. This also preserves the "no usage yet" empty
    // state until a real turn lands. (The lifetime chat count reads the log
    // directly, so it still sees those markers.)
    return [...byDay.values()].filter(
      (d) =>
        d.inputTokens > 0 ||
        d.cachedInputTokens > 0 ||
        d.cacheCreationInputTokens > 0 ||
        d.outputTokens > 0 ||
        d.reasoningOutputTokens > 0 ||
        d.costUsd > 0,
    );
  }

  // Lifetime usage, derived by summing every usage event for the profile grouped
  // by provider (chats = count of chat_created markers), NOT read from the live
  // chats table. That's deliberate: the log is append-only and never rewritten
  // when a chat (or its instance) is deleted, so these numbers stay put.
  getAggregateTotals(profileId?: string | null): AggregateTotals {
    const empty = (): AggregateTotalsBucket => ({
      chats: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      costUsd: 0,
      effectiveInputTokens: 0,
      // Per-provider buckets get filled in by computeAggregateSubscriptionShare
      // (lives in chat/subscription-share.ts because it needs upstream
      // usage stats). The `total` bucket stays null, since there's no single
      // plan that spans providers.
      subscriptionShare: null,
    });
    const total = empty();
    const anthropic = empty();
    const openai = empty();
    const rows = this.db
      .select()
      .from(schema.usageEvents)
      .where(profileId == null ? undefined : eq(schema.usageEvents.profileId, profileId))
      .all();
    for (const r of rows) {
      const bucket = r.provider === "anthropic" ? anthropic : openai;
      const add = (b: AggregateTotalsBucket) => {
        // chat_created markers count toward the chat total, and usage events carry
        // the token/cost/effective deltas (markers have all-zero token fields).
        if (r.kind === "chat_created") b.chats += 1;
        b.inputTokens += r.inputTokens;
        b.cachedInputTokens += r.cachedInputTokens;
        b.cacheCreationInputTokens += r.cacheCreationInputTokens;
        b.outputTokens += r.outputTokens;
        b.reasoningOutputTokens += r.reasoningOutputTokens;
        b.costUsd += r.costUsd;
        b.effectiveInputTokens += r.effectiveInputTokens;
      };
      add(bucket);
      add(total);
    }
    return { total, anthropic, openai };
  }

  // Sticky once true until the model/provider changes (updateModel clears it).
  // We deliberately don't unset on every usage event because the backend
  // only emits `context_compacted` at the moment of compaction.
  markCompacted(chatId: string) {
    this.db.update(schema.chats).set({ compacted: true }).where(eq(schema.chats.id, chatId)).run();
  }
}
