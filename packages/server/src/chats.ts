import { randomUUID } from "crypto";
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { effectiveInputTokens, pricingFor } from "./chat/subscription-share";
import type {
  AggregateTotals,
  AggregateTotalsBucket,
  ChatEffort,
  ChatProvider,
  ChatRenderChunk,
  ChatResumeSnapshot,
  ChatViewPage,
  UsageDay,
} from "./contracts";
import {
  boundChatRenderChunks,
  compactChatRenderEvents,
  localDay,
  resolveEffort,
} from "./contracts";
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

  // Batch history lookup for just the assistant rows in a bounded page.
  // The composite chat/message/seq index makes this independent of the rest
  // of the transcript's event volume.
  getEventsForMessages(chatId: string, messageIds: string[], includeDebug = true) {
    if (messageIds.length === 0) return [];
    const renderTypes = [
      "delta",
      "tool_call_start",
      "tool_call_input",
      "tool_call_result",
      "api_retry",
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
      "tool_call_start",
      "tool_call_input",
      "tool_call_result",
      "api_retry",
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
  ): ChatMessage {
    return this.db.transaction(() => {
      const userMessage = this.addMessage(chatId, "user", content, { parentId });
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
      "tool_call_start",
      "tool_call_input",
      "tool_call_result",
      "api_retry",
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
