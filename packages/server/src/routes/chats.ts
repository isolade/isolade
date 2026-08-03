import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { buildSystemPrompt } from "../chat/system-prompt";
import type { ChatModelDefinition, ChatResumeSnapshot } from "../contracts";
import {
  CHAT_MODELS,
  type ChatModelsResponse,
  clampEffortToModel,
  compactChatRenderEvents,
  createChatBodySchema,
  createChatMessageBodySchema,
  dispatchQueuedMessageBodySchema,
  editChatMessageBodySchema,
  enqueueChatMessageBodySchema,
  findChatModel,
  setActiveLeafBodySchema,
  updateChatBodySchema,
} from "../contracts";
import type { ChatMessage } from "../db/schema";
import { KeyedQueue } from "../keyed-queue";
import type { RouteContext } from "./context";

// ---- Chats: models, CRUD, transcript/events, and the streaming turn ----
export function createChatsRouter(ctx: RouteContext): Hono {
  const {
    chatManager,
    providerSwitchStore,
    uploadStore,
    instances,
    profiles,
    chatStreamHub,
    claudeBackend,
    codexBackend,
    realClaudeBackend,
    chatTurnService,
    chatQueueService,
    archivedError,
  } = ctx;
  const app = new Hono();
  const chatTransitions = new KeyedQueue();
  const branchTransitionCounts = new Map<string, number>();

  const beginBranchTransition = (chatId: string): (() => void) => {
    branchTransitionCounts.set(chatId, (branchTransitionCounts.get(chatId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (branchTransitionCounts.get(chatId) ?? 1) - 1;
      if (remaining > 0) {
        branchTransitionCounts.set(chatId, remaining);
      } else {
        branchTransitionCounts.delete(chatId);
      }
    };
  };

  // Map the persisted pending switch (if any) to the client-facing shape the
  // model picker reads. Returns undefined when there is no pending switch.
  const pendingSwitchView = (chatId: string) => {
    const row = providerSwitchStore.get(chatId);
    if (!row) return undefined;
    return {
      sourceProvider: row.sourceProvider,
      sourceModel: row.sourceModel,
      targetProvider: row.targetProvider,
      targetModel: row.targetModel,
      targetEffort: row.targetEffort,
      status: row.status,
      errorClass: row.errorClass,
    };
  };

  // Attach the pending-switch view to a chat row for any response that returns
  // a chat.
  const withPendingSwitch = <T extends { id: string }>(chat: T) => {
    const pendingSwitch = pendingSwitchView(chat.id);
    return pendingSwitch ? { ...chat, pendingSwitch } : chat;
  };

  // Resolve a model id against the static catalog (Claude + Codex). Returns
  // undefined when the id is unknown.
  const findModelForInstance = (modelId: string): ChatModelDefinition | undefined =>
    findChatModel(modelId);

  const chatForInstance = (instanceId: string, chatId: string) => {
    const chat = chatManager.get(chatId);
    return chat?.instanceId === instanceId ? chat : undefined;
  };

  // A branch change first interrupts the active provider turn and waits for
  // its partial response to persist. Only then do we shut down the chat's
  // Claude process, which terminates its background jobs without racing the
  // interrupt control message against stdin shutdown. Calling disposeChat for
  // a Codex chat is a harmless no-op and also cleans up a stale Claude session
  // if the chat's provider was changed while its previous turn was active.
  const terminateForBranchChange = async (chatId: string): Promise<boolean> => {
    await chatStreamHub.cancelInFlightForChat(chatId);
    await realClaudeBackend.disposeChat(chatId);
    return !chatManager.inFlightMessageId(chatId) && !chatStreamHub.inFlightFor(chatId);
  };

  // Initial turns and reconnects use the same atomic compact snapshot followed
  // by only later events. Catch-up cost depends on the current render model,
  // never on the number of token deltas already emitted.
  async function pumpTurnStream(
    c: import("hono").Context,
    chatId: string,
    messageId: string,
    includeDebug: boolean,
    persistedSeed?: ChatResumeSnapshot,
    userMessage?: ChatMessage,
  ): Promise<Response> {
    return streamSSE(c, async (stream) => {
      let aborted = false;
      const safeWrite = async (frame: Parameters<typeof stream.writeSSE>[0]) => {
        try {
          await stream.writeSSE(frame);
        } catch (error) {
          if (aborted) return;
          console.warn(
            `[chat] resume SSE write failed (chat=${chatId} msg=${messageId} event=${frame.event ?? "message"}):`,
            error,
          );
        }
      };

      type Outboxed =
        | { kind: "event"; seq: number; type: string; payload: unknown }
        | { kind: "done" }
        | { kind: "error"; message: string }
        | { kind: "ping" };
      const outbox: Outboxed[] = [];
      let wake: (() => void) | null = null;
      const enqueue = (item: Outboxed) => {
        const previous = outbox.at(-1);
        if (
          item.kind === "event" &&
          previous?.kind === "event" &&
          (item.type === "delta" || item.type === "thinking") &&
          previous.type === item.type &&
          typeof previous.payload === "string" &&
          typeof item.payload === "string"
        ) {
          previous.payload += item.payload;
          previous.seq = item.seq;
          wake?.();
          wake = null;
          return;
        }
        outbox.push(item);
        wake?.();
        wake = null;
      };
      stream.onAbort(() => {
        aborted = true;
        wake?.();
        wake = null;
      });

      const sub = chatStreamHub.subscribeSnapshot(chatId, messageId, includeDebug, (signal) => {
        if (signal.kind === "event") {
          enqueue({
            kind: "event",
            seq: signal.event.seq,
            type: signal.event.type,
            payload: signal.event.payload,
          });
        } else {
          enqueue(signal);
        }
      });
      const snapshot: ChatResumeSnapshot | null = sub
        ? {
            ...sub.snapshot,
            message:
              sub.snapshot.status === "running"
                ? null
                : (chatManager.getMessage(messageId) ?? null),
          }
        : (persistedSeed ??
          chatManager.getPersistedResumeSnapshot(chatId, messageId, includeDebug));
      if (!snapshot) return;

      if (userMessage) {
        const freshUserMessage = chatManager.getMessage(userMessage.id) ?? userMessage;
        await safeWrite({
          event: "user_message",
          data: JSON.stringify(freshUserMessage),
        });
      }
      await safeWrite({ event: "message_id", data: JSON.stringify(messageId) });
      await safeWrite({ event: "snapshot", data: JSON.stringify(snapshot) });
      if (snapshot.status === "done") {
        await safeWrite({ event: "done", data: "" });
        sub?.unsubscribe();
        return;
      }
      if (snapshot.status === "error") {
        await safeWrite({
          event: "error",
          data: snapshot.error ?? "turn failed",
        });
        sub?.unsubscribe();
        return;
      }

      const heartbeat = setInterval(() => {
        if (!aborted) enqueue({ kind: "ping" });
      }, 15_000);
      while (!aborted) {
        if (outbox.length === 0) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          if (aborted) break;
          continue;
        }
        const item = outbox.shift()!;
        if (item.kind === "event") {
          await safeWrite({
            id: String(item.seq),
            event: item.type,
            data: JSON.stringify(item.payload),
          });
        } else if (item.kind === "done") {
          await safeWrite({ event: "done", data: "" });
          break;
        } else if (item.kind === "error") {
          await safeWrite({ event: "error", data: item.message });
          break;
        } else {
          await safeWrite({ event: "ping", data: "" });
        }
      }
      sub?.unsubscribe();
      clearInterval(heartbeat);
    });
  }

  // Chat models: the full static catalog (Claude + Codex). Per-profile
  // visibility/tier overrides are applied client-side (see the Models settings
  // page and the pickers), so this endpoint is provider- and profile-agnostic.
  app.get("/api/chat/models", (c) => {
    return c.json({ models: [...CHAT_MODELS] } satisfies ChatModelsResponse);
  });

  // Chats
  app.post("/api/instances/:id/chats", async (c) => {
    const instanceId = c.req.param("id");
    const instance = instances.get(instanceId);
    if (!instance) return c.json({ error: "not found" }, 404);
    if (instance.archived) return archivedError(c);
    const { model, effort, fastMode } = createChatBodySchema.parse(await c.req.json());
    const modelDef = findModelForInstance(model);
    if (!modelDef) return c.json({ error: "unknown model" }, 400);
    if (effort !== undefined && !modelDef.supportedEfforts.includes(effort)) {
      return c.json({ error: `effort '${effort}' not supported by ${model}` }, 400);
    }
    const chat = chatManager.create(
      instanceId,
      model,
      modelDef.provider,
      effort ?? modelDef.defaultEffort,
      // Dropped rather than stored on a model that does not sell a faster rate,
      // for the reason the update route drops it: what is stored and what is
      // offered have to be the same thing.
      (fastMode ?? false) && modelDef.fastPricing != null,
    );
    return c.json(chat, 201);
  });

  app.get("/api/instances/:id/chats", async (c) => {
    const instanceId = c.req.param("id");
    if (!instances.get(instanceId)) return c.json({ error: "not found" }, 404);
    const chats = chatManager.list(instanceId);
    return c.json(chats.map(withPendingSwitch));
  });

  app.get("/api/chats", async (c) => {
    const chats = chatManager.listAll();
    return c.json(chats.map(withPendingSwitch));
  });

  app.patch("/api/instances/:id/chats/:chatId", async (c) => {
    const instanceId = c.req.param("id");
    const instance = instances.get(instanceId);
    if (!instance) return c.json({ error: "instance not found" }, 404);
    const chatId = c.req.param("chatId");
    const existing = chatForInstance(instanceId, chatId);
    if (!existing) return c.json({ error: "not found" }, 404);
    const { model, effort, fastMode } = updateChatBodySchema.parse(await c.req.json());
    // Resolve the post-update (model, effort) pair. When the caller swaps
    // to a model whose effort menu doesn't include the current value, snap
    // to that model's declared default rather than 400ing.
    const nextModelId = model ?? existing.model;
    const modelDef = findModelForInstance(nextModelId);
    if (!modelDef) return c.json({ error: "unknown model" }, 400);
    if (effort !== undefined && !modelDef.supportedEfforts.includes(effort)) {
      return c.json({ error: `effort '${effort}' not supported by ${nextModelId}` }, 400);
    }
    const nextEffort = effort ?? clampEffortToModel(existing.effort, modelDef);

    // A cross-provider model selection does NOT switch the chat now: it records
    // a pending switch that the next real user turn activates with a
    // provider-neutral handoff (see the handoff service). Crucially it does NOT
    // clear the current provider's session id or per-message anchors, unlike the
    // old same-provider-only updateModel path, so the source stays resumable if
    // the switch is later abandoned.
    if (model !== undefined && modelDef.provider !== existing.provider) {
      const tip = chatManager.resolveTip(chatId);
      const sourceSessionId =
        existing.provider === "anthropic" ? existing.claudeSessionId : existing.codexThreadId;
      // The source anchor is the active branch tip's own turn anchor, so a
      // later source-side compaction/summary fork resumes at exactly this point.
      const sourceAnchorId =
        tip && tip.role === "assistant"
          ? tip.anchorId
          : (chatManager.resolveForkPoint(tip?.id ?? null, existing.provider)?.anchorId ?? null);
      providerSwitchStore.upsert(chatId, {
        sourceLeafId: tip?.id ?? null,
        sourceProvider: existing.provider,
        sourceModel: existing.model,
        sourceSessionId: sourceSessionId ?? null,
        sourceAnchorId,
        targetProvider: modelDef.provider,
        targetModel: model,
        targetEffort: nextEffort,
      });
      // The chat row itself is untouched: it still runs the source provider
      // until activation. Return it decorated with the pending switch.
      const pending = chatManager.get(chatId);
      return c.json(pending ? withPendingSwitch(pending) : pending);
    }

    // Same-provider change (or effort-only). If a pending cross-provider switch
    // was recorded earlier, selecting a model back on the current provider
    // reverts it, so drop the pending switch.
    if (model !== undefined) {
      const existingSwitch = providerSwitchStore.get(chatId);
      if (existingSwitch) providerSwitchStore.clear(chatId);
      chatManager.updateModel(chatId, model, modelDef.provider, nextEffort);
    } else if (effort !== undefined) {
      chatManager.updateEffort(chatId, nextEffort);
    }
    // Stored, not pushed: the backend reads it when it next configures the
    // chat's process, so a turn already running keeps the mode it started in
    // rather than changing rate halfway through.
    //
    // A model with no fast rate card has no fast mode to be in, and the picker
    // hides the toggle for it. Clearing the opt-in rather than leaving it set
    // keeps the stored state and the offered state the same thing: otherwise it
    // survives out of sight and reappears already on when the user picks a model
    // that does offer it, having never opted in for that one.
    const fastOffered = modelDef.fastPricing != null;
    if (fastMode !== undefined && fastOffered) chatManager.updateFastMode(chatId, fastMode);
    else if (!fastOffered && existing.fastMode) chatManager.updateFastMode(chatId, false);
    const updated = chatManager.get(chatId);
    return c.json(updated ? withPendingSwitch(updated) : updated);
  });

  app.delete("/api/instances/:id/chats/:chatId", (c) => {
    const instanceId = c.req.param("id");
    const chatId = c.req.param("chatId");
    if (!chatForInstance(instanceId, chatId)) return c.json({ error: "not found" }, 404);
    chatStreamHub.cancelForChat(chatId);
    // Shut down the chat's persistent `claude` process (and its background
    // tasks). The chat is gone, so the warm process has nothing to serve.
    void realClaudeBackend.disposeChat(chatId);
    providerSwitchStore.clear(chatId);
    uploadStore.removeForChat(chatId);
    chatManager.remove(chatId);
    return c.json({ ok: true });
  });

  // Where this chat's money went, read out of the usage log. Deliberately a
  // pull: the composer's running total rides the live stream, but this split is
  // derived data that nobody needs on every frame and that has no business being
  // persisted into the chat's event log. Fetched when the detail card opens.
  app.get("/api/instances/:id/chats/:chatId/cost", (c) => {
    const instanceId = c.req.param("id");
    const chatId = c.req.param("chatId");
    if (!chatForInstance(instanceId, chatId)) return c.json({ error: "chat not found" }, 404);
    return c.json(chatManager.getChatCostBreakdown(chatId));
  });

  // Probe live context composition through the provider session. Claude uses
  // the structured `get_context_usage` control request. Codex chats always
  // answer `{ available: false }`.
  app.get("/api/instances/:id/chats/:chatId/context", async (c) => {
    const instanceId = c.req.param("id");
    const chatId = c.req.param("chatId");
    const instance = instances.get(instanceId);
    if (!instance) return c.json({ error: "instance not found" }, 404);
    const chat = chatForInstance(instanceId, chatId);
    if (!chat) return c.json({ error: "chat not found" }, 404);
    // The probe spawns an agent process in the VM, which would boot an
    // archived instance's stopped VM (see archivedError). "Unavailable", not
    // 409: the transcript stays viewable and the gauge degrades gracefully.
    if (instance.archived) {
      return c.json({ available: false, reason: "chat is archived" });
    }
    // Control requests other than interrupt are only sent between turns.
    // Answer "unavailable" while streaming. The gauge already reflects the
    // turn's usage.
    if (chatManager.inFlightMessageId(chatId) || chatStreamHub.inFlightFor(chatId)) {
      return c.json({
        available: false,
        reason: "context probe unavailable while a turn is running",
      });
    }
    const backend = chat.provider === "anthropic" ? claudeBackend : codexBackend;
    const sessionId =
      chat.provider === "anthropic"
        ? (chat.claudeSessionId ?? undefined)
        : (chat.codexThreadId ?? undefined);
    try {
      const breakdown = await backend.probeContext({
        vmId: instance.vmId,
        chatId,
        model: chat.model,
        effort: chat.effort,
        sessionId,
        // A probe can relaunch a reaped process and keep it as the chat's live
        // one, so it has to launch with the same prompt a turn would use.
        systemPrompt: buildSystemPrompt({
          provider: chat.provider,
          model: chat.model,
          ...(instance.profileId
            ? profiles.getPromptConfig(instance.profileId)
            : { prelude: null, base: "isolade" as const }),
        }),
      });
      return c.json(breakdown);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  app.get("/api/instances/:id/chats/:chatId/transcript", (c) => {
    const instanceId = c.req.param("id");
    const chatId = c.req.param("chatId");
    if (!chatForInstance(instanceId, chatId)) return c.json({ error: "not found" }, 404);
    const requestedLimit = Number.parseInt(c.req.query("limit") ?? "60", 10);
    const limit = Number.isFinite(requestedLimit) ? Math.min(100, Math.max(1, requestedLimit)) : 60;
    const before = c.req.query("before") ?? null;
    if (before) {
      const cursor = chatManager.getMessage(before);
      if (!cursor || cursor.chatId !== chatId) {
        return c.json({ error: "invalid transcript cursor" }, 400);
      }
    }
    const inFlightId = before === null ? chatManager.inFlightMessageId(chatId) : null;
    const hubSnapshot = inFlightId
      ? chatStreamHub.snapshotForChat(chatId, inFlightId, false)
      : null;
    const page = chatManager.getChatViewPage(chatId, before, limit, {
      ...(hubSnapshot?.status === "running"
        ? {
            inFlightSnapshot: {
              messageId: hubSnapshot.messageId,
              lastSeq: hubSnapshot.lastSeq,
              chunks: hubSnapshot.chunks,
            },
          }
        : {}),
    });
    // Decorate this bounded page in one grouped query, so transcript previews
    // rehydrate without an N+1 fetch or loading the full chat.
    const byMessage = uploadStore.byMessageForChat(chatId, [
      ...page.messages.map((message) => message.id),
      ...page.queuedMessages.map((message) => message.id),
    ]);
    return c.json({
      ...page,
      messages: page.messages.map((message) => {
        const uploads = byMessage.get(message.id);
        return uploads?.length ? { ...message, uploads } : message;
      }),
      queuedMessages: page.queuedMessages.map((message) => {
        const uploads = byMessage.get(message.id);
        return uploads?.length ? { ...message, uploads } : message;
      }),
    });
  });

  app.post("/api/instances/:id/chats/:chatId/queue", async (c) => {
    const instanceId = c.req.param("id");
    const chatId = c.req.param("chatId");
    const instance = instances.get(instanceId);
    if (!instance) return c.json({ error: "instance not found" }, 404);
    if (instance.archived) return archivedError(c);
    if (!chatForInstance(instanceId, chatId)) return c.json({ error: "chat not found" }, 404);
    const { id, content, uploadIds } = enqueueChatMessageBodySchema.parse(await c.req.json());
    if (!content && (!uploadIds || uploadIds.length === 0)) {
      return c.json({ error: "content or an attachment is required" }, 400);
    }
    try {
      const queued = chatQueueService.enqueue({
        instanceId,
        chatId,
        id,
        content,
        uploadIds,
      });
      const uploads = uploadStore.listForMessage(id);
      // The active turn may have settled between the browser deciding to queue
      // and this request reaching the server.
      await chatQueueService.dispatchNext(chatId);
      return c.json(uploads.length > 0 ? { ...queued, uploads } : queued, 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
  });

  app.delete("/api/instances/:id/chats/:chatId/queue/:messageId", async (c) => {
    const instanceId = c.req.param("id");
    const chatId = c.req.param("chatId");
    if (!chatForInstance(instanceId, chatId)) return c.json({ error: "chat not found" }, 404);
    const queued = chatManager.getQueuedMessage(c.req.param("messageId"));
    if (!queued || queued.chatId !== chatId)
      return c.json({ error: "queued message not found" }, 404);
    try {
      return c.json(await chatQueueService.remove(instanceId, chatId, queued.id));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
  });

  app.post("/api/instances/:id/chats/:chatId/queue/:messageId/dispatch", async (c) => {
    const instanceId = c.req.param("id");
    const chatId = c.req.param("chatId");
    const instance = instances.get(instanceId);
    if (!instance) return c.json({ error: "instance not found" }, 404);
    if (instance.archived) return archivedError(c);
    if (!chatForInstance(instanceId, chatId)) return c.json({ error: "chat not found" }, 404);
    const { mode } = dispatchQueuedMessageBodySchema.parse(await c.req.json());
    const queued = await chatQueueService.activate(
      instanceId,
      chatId,
      c.req.param("messageId"),
      mode,
    );
    if (!queued) return c.json({ error: "queued message not found" }, 404);
    return c.json(queued);
  });

  // Return the full compact provider render for a focused set of assistant
  // messages. Pure-text turns return an empty
  // chunk list because their final chat_messages.content is already enough to
  // render them. This avoids sending duplicate token-delta text for the common
  // case while preserving interleaved tools, retries, and optional debug data.
  app.get("/api/instances/:id/chats/:chatId/render", (c) => {
    const instanceId = c.req.param("id");
    const chatId = c.req.param("chatId");
    if (!chatForInstance(instanceId, chatId)) return c.json({ error: "not found" }, 404);
    const messageIds = [...new Set((c.req.query("ids") ?? "").split(",").filter(Boolean))].slice(
      0,
      64,
    );
    const toolId = c.req.query("toolId") || null;
    const includeDebug = c.req.query("debug") === "1";
    const resolved = chatManager.getMessageRenderChunks(chatId, messageIds, includeDebug, false);
    const chunksByMessage = Object.fromEntries(
      messageIds.map((messageId) => {
        let chunks = resolved[messageId];
        if (!chunks && chatManager.inFlightMessageId(chatId) === messageId) {
          chunks = chatStreamHub.renderChunksForChat(chatId, messageId, includeDebug) ?? undefined;
          if (!chunks) {
            const folded = compactChatRenderEvents(
              chatManager.getEventsForMessage(messageId).filter((event) => event.chatId === chatId),
            );
            chunks = includeDebug
              ? folded
              : folded.filter((chunk) => chunk.kind !== "thinking" && chunk.kind !== "raw");
          }
        }
        const projected = toolId
          ? (chunks ?? []).filter((chunk) => chunk.kind === "tool" && chunk.id === toolId)
          : (chunks ?? []);
        return [messageId, projected];
      }),
    );
    return c.json({ chunksByMessage });
  });

  // Legacy full structured event log retained for diagnostics and older
  // clients. The current renderer uses bounded chunks from transcript pages
  // and calls the focused endpoint above only for full tool details or debug.
  app.get("/api/instances/:id/chats/:chatId/events", (c) => {
    const instanceId = c.req.param("id");
    const chatId = c.req.param("chatId");
    if (!chatForInstance(instanceId, chatId)) return c.json({ error: "not found" }, 404);
    // Already ordered by (messageId, seq) in SQL. See ChatManager.getEvents.
    return c.json(chatManager.getEvents(chatId));
  });

  app.get("/api/instances/:id/chats/:chatId/events/in-flight", (c) => {
    const instanceId = c.req.param("id");
    const chatId = c.req.param("chatId");
    if (!chatForInstance(instanceId, chatId)) return c.json({ error: "not found" }, 404);
    const turn = chatManager.getInFlightEvents(chatId, c.req.query("debug") === "1");
    if (!turn) return c.json(null);
    return c.json({
      messageId: turn.messageId,
      lastSeq: turn.lastSeq,
      chunks: compactChatRenderEvents(turn.events),
    });
  });

  app.post("/api/instances/:id/chats/:chatId/messages", async (c) => {
    const instanceId = c.req.param("id");
    const chatId = c.req.param("chatId");
    const instance = instances.get(instanceId);
    if (!instance) return c.json({ error: "instance not found" }, 404);
    if (instance.archived) return archivedError(c);
    const chat = chatForInstance(instanceId, chatId);
    if (!chat) return c.json({ error: "chat not found" }, 404);
    const { id, content, uploadIds } = createChatMessageBodySchema.parse(await c.req.json());
    if (!content && (!uploadIds || uploadIds.length === 0)) {
      return c.json({ error: "content or an attachment is required" }, 400);
    }

    // Hold the turn until the environment's sync initializers finish. They kick
    // off at VM create, usually while the user was still typing this first
    // message, so this await is normally already resolved. A failed initializer
    // leaves the instance in `error`. Refuse the turn with the recorded reason
    // rather than running the agent against a half-set-up environment.
    if (instance.status === "initializing") {
      await instances.awaitInit(instanceId);
    }
    const ready = instances.get(instanceId);
    if (ready?.status === "error") {
      return c.json(
        {
          error: `environment initialization failed: ${ready.lastError ?? "unknown error"}`,
        },
        409,
      );
    }

    // A repeated POST with the same stable user id is a stream recovery, not a
    // second prompt. Return the existing provider turn without touching its
    // context. Reusing an id with different content is always rejected.
    if (id) {
      const existing = chatManager.getMessage(id);
      if (existing) {
        if (
          existing.chatId !== chatId ||
          existing.role !== "user" ||
          existing.content !== content
        ) {
          return c.json({ error: "message id was already used with different content" }, 409);
        }
        const inFlightMessageId = chatManager.inFlightMessageId(chatId);
        if (inFlightMessageId && chatManager.resolveTip(chatId)?.id === existing.id) {
          return pumpTurnStream(
            c,
            chatId,
            inFlightMessageId,
            c.req.query("debug") === "1",
            undefined,
            existing,
          );
        }
        const reply = chatManager.getAssistantReply(chatId, existing.id);
        if (reply) {
          return pumpTurnStream(
            c,
            chatId,
            reply.id,
            c.req.query("debug") === "1",
            undefined,
            existing,
          );
        }
        return c.json({ error: "message delivery is unresolved" }, 409);
      }
    }

    // Do not start another turn while either a provider turn or a branch
    // transition owns this chat. Branch routes claim the chat before their
    // first await, which closes the cancellation-to-replacement gap.
    if (
      branchTransitionCounts.has(chatId) ||
      chatManager.inFlightMessageId(chatId) ||
      chatStreamHub.inFlightFor(chatId)
    ) {
      return c.json({ error: "another turn is in flight for this chat" }, 409);
    }

    // Start synchronously so the stream subscriber can attach before a fast
    // provider publishes its final acknowledgement.
    const { assistantMessageId, userMessage } = chatTurnService.start({
      instance,
      chat,
      content,
      uploadIds,
      userMessageId: id,
    });

    return pumpTurnStream(
      c,
      chatId,
      assistantMessageId,
      c.req.query("debug") === "1",
      undefined,
      userMessage,
    );
  });

  // Edit a user-authored message and recompute the assistant branch from that
  // point. Ordinary rows fork at the preceding assistant turn. Claude
  // in-turn rows fork at the provider checkpoint captured when steering was
  // acknowledged. Both become sibling assistant branches, so the original
  // response stays intact and navigable.
  //
  // Note what this deliberately does NOT rewind: the VM. Files the agent
  // already changed stay changed on every branch.
  app.post("/api/instances/:id/chats/:chatId/messages/:messageId/edit", async (c) => {
    const instanceId = c.req.param("id");
    const chatId = c.req.param("chatId");
    const instance = instances.get(instanceId);
    if (!instance) return c.json({ error: "instance not found" }, 404);
    if (instance.archived) return archivedError(c);
    const chat = chatForInstance(instanceId, chatId);
    if (!chat) return c.json({ error: "chat not found" }, 404);
    const messageId = c.req.param("messageId");
    const edited = chatManager.getMessage(messageId);
    const inTurn = edited ? undefined : chatManager.getQueuedMessage(messageId);
    if (edited && edited.chatId !== chatId) return c.json({ error: "message not found" }, 404);
    if (!edited && !inTurn) return c.json({ error: "message not found" }, 404);
    if (edited && edited.role !== "user") {
      return c.json({ error: "only user messages can be edited" }, 400);
    }
    if (inTurn && inTurn.chatId !== chatId) return c.json({ error: "message not found" }, 404);
    const { id, content, uploadIds } = editChatMessageBodySchema.parse(await c.req.json());
    if (!content && (!uploadIds || uploadIds.length === 0)) {
      return c.json({ error: "content or an attachment is required" }, 400);
    }

    // Same readiness gates as a normal send: wait out initialization,
    // refuse on a failed environment, and never run two turns at once.
    if (instance.status === "initializing") {
      await instances.awaitInit(instanceId);
    }
    const ready = instances.get(instanceId);
    if (ready?.status === "error") {
      return c.json(
        {
          error: `environment initialization failed: ${ready.lastError ?? "unknown error"}`,
        },
        409,
      );
    }
    if (inTurn && id) {
      const existing = chatManager.getQueuedMessage(id);
      if (existing) {
        if (
          existing.id === inTurn.id ||
          existing.chatId !== chatId ||
          existing.content !== content ||
          !existing.targetMessageId
        ) {
          return c.json({ error: "message id was already used with different content" }, 409);
        }
        const target = chatManager.getMessage(existing.targetMessageId);
        if (
          chatManager.inFlightMessageId(chatId) === existing.targetMessageId ||
          (target?.chatId === chatId && target.role === "assistant")
        ) {
          return pumpTurnStream(c, chatId, existing.targetMessageId, c.req.query("debug") === "1");
        }
        return c.json({ error: "message delivery is unresolved" }, 409);
      }
    }
    const releaseBranchTransition = beginBranchTransition(chatId);
    const releaseQueueDispatch = chatQueueService.suspendDispatch(chatId);
    let transition:
      | {
          kind: "turn";
          assistantMessageId: string;
          userMessage?: ChatMessage;
        }
      | { kind: "error"; error: string; status: 400 | 404 }
      | null;
    try {
      transition = await chatTransitions.run(chatId, async () => {
        if (!(await terminateForBranchChange(chatId))) return null;
        const currentChat = chatForInstance(instanceId, chatId);
        const currentInstance = instances.get(instanceId);
        if (!currentChat || !currentInstance) return null;

        const currentInTurn = edited ? undefined : chatManager.getQueuedMessage(messageId);
        if (currentInTurn) {
          if (
            currentChat.provider !== "anthropic" ||
            currentInTurn.status !== "delivered" ||
            !currentInTurn.targetMessageId ||
            !currentInTurn.editSessionId ||
            !currentInTurn.editAnchorId
          ) {
            return {
              kind: "error" as const,
              error: "this in-turn message cannot be edited",
              status: 400 as const,
            };
          }
          const sourceAssistant = chatManager.getMessage(currentInTurn.targetMessageId);
          if (
            !sourceAssistant ||
            sourceAssistant.chatId !== chatId ||
            sourceAssistant.role !== "assistant"
          ) {
            return {
              kind: "error" as const,
              error: "the containing assistant turn was not found",
              status: 404 as const,
            };
          }
          const chunks =
            chatManager.getMessageRenderChunks(chatId, [sourceAssistant.id], true, false)[
              sourceAssistant.id
            ] ?? [];
          const chunkIndex = chunks.findIndex(
            (chunk) => chunk.kind === "user_message" && chunk.id === currentInTurn.id,
          );
          if (chunkIndex < 0) {
            return {
              kind: "error" as const,
              error: "the in-turn message was not found",
              status: 404 as const,
            };
          }

          const replacementId = id ?? randomUUID();
          const assistantMessageId = randomUUID();
          const initialChunks = chunks.slice(0, chunkIndex);
          const interruption = initialChunks.at(-1);
          if (interruption?.kind === "interruption" && interruption.id === currentInTurn.id) {
            initialChunks[initialChunks.length - 1] = {
              ...interruption,
              id: replacementId,
            };
          }
          initialChunks.push({
            kind: "user_message",
            id: replacementId,
            content,
            deliveryStatus: "sending",
            capabilities: { edit: true },
          });
          chatManager.createDeliveredInTurnMessage({
            id: replacementId,
            chatId,
            content,
            mode: currentInTurn.mode === "now" ? "now" : "next",
            targetMessageId: assistantMessageId,
            editSessionId: currentInTurn.editSessionId,
            editAnchorId: currentInTurn.editAnchorId,
          });

          chatTurnService.start({
            instance: currentInstance,
            chat: currentChat,
            content,
            uploadIds,
            userMessageId: replacementId,
            assistantMessageId,
            inTurnEdit: {
              sourceAssistant,
              initialChunks,
              sessionId: currentInTurn.editSessionId,
              anchorId: currentInTurn.editAnchorId,
            },
          });
          return { kind: "turn" as const, assistantMessageId };
        }

        const currentEdited = chatManager.getMessage(messageId);
        if (!currentEdited || currentEdited.chatId !== chatId || currentEdited.role !== "user") {
          return {
            kind: "error" as const,
            error: "message not found",
            status: 404 as const,
          };
        }
        const started = chatTurnService.start({
          instance: currentInstance,
          chat: currentChat,
          content,
          uploadIds,
          edit: currentEdited,
        });
        return { kind: "turn" as const, ...started };
      });
    } finally {
      releaseQueueDispatch();
      releaseBranchTransition();
    }
    if (!transition) return c.json({ error: "another turn is in flight for this chat" }, 409);
    if (transition.kind === "error") {
      return c.json({ error: transition.error }, transition.status);
    }
    const { assistantMessageId, userMessage } = transition;

    return pumpTurnStream(
      c,
      chatId,
      assistantMessageId,
      c.req.query("debug") === "1",
      undefined,
      userMessage,
    );
  });

  // Switch the chat's visible branch (version navigation on an edited
  // message). `leafId` may be any message on the target branch, and we
  // descend to the branch's tip. Also re-points the chat's provider-session
  // column at the branch's session so the next turn (and the /context probe)
  // continue the right conversation.
  app.post("/api/instances/:id/chats/:chatId/active-leaf", async (c) => {
    const instanceId = c.req.param("id");
    const chatId = c.req.param("chatId");
    if (!instances.get(instanceId)) return c.json({ error: "instance not found" }, 404);
    const chat = chatForInstance(instanceId, chatId);
    if (!chat) return c.json({ error: "chat not found" }, 404);
    const { leafId } = setActiveLeafBodySchema.parse(await c.req.json());
    const target = chatManager.getMessage(leafId);
    if (!target || target.chatId !== chatId) return c.json({ error: "message not found" }, 404);
    const releaseBranchTransition = beginBranchTransition(chatId);
    const releaseQueueDispatch = chatQueueService.suspendDispatch(chatId);
    let updated: ReturnType<typeof chatManager.get> | null;
    try {
      updated = await chatTransitions.run(chatId, async () => {
        if (!(await terminateForBranchChange(chatId))) return null;
        const currentChat = chatForInstance(instanceId, chatId);
        const currentTarget = chatManager.getMessage(leafId);
        if (!currentChat || !currentTarget || currentTarget.chatId !== chatId) return null;

        const tip = chatManager.descendToTip(chatId, currentTarget);
        chatManager.setActiveLeaf(chatId, tip.id);

        // A pending cross-provider switch is bound to the leaf it was recorded
        // on. Changing branches invalidates it so a later send cannot apply a
        // provider transition to the wrong conversation.
        const pending = providerSwitchStore.get(chatId);
        if (pending && pending.sourceLeafId !== tip.id) providerSwitchStore.clear(chatId);

        // Re-point the chat's session at the branch's own session. Null when the
        // branch never recorded one, so the next turn starts fresh rather than
        // silently resuming another branch's session.
        const branchSession = chatManager.resolveBranchSession(tip.id);
        if (currentChat.provider === "anthropic") {
          chatManager.updateSessionId(chatId, branchSession);
        } else {
          chatManager.updateSessionId(chatId, undefined, branchSession);
        }
        return chatManager.get(chatId);
      });
    } finally {
      releaseQueueDispatch();
      releaseBranchTransition();
    }
    if (!updated) return c.json({ error: "another turn is in flight for this chat" }, 409);
    return c.json({
      ...updated,
      transcript: chatManager.getChatViewPage(chatId, null, 60),
    });
  });

  // Resume an in-flight turn after a network drop, or recover a completed
  // turn from the event log. The response starts with one compact snapshot
  // and then carries only events published after its atomic boundary.
  // Returns 404 only when neither the hub nor the DB has any events
  // for this messageId, i.e. the caller is referencing a turn that
  // never existed.
  app.get("/api/instances/:id/chats/:chatId/messages/:messageId/stream", async (c) => {
    const instanceId = c.req.param("id");
    const chatId = c.req.param("chatId");
    if (!chatForInstance(instanceId, chatId)) return c.json({ error: "chat not found" }, 404);
    const messageId = c.req.param("messageId");
    const includeDebug = c.req.query("debug") === "1";
    const inMemory = chatStreamHub.hasForChat(chatId, messageId);
    const persisted = inMemory
      ? undefined
      : chatManager.getPersistedResumeSnapshot(chatId, messageId, includeDebug);
    if (!inMemory && !persisted) {
      return c.json({ error: "message not found" }, 404);
    }
    return pumpTurnStream(c, chatId, messageId, includeDebug, persisted ?? undefined);
  });

  // Explicit cancel for an in-flight turn (Stop button). Falls through
  // to 404 only when the turn isn't running. Completed turns can't be
  // cancelled, and we don't need to surface that as an error.
  app.delete("/api/instances/:id/chats/:chatId/messages/:messageId", (c) => {
    const instanceId = c.req.param("id");
    const chatId = c.req.param("chatId");
    if (!chatForInstance(instanceId, chatId)) return c.json({ error: "chat not found" }, 404);
    const messageId = c.req.param("messageId");
    const interrupted = chatStreamHub.publishToTurn(chatId, messageId, "turn_interrupted", {
      id: messageId,
    });
    if (interrupted === null) {
      return c.json({ error: "no in-flight turn" }, 404);
    }
    const cancelled = chatStreamHub.cancel(messageId);
    if (!cancelled) return c.json({ error: "no in-flight turn" }, 404);
    return c.json({ ok: true });
  });

  return app;
}
