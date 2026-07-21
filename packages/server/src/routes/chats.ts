import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { computeSubscriptionShare } from "../chat/subscription-share";
import type { ChatModelDefinition, ChatResumeSnapshot } from "../contracts";
import {
  CHAT_MODELS,
  type ChatModelsResponse,
  clampEffortToModel,
  compactChatRenderEvents,
  createChatBodySchema,
  createChatMessageBodySchema,
  editChatMessageBodySchema,
  findChatModel,
  setActiveLeafBodySchema,
  updateChatBodySchema,
} from "../contracts";
import type { ChatMessage } from "../db/schema";
import type { RouteContext } from "./context";

// ---- Chats: models, CRUD, transcript/events, and the streaming turn ----
export function createChatsRouter(ctx: RouteContext): Hono {
  const {
    chatManager,
    uploadStore,
    instances,
    profiles,
    chatStreamHub,
    claudeBackend,
    codexBackend,
    realClaudeBackend,
    chatTurnService,
    profileUsageStats,
    archivedError,
  } = ctx;
  const app = new Hono();

  // Resolve a model id against the static catalog (Claude + Codex). Returns
  // undefined when the id is unknown.
  const findModelForInstance = (modelId: string): ChatModelDefinition | undefined =>
    findChatModel(modelId);

  const chatForInstance = (instanceId: string, chatId: string) => {
    const chat = chatManager.get(chatId);
    return chat?.instanceId === instanceId ? chat : undefined;
  };

  // Compute the server-side subscriptionShare for a chat row, if the chat
  // has a cumulative usage snapshot. Returns the row unchanged when usage
  // hasn't been recorded yet (fresh chat, legacy row), so the field stays
  // undefined and the UI omits the row.
  type ChatRow = ReturnType<typeof chatManager.get>;
  async function enrichChat(chat: NonNullable<ChatRow>) {
    if (chat.inputTokens == null) return chat;
    // Resolve the chat's profile so the share reads that profile's usage/plan.
    // /api/chats spans every profile, so this can't assume a single active one.
    // An orphaned chat (instance deleted) has no profile → leave the share off.
    const profileId = instances.get(chat.instanceId)?.profileId;
    if (!profileId) return chat;
    const share = await computeSubscriptionShare({
      provider: chat.provider,
      modelId: chat.model,
      stats: await profileUsageStats(profileId),
      authStore: profiles.auth(profileId),
      total: {
        inputTokens: chat.inputTokens,
        cachedInputTokens: chat.cachedInputTokens ?? 0,
        cacheCreationInputTokens: chat.cacheCreationInputTokens ?? 0,
        outputTokens: chat.outputTokens ?? 0,
        reasoningOutputTokens: chat.reasoningOutputTokens ?? 0,
        totalTokens: 0,
      },
    });
    return share ? { ...chat, subscriptionShare: share } : chat;
  }

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
        await safeWrite({ event: "user_message", data: JSON.stringify(userMessage) });
      }
      await safeWrite({ event: "message_id", data: JSON.stringify(messageId) });
      await safeWrite({ event: "snapshot", data: JSON.stringify(snapshot) });
      if (snapshot.status === "done") {
        await safeWrite({ event: "done", data: "" });
        sub?.unsubscribe();
        return;
      }
      if (snapshot.status === "error") {
        await safeWrite({ event: "error", data: snapshot.error ?? "turn failed" });
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
    const { model, effort } = createChatBodySchema.parse(await c.req.json());
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
    );
    return c.json(chat, 201);
  });

  app.get("/api/instances/:id/chats", async (c) => {
    const instanceId = c.req.param("id");
    if (!instances.get(instanceId)) return c.json({ error: "not found" }, 404);
    const chats = chatManager.list(instanceId);
    return c.json(await Promise.all(chats.map(enrichChat)));
  });

  app.get("/api/chats", async (c) => {
    const chats = chatManager.listAll();
    return c.json(await Promise.all(chats.map(enrichChat)));
  });

  app.patch("/api/instances/:id/chats/:chatId", async (c) => {
    const instanceId = c.req.param("id");
    const instance = instances.get(instanceId);
    if (!instance) return c.json({ error: "instance not found" }, 404);
    const chatId = c.req.param("chatId");
    const existing = chatForInstance(instanceId, chatId);
    if (!existing) return c.json({ error: "not found" }, 404);
    const { model, effort } = updateChatBodySchema.parse(await c.req.json());
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
    if (model !== undefined) {
      chatManager.updateModel(chatId, model, modelDef.provider, nextEffort);
    } else {
      chatManager.updateEffort(chatId, nextEffort);
    }
    const updated = chatManager.get(chatId);
    return c.json(updated ? await enrichChat(updated) : updated);
  });

  app.delete("/api/instances/:id/chats/:chatId", (c) => {
    const instanceId = c.req.param("id");
    const chatId = c.req.param("chatId");
    if (!chatForInstance(instanceId, chatId)) return c.json({ error: "not found" }, 404);
    chatStreamHub.cancelForChat(chatId);
    // Shut down the chat's persistent `claude` process (and its background
    // tasks). The chat is gone, so the warm process has nothing to serve.
    realClaudeBackend.disposeChat(chatId);
    uploadStore.removeForChat(chatId);
    chatManager.remove(chatId);
    return c.json({ ok: true });
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
    const byMessage = uploadStore.byMessageForChat(
      chatId,
      page.messages.map((message) => message.id),
    );
    return c.json({
      ...page,
      messages: page.messages.map((message) => {
        const uploads = byMessage.get(message.id);
        return uploads?.length ? { ...message, uploads } : message;
      }),
    });
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
    const { content, uploadIds } = createChatMessageBodySchema.parse(await c.req.json());
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

    // Don't start a second turn while one is still running for this
    // chat. The client UI gates this already (Stop button disables
    // Send), but the server enforces it so two tabs racing to send
    // can't produce overlapping CLI invocations.
    if (chatManager.inFlightMessageId(chatId) || chatStreamHub.inFlightFor(chatId)) {
      return c.json({ error: "another turn is in flight for this chat" }, 409);
    }

    // Persist the user message and start the assistant turn (titling, prelude
    // injection, usage persistence, abort semantics all live in the service).
    const { assistantMessageId, userMessage } = chatTurnService.start({
      instance,
      chat,
      content,
      uploadIds,
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

  // Edit a user message: insert a sibling version under the same parent and
  // recompute the assistant answer from that point. The provider session is
  // forked at the nearest anchored turn before the edited message (see
  // ChatTurnService.start), so the model sees exactly the context that
  // preceded it, and the original branch stays intact and navigable. The
  // response is the same SSE turn stream as a normal send.
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
    const edited = chatManager.getMessage(c.req.param("messageId"));
    if (!edited || edited.chatId !== chatId) return c.json({ error: "message not found" }, 404);
    if (edited.role !== "user") return c.json({ error: "only user messages can be edited" }, 400);
    const { content, uploadIds } = editChatMessageBodySchema.parse(await c.req.json());
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
    if (chatManager.inFlightMessageId(chatId) || chatStreamHub.inFlightFor(chatId)) {
      return c.json({ error: "another turn is in flight for this chat" }, 409);
    }

    // The fork resumes a session the chat's live CLI process (if any) is not
    // positioned at, so that process can't serve this turn. Retire it up
    // front. Its background tasks die with it, exactly as on chat delete.
    realClaudeBackend.disposeChat(chatId);

    const { assistantMessageId, userMessage } = chatTurnService.start({
      instance,
      chat,
      content,
      uploadIds,
      edit: edited,
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
    // A streaming turn belongs to the branch it started on. Re-pointing the
    // session out from under it would corrupt both branches, so block the
    // switch until it settles (the client disables navigation while
    // streaming, this is the server-side guarantee).
    if (chatManager.inFlightMessageId(chatId) || chatStreamHub.inFlightFor(chatId)) {
      return c.json({ error: "another turn is in flight for this chat" }, 409);
    }

    const tip = chatManager.descendToTip(chatId, target);
    chatManager.setActiveLeaf(chatId, tip.id);

    // Re-point the chat's session at the branch's own session. Null when the
    // branch never recorded one (its turns all failed early): the next send
    // then starts fresh rather than silently resuming another branch's
    // session. The live CLI process (if any) is positioned at the OLD
    // branch's session, so retire it whenever the session actually changes.
    const branchSession = chatManager.resolveBranchSession(tip.id);
    if (chat.provider === "anthropic") {
      if ((chat.claudeSessionId ?? null) !== branchSession) {
        chatManager.updateSessionId(chatId, branchSession);
        realClaudeBackend.disposeChat(chatId);
      }
    } else if ((chat.codexThreadId ?? null) !== branchSession) {
      chatManager.updateSessionId(chatId, undefined, branchSession);
    }

    const updated = chatManager.get(chatId);
    return c.json(
      updated
        ? {
            ...updated,
            transcript: chatManager.getChatViewPage(chatId, null, 60),
          }
        : updated,
    );
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
    if (!chatStreamHub.hasForChat(chatId, messageId)) {
      return c.json({ error: "no in-flight turn" }, 404);
    }
    const cancelled = chatStreamHub.cancel(messageId);
    if (!cancelled) return c.json({ error: "no in-flight turn" }, 404);
    return c.json({ ok: true });
  });

  return app;
}
