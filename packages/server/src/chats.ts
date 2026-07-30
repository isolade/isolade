import { randomUUID } from "crypto";
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { type ModelBilling, type TokenUsage, usageTokenCount } from "./chat/backend";
import { effectiveInputTokens, pricingFor } from "./chat/subscription-share";
import type {
  AggregateTotals,
  AggregateTotalsBucket,
  ChatCostBreakdown,
  ChatCostBucket,
  ChatEffort,
  ChatProvider,
  ChatRenderChunk,
  ChatResumeSnapshot,
  ChatViewPage,
  UsageDay,
} from "./contracts";
import {
  boundChatRenderChunks,
  clampEffortToModel,
  compactChatRenderEvents,
  findChatModel,
  localDay,
  resolveEffort,
  tokenCostBreakdown,
} from "./contracts";
import type { Db } from "./db";
import { schema } from "./db";
import type { ChatMessage, Chat as ChatRow, QueuedMessage } from "./db/schema";

// Optional tree/session metadata for a message insert. `parentId` links the
// message into the tree (null = chat root). `sessionId`/`anchorId` snapshot
// the provider session an assistant turn ran in and where it ended, so a
// later edit can fork the session at that point (see db/schema.ts).
// `provider`/`model` record which provider produced an assistant turn, so a
// chat that has switched providers can tell each turn's native session apart
// (a native fork is only valid with the same provider's backend).
export interface MessageMeta {
  parentId?: string | null;
  sessionId?: string | null;
  anchorId?: string | null;
  deliveryStatus?: "sending" | "confirmed" | "unknown" | "rejected" | null;
  deliveryError?: string | null;
  provider?: ChatProvider | null;
  model?: string | null;
}

// Row shape returned from manager methods. Effort is always non-null at this
// layer. Legacy rows (effort=null in the DB) resolve to the model's catalog
// default before leaving the manager.
export type Chat = Omit<ChatRow, "effort"> & { effort: ChatEffort };

function hydrate(row: ChatRow): Chat {
  const model = findChatModel(row.model);
  // An effort the model no longer offers snaps to its default here, at the one
  // place every reader goes through, rather than being left for whichever of
  // them happens to notice. Retiring an effort level is what makes this real:
  // chats persisted with `ultra` would otherwise keep asking codex for it (and
  // with it the proactive sub-agent mode that retiring it was meant to stop),
  // since a turn reads the row's effort verbatim and nothing rewrites the row
  // until the user next touches the picker. A model the catalog doesn't carry
  // has no menu to clamp against, so its effort passes through untouched.
  const effort = resolveEffort(row.effort as ChatEffort | null);
  return { ...row, effort: model ? clampEffortToModel(effort, model) : effort };
}

export class ChatManager {
  constructor(private db: Db) {}

  create(instanceId: string, model: string, provider: ChatProvider, effort: ChatEffort) {
    const id = randomUUID();
    this.db.insert(schema.chats).values({ id, instanceId, model, provider, effort }).run();
    // Log a chat-creation event now so the "across N chats" figure (a count of
    // these markers in the usage log) survives the chat (or its instance) being
    // deleted later.
    this.recordChatCreated(this.profileIdForInstance(instanceId), id, provider, model);
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
    this.db.delete(schema.queuedMessages).where(eq(schema.queuedMessages.chatId, id)).run();
    this.db.delete(schema.chatEvents).where(eq(schema.chatEvents.chatId, id)).run();
    this.db.delete(schema.chatMessageRenders).where(eq(schema.chatMessageRenders.chatId, id)).run();
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
        deliveryStatus: meta.deliveryStatus ?? null,
        deliveryError: meta.deliveryError ?? null,
        provider: meta.provider ?? null,
        model: meta.model ?? null,
      })
      .run();
    return this.db.select().from(schema.chatMessages).where(eq(schema.chatMessages.id, id)).get()!;
  }

  getMessage(id: string): ChatMessage | undefined {
    return this.db.select().from(schema.chatMessages).where(eq(schema.chatMessages.id, id)).get();
  }

  getAssistantReply(chatId: string, userMessageId: string): ChatMessage | undefined {
    return this.db
      .select()
      .from(schema.chatMessages)
      .where(
        and(
          eq(schema.chatMessages.chatId, chatId),
          eq(schema.chatMessages.role, "assistant"),
          eq(schema.chatMessages.parentId, userMessageId),
        ),
      )
      .orderBy(desc(sql`rowid`))
      .limit(1)
      .get();
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

  // Return a bounded slice of the active root-to-tip path. Walking indexed
  // parent links caps DB and JS work at limit + 1 rows, unlike the legacy API
  // that materializes every body and branch before the client can paint.
  getTranscriptPage(chatId: string, before: string | null, limit: number) {
    let current: ChatMessage | undefined;
    if (before) {
      const cursor = this.getMessage(before);
      if (!cursor || cursor.chatId !== chatId) {
        current = this.resolveTip(chatId);
      } else {
        current = cursor.parentId ? this.getMessage(cursor.parentId) : undefined;
      }
    } else {
      current = this.resolveTip(chatId);
    }

    const newestFirst: ChatMessage[] = [];
    const seen = new Set<string>();
    while (current && newestFirst.length <= limit) {
      if (seen.has(current.id)) break;
      seen.add(current.id);
      if (current.chatId !== chatId) break;
      newestFirst.push(current);
      current = current.parentId ? this.getMessage(current.parentId) : undefined;
    }
    const hasMore = newestFirst.length > limit;
    const rows = newestFirst.slice(0, limit).reverse();
    if (rows.length === 0) return { messages: [], hasMore };
    // Version metadata stays bounded even if one prompt has been edited many
    // thousands of times. Correlated indexed lookups return only count,
    // position, and the two neighbors needed by the pager.
    const versionRows = this.db
      .select({
        id: schema.chatMessages.id,
        count: sql<number>`(
          SELECT count(*) FROM chat_messages AS sibling
          WHERE sibling.chat_id = "chat_messages"."chat_id"
            AND sibling.role = "chat_messages"."role"
            AND sibling.parent_id IS "chat_messages"."parent_id"
        )`,
        index: sql<number>`(
          SELECT count(*) FROM chat_messages AS sibling
          WHERE sibling.chat_id = "chat_messages"."chat_id"
            AND sibling.role = "chat_messages"."role"
            AND sibling.parent_id IS "chat_messages"."parent_id"
            AND sibling.rowid <= chat_messages.rowid
        )`,
        previousId: sql<string | null>`(
          SELECT sibling.id FROM chat_messages AS sibling
          WHERE sibling.chat_id = "chat_messages"."chat_id"
            AND sibling.role = "chat_messages"."role"
            AND sibling.parent_id IS "chat_messages"."parent_id"
            AND sibling.rowid < chat_messages.rowid
          ORDER BY sibling.rowid DESC LIMIT 1
        )`,
        nextId: sql<string | null>`(
          SELECT sibling.id FROM chat_messages AS sibling
          WHERE sibling.chat_id = "chat_messages"."chat_id"
            AND sibling.role = "chat_messages"."role"
            AND sibling.parent_id IS "chat_messages"."parent_id"
            AND sibling.rowid > chat_messages.rowid
          ORDER BY sibling.rowid ASC LIMIT 1
        )`,
      })
      .from(schema.chatMessages)
      .where(
        and(
          eq(schema.chatMessages.chatId, chatId),
          inArray(
            schema.chatMessages.id,
            rows.map((row) => row.id),
          ),
        ),
      )
      .all();
    const versions = new Map(versionRows.map((row) => [row.id, row]));
    const messages = rows.map((row) => {
      const version = versions.get(row.id);
      return {
        ...row,
        version:
          version && version.count > 1
            ? {
                index: version.index,
                count: version.count,
                previousId: version.previousId,
                nextId: version.nextId,
              }
            : null,
      };
    });
    return { messages, hasMore };
  }

  // One coherent read for a cold chat or an older page. Bun's SQLite driver
  // is synchronous, so every helper call below executes on the same
  // connection while this transaction is open. A finalizing turn can be
  // observed either before or after commit, never as a transcript/in-flight
  // mixture assembled from different database snapshots.
  getChatViewPage(
    chatId: string,
    before: string | null,
    limit: number,
    options: {
      inFlightSnapshot?: NonNullable<ChatViewPage["inFlight"]>;
    } = {},
  ): ChatViewPage {
    return this.db.transaction(() => {
      const page = this.getTranscriptPage(chatId, before, limit);
      const assistantIds = page.messages
        .filter((message) => message.role === "assistant")
        .map((message) => message.id);
      const chunksByMessage = this.getMessageRenderChunks(chatId, assistantIds, false, true);
      const turn =
        before === null && !options.inFlightSnapshot
          ? this.readInFlightEvents(chatId, false)
          : null;
      const inFlight =
        options.inFlightSnapshot ??
        (turn
          ? {
              messageId: turn.messageId,
              lastSeq: turn.lastSeq,
              chunks: boundChatRenderChunks(compactChatRenderEvents(turn.events)),
            }
          : null);
      return {
        ...page,
        chunksByMessage,
        inFlight,
        queuedMessages: this.listQueuedMessages(chatId),
      };
    });
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
  //
  // `provider`, when given, restricts the fork to a session that provider owns:
  // a native fork replays a provider-native session, so it's only valid when
  // the anchor and the entire edited prefix belong to that provider. If a
  // different provider appears between `parentId` and the anchor, this returns
  // null and the caller starts a fresh session (feeding the edited prefix
  // through the cross-provider handoff pipeline instead). A null provider on a
  // row is treated as compatible: legacy anchored rows predate the column and a
  // single-provider chat never conflicts.
  resolveForkPoint(
    parentId: string | null,
    provider?: ChatProvider,
  ): { sessionId: string; anchorId: string } | null {
    for (const msg of this.walkToRoot(parentId)) {
      if (msg.role !== "assistant") continue;
      if (provider && msg.provider && msg.provider !== provider) return null;
      if (msg.sessionId && msg.anchorId) {
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

  // Batch history lookup for just the assistant rows in a bounded page.
  // The composite chat/message/seq index makes this independent of the rest
  // of the transcript's event volume.
  getEventsForMessages(chatId: string, messageIds: string[], includeDebug = true) {
    if (messageIds.length === 0) return [];
    const renderTypes = [
      "delta",
      "thinking_start",
      "thinking_delta",
      "thinking_tokens",
      "thinking_done",
      "tool_call_start",
      "tool_call_input",
      "tool_call_result",
      "steered_user_message",
      "turn_interrupted",
      "render_seed",
      "api_retry",
      "provider_switch",
      ...(includeDebug ? ["thinking", "raw"] : []),
    ];
    return this.db
      .select()
      .from(schema.chatEvents)
      .where(
        and(
          eq(schema.chatEvents.chatId, chatId),
          inArray(schema.chatEvents.messageId, messageIds),
          inArray(schema.chatEvents.type, renderTypes),
        ),
      )
      .orderBy(asc(schema.chatEvents.messageId), asc(schema.chatEvents.seq))
      .all();
  }

  // Validate client-supplied ids before reading or populating
  // the render cache. A render row is meaningful only for an assistant
  // message owned by this chat.
  getAssistantMessageIds(chatId: string, messageIds: string[]) {
    if (messageIds.length === 0) return [];
    return this.db
      .select({ id: schema.chatMessages.id })
      .from(schema.chatMessages)
      .where(
        and(
          eq(schema.chatMessages.chatId, chatId),
          eq(schema.chatMessages.role, "assistant"),
          inArray(schema.chatMessages.id, messageIds),
        ),
      )
      .all()
      .map((row) => row.id);
  }

  // Identify turns that need more than their final Markdown body. This first
  // pass selects no payloads, so the common pure-text turn never allocates or
  // JSON-parses its potentially thousands of persisted delta rows.
  getRenderableEventMessageIds(chatId: string, messageIds: string[], includeDebug: boolean) {
    if (messageIds.length === 0) return [];
    const structuralTypes = [
      "thinking_start",
      "thinking_delta",
      "thinking_tokens",
      "thinking_done",
      "tool_call_start",
      "tool_call_input",
      "tool_call_result",
      "steered_user_message",
      "turn_interrupted",
      "render_seed",
      "api_retry",
      "provider_switch",
      ...(includeDebug ? ["thinking", "raw"] : []),
    ];
    return this.db
      .select({ messageId: schema.chatEvents.messageId })
      .from(schema.chatEvents)
      .where(
        and(
          eq(schema.chatEvents.chatId, chatId),
          inArray(schema.chatEvents.messageId, messageIds),
          inArray(schema.chatEvents.type, structuralTypes),
        ),
      )
      .groupBy(schema.chatEvents.messageId)
      .all()
      .map((row) => row.messageId);
  }

  beginInFlightTurn(chatId: string, messageId: string) {
    this.db.transaction((tx) => {
      tx.update(schema.chats)
        .set({ inFlightMessageId: messageId })
        .where(eq(schema.chats.id, chatId))
        .run();
      tx.insert(schema.chatEvents)
        .values({
          id: randomUUID(),
          chatId,
          messageId,
          seq: -1,
          type: "turn_started",
          payload: "null",
        })
        .run();
    });
  }

  beginTurn(
    chatId: string,
    assistantMessageId: string,
    content: string,
    parentId: string | null,
    userMessageId: string = randomUUID(),
  ): ChatMessage {
    return this.db.transaction(() => {
      const userMessage = this.addMessageWithId(chatId, userMessageId, "user", content, {
        parentId,
        deliveryStatus: "sending",
      });
      this.db
        .delete(schema.queuedMessages)
        .where(eq(schema.queuedMessages.id, userMessageId))
        .run();
      this.db
        .update(schema.chats)
        .set({ activeLeafId: userMessage.id, inFlightMessageId: assistantMessageId })
        .where(eq(schema.chats.id, chatId))
        .run();
      this.db
        .insert(schema.chatEvents)
        .values({
          id: randomUUID(),
          chatId,
          messageId: assistantMessageId,
          seq: -1,
          type: "turn_started",
          payload: "null",
        })
        .run();
      return userMessage;
    });
  }

  enqueueMessage(opts: { id: string; chatId: string; content: string }): QueuedMessage {
    const existing = this.db
      .select()
      .from(schema.queuedMessages)
      .where(eq(schema.queuedMessages.id, opts.id))
      .get();
    if (existing) {
      if (existing.chatId !== opts.chatId || existing.content !== opts.content) {
        throw new Error("queued message id was already used with different content");
      }
      return existing;
    }
    const existingMessage = this.getMessage(opts.id);
    if (existingMessage) {
      if (
        existingMessage.chatId !== opts.chatId ||
        existingMessage.role !== "user" ||
        existingMessage.content !== opts.content
      ) {
        throw new Error("message id was already used with different content");
      }
      throw new Error("message was already sent");
    }
    this.db
      .insert(schema.queuedMessages)
      .values({ id: opts.id, chatId: opts.chatId, content: opts.content })
      .run();
    return this.getQueuedMessage(opts.id)!;
  }

  getQueuedMessage(id: string): QueuedMessage | undefined {
    return this.db
      .select()
      .from(schema.queuedMessages)
      .where(eq(schema.queuedMessages.id, id))
      .get();
  }

  listQueuedMessages(chatId: string): QueuedMessage[] {
    return this.db
      .select()
      .from(schema.queuedMessages)
      .where(eq(schema.queuedMessages.chatId, chatId))
      .orderBy(asc(schema.queuedMessages.createdAt), asc(sql`rowid`))
      .all()
      .filter((message) => message.status !== "delivered");
  }

  nextQueuedMessage(chatId: string): QueuedMessage | undefined {
    const messages = this.listQueuedMessages(chatId);
    return (
      messages.find((message) => message.mode === "now" && message.status === "interrupting") ??
      messages.find((message) => message.mode === "later" && message.status === "queued")
    );
  }

  updateQueuedMessage(
    id: string,
    updates: Partial<
      Pick<
        QueuedMessage,
        "mode" | "status" | "targetMessageId" | "editSessionId" | "editAnchorId" | "error"
      >
    >,
  ): QueuedMessage | undefined {
    this.db
      .update(schema.queuedMessages)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(schema.queuedMessages.id, id))
      .run();
    return this.getQueuedMessage(id);
  }

  createDeliveredInTurnMessage(opts: {
    id: string;
    chatId: string;
    content: string;
    mode: "next" | "now";
    targetMessageId: string;
    editSessionId: string;
    editAnchorId: string;
  }): QueuedMessage {
    this.db
      .insert(schema.queuedMessages)
      .values({ ...opts, status: "delivered" })
      .run();
    return this.getQueuedMessage(opts.id)!;
  }

  removeQueuedMessage(id: string, allowInProgress = false): QueuedMessage | undefined {
    const row = this.getQueuedMessage(id);
    if (!row) return undefined;
    if (!allowInProgress && (row.status === "steering" || row.status === "interrupting")) {
      throw new Error("message is already being delivered");
    }
    this.db.delete(schema.queuedMessages).where(eq(schema.queuedMessages.id, id)).run();
    return row;
  }

  setUserMessageDelivery(
    id: string,
    status: "sending" | "confirmed" | "unknown" | "rejected",
    error: string | null = null,
  ): ChatMessage | undefined {
    this.db
      .update(schema.chatMessages)
      .set({ deliveryStatus: status, deliveryError: error })
      .where(and(eq(schema.chatMessages.id, id), eq(schema.chatMessages.role, "user")))
      .run();
    return this.getMessage(id);
  }

  finalizeTurn(
    chatId: string,
    messageId: string,
    content: string,
    meta: MessageMeta,
    chunks: ChatRenderChunk[],
  ): ChatMessage | null {
    return this.db.transaction(() => {
      const owner = this.db
        .select({ id: schema.chats.id })
        .from(schema.chats)
        .where(and(eq(schema.chats.id, chatId), eq(schema.chats.inFlightMessageId, messageId)))
        .get();
      if (!owner) return null;
      const message = this.addMessageWithId(chatId, messageId, "assistant", content, meta);
      this.saveMessageRender(chatId, messageId, chunks);
      this.db
        .update(schema.chats)
        .set({ activeLeafId: messageId, inFlightMessageId: null })
        .where(and(eq(schema.chats.id, chatId), eq(schema.chats.inFlightMessageId, messageId)))
        .run();
      return message;
    });
  }

  inFlightMessageId(chatId: string): string | null {
    return (
      this.db
        .select({ messageId: schema.chats.inFlightMessageId })
        .from(schema.chats)
        .where(eq(schema.chats.id, chatId))
        .get()?.messageId ?? null
    );
  }

  clearInFlightTurn(chatId: string, messageId: string) {
    this.db
      .update(schema.chats)
      .set({ inFlightMessageId: null })
      .where(and(eq(schema.chats.id, chatId), eq(schema.chats.inFlightMessageId, messageId)))
      .run();
  }

  saveMessageRender(chatId: string, messageId: string, chunks: ChatRenderChunk[]) {
    const storedChunks = chunks.some((chunk) => chunk.kind !== "text") ? chunks : [];
    const normalChunks = storedChunks.filter(
      (chunk) => chunk.kind !== "thinking" && chunk.kind !== "raw",
    );
    const previewChunks = boundChatRenderChunks(normalChunks);
    this.db
      .insert(schema.chatMessageRenders)
      .values({
        chatId,
        messageId,
        chunks: JSON.stringify(normalChunks),
        debugChunks: JSON.stringify(storedChunks),
        previewChunks: JSON.stringify(previewChunks),
      })
      .onConflictDoUpdate({
        target: schema.chatMessageRenders.messageId,
        set: {
          chatId,
          chunks: JSON.stringify(normalChunks),
          debugChunks: JSON.stringify(storedChunks),
          previewChunks: JSON.stringify(previewChunks),
        },
      })
      .run();
  }

  getMessageRenders(chatId: string, messageIds: string[]) {
    if (messageIds.length === 0) return [];
    return this.db
      .select()
      .from(schema.chatMessageRenders)
      .where(
        and(
          eq(schema.chatMessageRenders.chatId, chatId),
          inArray(schema.chatMessageRenders.messageId, messageIds),
        ),
      )
      .all();
  }

  private getMessageRenderProjections(
    chatId: string,
    messageIds: string[],
    includeDebug: boolean,
    bounded: boolean,
  ) {
    if (messageIds.length === 0) return [];
    const projection = bounded
      ? schema.chatMessageRenders.previewChunks
      : includeDebug
        ? schema.chatMessageRenders.debugChunks
        : schema.chatMessageRenders.chunks;
    return this.db
      .select({ messageId: schema.chatMessageRenders.messageId, chunks: projection })
      .from(schema.chatMessageRenders)
      .where(
        and(
          eq(schema.chatMessageRenders.chatId, chatId),
          inArray(schema.chatMessageRenders.messageId, messageIds),
        ),
      )
      .all();
  }

  // Resolve compact semantic renders for a bounded set of assistant rows.
  // Missing legacy projections are folded and cached once. `bounded` keeps
  // provider-controlled tool payloads out of cold pages while the focused
  // render endpoint continues to return the full compatible chunk shape.
  getMessageRenderChunks(
    chatId: string,
    messageIds: string[],
    includeDebug: boolean,
    bounded: boolean,
  ): Record<string, ChatRenderChunk[]> {
    if (messageIds.length === 0) return {};
    const uniqueIds = [...new Set(messageIds)].slice(0, 100);
    const validIds = this.getAssistantMessageIds(chatId, uniqueIds);
    const valid = new Set(validIds);
    const cached = new Map<string, ChatRenderChunk[]>();
    for (const row of this.getMessageRenderProjections(chatId, validIds, includeDebug, bounded)) {
      try {
        cached.set(row.messageId, JSON.parse(row.chunks));
      } catch (error) {
        console.warn(`[chat] corrupt render cache (chat=${chatId} msg=${row.messageId}):`, error);
      }
    }

    // Preview rows written before collapsed tool summaries were stored may
    // contain only a serialized, truncated input. Lazily rebuild just those
    // messages from their full compact projection, then heal the cache. This
    // avoids a startup migration over every historical tool payload.
    if (bounded) {
      const stalePreviewIds = [...cached]
        .filter(([, chunks]) =>
          chunks.some((chunk) => chunk.kind === "tool" && chunk.summary === undefined),
        )
        .map(([messageId]) => messageId);
      for (const row of this.getMessageRenders(chatId, stalePreviewIds)) {
        try {
          const full = JSON.parse(row.chunks) as ChatRenderChunk[];
          const preview = boundChatRenderChunks(full);
          cached.set(row.messageId, preview);
          this.db
            .update(schema.chatMessageRenders)
            .set({ previewChunks: JSON.stringify(preview) })
            .where(eq(schema.chatMessageRenders.messageId, row.messageId))
            .run();
        } catch (error) {
          console.warn(
            `[chat] corrupt full render cache (chat=${chatId} msg=${row.messageId}):`,
            error,
          );
        }
      }
    }

    const uncachedIds = validIds.filter((messageId) => !cached.has(messageId));
    // Always detect debug-only structure while doing the one-time legacy fold,
    // then persist both full and normal projections together.
    const renderableIds = this.getRenderableEventMessageIds(chatId, uncachedIds, true);
    const renderable = new Set(renderableIds);
    const grouped = new Map<string, ReturnType<ChatManager["getEventsForMessages"]>>();
    for (const event of this.getEventsForMessages(chatId, renderableIds, true)) {
      const events = grouped.get(event.messageId) ?? [];
      events.push(event);
      grouped.set(event.messageId, events);
    }
    for (const messageId of renderableIds) {
      const compacted = compactChatRenderEvents(grouped.get(messageId) ?? []);
      this.saveMessageRender(chatId, messageId, compacted);
      cached.set(
        messageId,
        includeDebug
          ? compacted
          : compacted.filter((chunk) => chunk.kind !== "thinking" && chunk.kind !== "raw"),
      );
    }
    for (const messageId of uncachedIds) {
      if (renderable.has(messageId)) continue;
      this.saveMessageRender(chatId, messageId, []);
      cached.set(messageId, []);
    }

    const result: Record<string, ChatRenderChunk[]> = {};
    for (const messageId of uniqueIds) {
      if (!valid.has(messageId)) continue;
      const compacted = cached.get(messageId) ?? [];
      const visible = includeDebug
        ? compacted
        : compacted.filter((chunk) => chunk.kind !== "thinking" && chunk.kind !== "raw");
      const structural = visible.some((chunk) => chunk.kind !== "text") ? visible : [];
      result[messageId] = bounded ? boundChatRenderChunks(structural) : structural;
    }
    return result;
  }

  // The chat row points directly at the reserved assistant id, so this lookup
  // is independent of both committed history size and stale orphan events.
  getInFlightEvents(chatId: string, includeDebug = true) {
    return this.db.transaction(() => this.readInFlightEvents(chatId, includeDebug));
  }

  private readInFlightEvents(chatId: string, includeDebug: boolean) {
    const messageId = this.db
      .select({ messageId: schema.chats.inFlightMessageId })
      .from(schema.chats)
      .where(eq(schema.chats.id, chatId))
      .get()?.messageId;
    if (!messageId) return null;
    const committed = this.db
      .select({ id: schema.chatMessages.id })
      .from(schema.chatMessages)
      .where(and(eq(schema.chatMessages.chatId, chatId), eq(schema.chatMessages.id, messageId)))
      .get();
    if (committed) return null;
    const last = this.db
      .select({ seq: schema.chatEvents.seq })
      .from(schema.chatEvents)
      .where(and(eq(schema.chatEvents.chatId, chatId), eq(schema.chatEvents.messageId, messageId)))
      .orderBy(desc(schema.chatEvents.seq))
      .limit(1)
      .get();
    if (!last) return null;
    const renderTypes = [
      "delta",
      "thinking_start",
      "thinking_delta",
      "thinking_tokens",
      "thinking_done",
      "tool_call_start",
      "tool_call_input",
      "tool_call_result",
      "steered_user_message",
      "turn_interrupted",
      "render_seed",
      "api_retry",
      "provider_switch",
      ...(includeDebug ? ["thinking", "raw"] : []),
    ];
    const events = this.db
      .select()
      .from(schema.chatEvents)
      .where(
        and(
          eq(schema.chatEvents.chatId, chatId),
          eq(schema.chatEvents.messageId, messageId),
          inArray(schema.chatEvents.type, renderTypes),
        ),
      )
      .orderBy(asc(schema.chatEvents.seq))
      .all();
    return { messageId, lastSeq: last.seq, events };
  }

  // Terminal resume fallback after a settled turn has left the in-memory
  // hub, or after a server restart killed a producer. It returns one bounded
  // semantic snapshot plus the canonical message. A dead pre-commit turn is
  // materialized once so future hydration no longer rediscovers its marker.
  getPersistedResumeSnapshot(
    chatId: string,
    messageId: string,
    includeDebug: boolean,
  ): ChatResumeSnapshot | null {
    return this.db.transaction(() => {
      let message = this.db
        .select()
        .from(schema.chatMessages)
        .where(and(eq(schema.chatMessages.chatId, chatId), eq(schema.chatMessages.id, messageId)))
        .get();
      const interrupted = !message;
      let lastSeq = -1;
      let recoveryEvents: ReturnType<ChatManager["getEventsForMessage"]> = [];
      let metaRows: Array<{ seq: number; type: string; payload: string }> = [];

      if (interrupted) {
        // A server restart killed the producer before it could commit. This is
        // the only path that needs the raw deltas to materialize a partial
        // assistant row. Normal completed resumes below stay O(render size).
        recoveryEvents = this.getEventsForMessage(messageId, -2).filter(
          (event) => event.chatId === chatId,
        );
        if (recoveryEvents.length === 0) return null;
        lastSeq = recoveryEvents.at(-1)?.seq ?? -1;
        const latest = new Map<string, (typeof recoveryEvents)[number]>();
        for (const event of recoveryEvents) {
          if (
            event.type === "usage" ||
            event.type === "title" ||
            event.type === "context_compacted"
          ) {
            latest.set(event.type, event);
          }
        }
        metaRows = [...latest.values()];
      } else {
        const last = this.db
          .select({ seq: schema.chatEvents.seq })
          .from(schema.chatEvents)
          .where(
            and(eq(schema.chatEvents.chatId, chatId), eq(schema.chatEvents.messageId, messageId)),
          )
          .orderBy(desc(schema.chatEvents.seq))
          .limit(1)
          .get();
        if (!last) return null;
        lastSeq = last.seq;
        for (const type of ["usage", "title", "context_compacted"] as const) {
          const row = this.db
            .select({
              seq: schema.chatEvents.seq,
              type: schema.chatEvents.type,
              payload: schema.chatEvents.payload,
            })
            .from(schema.chatEvents)
            .where(
              and(
                eq(schema.chatEvents.chatId, chatId),
                eq(schema.chatEvents.messageId, messageId),
                eq(schema.chatEvents.type, type),
              ),
            )
            .orderBy(desc(schema.chatEvents.seq))
            .limit(1)
            .get();
          if (row) metaRows.push(row);
        }
      }

      if (!message) {
        let content = "";
        for (const event of recoveryEvents) {
          if (event.type !== "delta") continue;
          try {
            const text = JSON.parse(event.payload);
            if (typeof text === "string") content += text;
          } catch (error) {
            console.warn(
              `[chat] recovered delta event has non-JSON payload (chat=${chatId} msg=${messageId} seq=${event.seq}):`,
              error,
            );
          }
        }
        const tip = this.resolveTip(chatId);
        const parentId = tip?.role === "user" ? tip.id : null;
        message = this.addMessageWithId(chatId, messageId, "assistant", content, { parentId });
        this.saveMessageRender(chatId, messageId, compactChatRenderEvents(recoveryEvents));
        if (parentId) this.setActiveLeaf(chatId, messageId);
        this.clearInFlightTurn(chatId, messageId);
      }

      const chunks =
        this.getMessageRenderChunks(chatId, [messageId], includeDebug, true)[messageId] ?? [];
      const metaEvents = metaRows
        .map((event) => {
          let payload: unknown = event.payload;
          try {
            payload = JSON.parse(event.payload);
          } catch {}
          return {
            seq: event.seq,
            type: event.type as "usage" | "title" | "context_compacted",
            payload,
          };
        })
        .toSorted((a, b) => a.seq - b.seq);
      return {
        messageId,
        lastSeq,
        chunks,
        metaEvents,
        status: interrupted ? "error" : "done",
        message,
        ...(interrupted ? { error: "turn ended before completion" } : {}),
      };
    });
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
    // Switching provider invalidates both session IDs. The UI only offers this
    // before a fresh chat's first message, but keep API-initiated swaps safe.
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

  // Opt a chat in or out of the provider's fast mode. Takes effect when the
  // backend next configures the chat's process (see ClaudeSession.reconfigure),
  // which is before its next turn.
  updateFastMode(chatId: string, fastMode: boolean) {
    this.db.update(schema.chats).set({ fastMode }).where(eq(schema.chats.id, chatId)).run();
  }

  updateEffort(chatId: string, effort: ChatEffort) {
    this.db.update(schema.chats).set({ effort }).where(eq(schema.chats.id, chatId)).run();
  }

  // Commit a cross-provider switch onto the chat row, atomically: set the
  // target provider/model/effort and reset the active-session usage in one
  // transaction (the target-session commit, run on the first accepted target
  // request). Deliberately does NOT clear either provider's session-id column:
  // the target's is written by its backend as the fresh session mints, and the
  // source's is kept so its branch stays resumable. The per-message provider
  // field disambiguates the two going forward.
  commitProviderSwitch(
    chatId: string,
    next: { provider: ChatProvider; model: string; effort: ChatEffort },
  ) {
    this.db.transaction(() => {
      this.db
        .update(schema.chats)
        .set({
          provider: next.provider,
          model: next.model,
          effort: next.effort,
          // A target with no fast rate card has no fast mode to inherit, and its
          // picker offers no toggle, so carrying the opt-in across would leave it
          // set out of sight — and already on for the next model that does offer
          // one. Same reasoning as the PATCH route, applied where a switch lands.
          ...(findChatModel(next.model)?.fastPricing == null ? { fastMode: false } : {}),
        })
        .where(eq(schema.chats.id, chatId))
        .run();
      this.resetActiveUsage(chatId);
    });
  }

  // Reset the chat's active-session usage columns to their fresh state. These
  // columns hold ONE native session's cumulative totals plus the last turn's
  // breakdown, so a cross-provider switch must reset them in the target-session
  // commit, before the first target usage event. Otherwise updateUsage would
  // diff the fresh target total against the larger source total, clamp the
  // negative delta to zero, and lose the target's usage from the append-only
  // usage log (the lifetime source of truth, which this method never touches).
  // Nulling (rather than zeroing) mirrors a brand-new chat, so the UI shows no
  // usage until the first target event lands. `compacted` and the
  // provider-reported context window belong to the retired session too.
  // `costUsd` is untouched, and needs no special handling to be: it is a sum of
  // per-event increments, so there is nothing session-shaped in it to reset.
  resetActiveUsage(chatId: string) {
    this.db
      .update(schema.chats)
      .set({
        inputTokens: null,
        cachedInputTokens: null,
        cacheCreationInputTokens: null,
        outputTokens: null,
        reasoningOutputTokens: null,
        lastInputTokens: null,
        lastCachedInputTokens: null,
        lastCacheCreationInputTokens: null,
        lastOutputTokens: null,
        lastReasoningOutputTokens: null,
        modelContextWindow: null,
        compacted: null,
      })
      .where(eq(schema.chats.id, chatId))
      .run();
  }

  // Snapshot the live gauge onto the row: the session's running token totals,
  // the latest turn's breakdown, and the provider-reported context window.
  // Called on every usage event so a reload mid-chat can rehydrate the
  // context-pressure bar without waiting for a new turn. Deliberately touches
  // no money and writes no history: what a turn cost is a separate, settled
  // fact that arrives once (see recordTurnBilling).
  updateUsage(
    chatId: string,
    usage: {
      total: TokenUsage;
      last: TokenUsage;
      modelContextWindow?: number;
    },
  ) {
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
      })
      .where(eq(schema.chats.id, chatId))
      .run();
  }

  // Record what a settled turn billed: one usage-log row per model that did
  // work in it, and the same money added to the chat's running total. This is
  // the only place spend is written down.
  //
  // Per turn rather than per usage event, and per model rather than per chat,
  // because that is the granularity at which the numbers are actually true: a
  // provider can only say what a turn cost once it is over, and a turn's models
  // are billed at their own rates. It also means nothing here has to diff a
  // running total against a stored one, so no restart, retired session, or
  // out-of-order report can drop or double a turn's spend.
  recordTurnBilling(chatId: string, models: ModelBilling[]) {
    const chat = this.get(chatId);
    if (!chat || models.length === 0) return;
    const profileId = this.profileIdForInstance(chat.instanceId);
    const provider = chat.provider as ChatProvider;
    let billed = 0;
    for (const entry of models) {
      // Pricing-weighted input-equivalent for this model's share of the turn,
      // at its own rates, so the subscription-share % stays right across a
      // mid-chat model swap and across a turn that ran a sub-agent elsewhere.
      const pricing = pricingFor(provider, entry.model, entry.fast);
      const effective = pricing ? effectiveInputTokens(entry.usage, pricing) : 0;
      this.recordUsageEvent(profileId, chatId, provider, entry.model, entry, effective);
      billed += entry.costUsd;
    }
    if (billed > 0) {
      this.db
        .update(schema.chats)
        .set({ costUsd: (chat.costUsd ?? 0) + billed })
        .where(eq(schema.chats.id, chatId))
        .run();
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

  // Append one model's share of a settled turn to the usage log, the source of
  // truth for the whole Usage page. A turn that consumed nothing and cost
  // nothing is dropped, so the log holds only real activity. `effective` is the
  // pricing-weighted input-equivalent for this model's tokens at its own rates.
  private recordUsageEvent(
    profileId: string,
    chatId: string,
    provider: ChatProvider,
    model: string,
    billing: ModelBilling,
    effective: number,
  ) {
    if (usageTokenCount(billing.usage) === 0 && billing.costUsd === 0) return;

    this.db
      .insert(schema.usageEvents)
      .values({
        id: randomUUID(),
        profileId,
        chatId,
        provider,
        model,
        kind: "usage",
        inputTokens: billing.usage.inputTokens,
        cachedInputTokens: billing.usage.cachedInputTokens,
        cacheCreationInputTokens: billing.usage.cacheCreationInputTokens,
        outputTokens: billing.usage.outputTokens,
        reasoningOutputTokens: billing.usage.reasoningOutputTokens,
        fast: billing.fast,
        cacheWrite1hTokens: billing.cacheWrite1hTokens,
        webSearchRequests: billing.webSearchRequests,
        costUsd: billing.costUsd,
        effectiveInputTokens: effective,
      })
      .run();
  }

  // Append a chat-creation marker to the usage log. Separate from usage events
  // so the count reflects chats created, independent of whether they ever
  // produced usage, matching the "across N chats" figure's meaning. The log is
  // append-only, so the count survives the chat's later deletion.
  private recordChatCreated(
    profileId: string,
    chatId: string,
    provider: ChatProvider,
    model: string,
  ) {
    this.db
      .insert(schema.usageEvents)
      .values({
        id: randomUUID(),
        profileId,
        chatId,
        provider,
        model,
        kind: "chat_created",
      })
      .run();
  }

  // Where one chat's money went: its settled turns summed per token bucket, each
  // priced at the model that turn was billed at, so a chat that switched agents
  // (or ran a sub-agent on another model) adds up instead of costing everything
  // out at whatever it happens to be running now.
  //
  // `billed` is what the providers actually charged and is the figure to trust.
  // The buckets are a list-price split of it: exact for codex, whose cost IS the
  // price of these tokens, and close for Claude, which hands us a figure of its
  // own. What that split cannot account for stays visible as `unattributed`
  // rather than being smeared across the buckets, since it is real spend with a
  // real cause: searches billed per request, cache written at a longer TTL than
  // the catalog rate assumes, a model the catalog has no price for.
  //
  // Only settled turns are here. A turn in flight has no bill yet, so this never
  // races a running turn or has to guess at one.
  getChatCostBreakdown(chatId: string): ChatCostBreakdown {
    const rows = this.db
      .select()
      .from(schema.usageEvents)
      .where(and(eq(schema.usageEvents.chatId, chatId), eq(schema.usageEvents.kind, "usage")))
      .all();

    const buckets: ChatCostBucket[] = [
      { bucket: "input", tokens: 0, costUsd: 0 },
      { bucket: "cachedInput", tokens: 0, costUsd: 0 },
      { bucket: "cacheWrite", tokens: 0, costUsd: 0 },
      { bucket: "cacheWrite1h", tokens: 0, costUsd: 0 },
      { bucket: "output", tokens: 0, costUsd: 0 },
      { bucket: "reasoningOutput", tokens: 0, costUsd: 0 },
    ];
    const models = new Map<string, { model: string; provider: ChatProvider; costUsd: number }>();
    let webSearchRequests = 0;
    for (const row of rows) {
      const provider = row.provider as ChatProvider;
      const usage: TokenUsage = {
        inputTokens: row.inputTokens,
        cachedInputTokens: row.cachedInputTokens,
        cacheCreationInputTokens: row.cacheCreationInputTokens,
        outputTokens: row.outputTokens,
        reasoningOutputTokens: row.reasoningOutputTokens,
        totalTokens: 0, // unused when pricing
      };
      const priced = tokenCostBreakdown(
        usage,
        pricingFor(provider, row.model, row.fast),
        row.cacheWrite1hTokens,
      );
      buckets[0]!.tokens += usage.inputTokens;
      buckets[0]!.costUsd += priced.input;
      buckets[1]!.tokens += usage.cachedInputTokens;
      buckets[1]!.costUsd += priced.cachedInput;
      const writes1h = Math.min(row.cacheWrite1hTokens, usage.cacheCreationInputTokens);
      buckets[2]!.tokens += usage.cacheCreationInputTokens - writes1h;
      buckets[2]!.costUsd += priced.cacheWrite;
      buckets[3]!.tokens += writes1h;
      buckets[3]!.costUsd += priced.cacheWrite1h;
      buckets[4]!.tokens += usage.outputTokens;
      buckets[4]!.costUsd += priced.output;
      buckets[5]!.tokens += usage.reasoningOutputTokens;
      buckets[5]!.costUsd += priced.reasoningOutput;
      webSearchRequests += row.webSearchRequests;

      const key = `${provider}:${row.model}`;
      const entry = models.get(key) ?? { model: row.model, provider, costUsd: 0 };
      entry.costUsd += row.costUsd;
      models.set(key, entry);
    }

    const billed = this.get(chatId)?.costUsd ?? 0;
    const attributed = buckets.reduce((sum, b) => sum + b.costUsd, 0);
    return {
      billed,
      buckets: buckets.filter((b) => b.tokens > 0),
      models: [...models.values()].toSorted((a, b) => b.costUsd - a.costUsd),
      webSearchRequests,
      unattributed: billed - attributed,
    };
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
