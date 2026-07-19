import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { StreamSignal } from "../chat/stream-hub";
import { computeSubscriptionShare } from "../chat/subscription-share";
import type { ChatModelDefinition } from "../contracts";
import {
  CHAT_MODELS,
  type ChatModelsResponse,
  clampEffortToModel,
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

  // Drive a Hono SSE stream from a hub subscription. The subscriber
  // callback is synchronous (and must stay so, because the hub fans out to
  // all subscribers in a tight loop), so we can't `await` writeSSE
  // inside it. Instead we push every signal into an outbox and drain
  // it from a separate async loop where writes ARE awaited. This
  // guarantees the final `done`/`error` byte hits the wire before we
  // return from the streamSSE callback (which closes the response).
  //
  // It also lets a slow client apply backpressure cleanly: the outbox
  // grows, but the producer is unaffected (publishes stay sync), so
  // we never starve other subscribers. Per-turn outbox depth is bounded
  // by the turn's total event count, which is itself bounded.
  async function pumpHub(
    c: import("hono").Context,
    chatId: string,
    messageId: string,
    afterSeq: number,
    // The user message row this turn replies to. Present only on the two
    // POST paths that just created it (send, edit): the client gets the
    // server-assigned id and tree position as the stream's first frame, so
    // it can reconcile its optimistic bubble without a refetch. Resume GETs
    // omit it (the row is already in the client's hydrated history).
    userMessage?: ChatMessage,
  ): Promise<Response> {
    return streamSSE(c, async (stream) => {
      let aborted = false;
      // Write helper: swallows errors only when we already know the
      // client went away (abort flagged below by stream.onAbort or our
      // own teardown). A write failure with `aborted=false` is a real
      // server-side problem we want to see in logs, usually a
      // double-write, a closed transform, or backpressure misuse.
      const safeWrite = async (frame: Parameters<typeof stream.writeSSE>[0]) => {
        try {
          await stream.writeSSE(frame);
        } catch (err) {
          if (aborted) return;
          console.warn(
            `[chat] SSE write failed (chat=${chatId} msg=${messageId} event=${frame.event ?? "message"}):`,
            err,
          );
        }
      };

      if (userMessage) {
        await safeWrite({ event: "user_message", data: JSON.stringify(userMessage) });
      }
      await safeWrite({ event: "message_id", data: JSON.stringify(messageId) });

      type Outboxed =
        | { kind: "event"; seq: number; type: string; payload: unknown }
        | { kind: "done" }
        | { kind: "error"; message: string }
        | { kind: "ping" };
      const outbox: Outboxed[] = [];
      let wake: (() => void) | null = null;

      const enqueue = (item: Outboxed) => {
        outbox.push(item);
        wake?.();
        wake = null;
      };

      const onSignal = (signal: StreamSignal) => {
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
      };

      const sub = chatStreamHub.subscribe(messageId, afterSeq, onSignal);
      if (!sub) {
        // DB-only replay path. Hit either when the turn has been
        // evicted from the hub (normal: turn finished a while ago) or
        // when the server restarted while the turn was in flight
        // (the in-memory hub is gone, but the chat_events rows survive).
        //
        // For the crash-recovery sub-case, the chat_messages row was
        // never inserted (we only insert on producer success). If we
        // emit `done` without backfilling that row, the client's
        // hydration logic will see persisted events without a
        // matching chat_messages and try to resume again on every
        // reload, an infinite loop. So we materialize the row here
        // from the persisted delta events (best-effort) before
        // emitting `done`.
        // afterSeq=-2 so the seq=-1 `turn_started` marker counts as "this
        // turn was started". A turn that died before publishing any real
        // event has only that marker, but we still want to materialize an
        // (empty) assistant row for it so the client's hydration stops
        // re-detecting it as in-flight on every future mount. Delta recovery
        // below simply finds nothing and yields "".
        const fullEvents = chatManager.getEventsForMessage(messageId, -2);
        const existing = chatManager.getMessages(chatId).some((m) => m.id === messageId);
        if (fullEvents.length > 0 && !existing) {
          // We only restore the textual content from delta events.
          // Tool calls / thinking / usage are still replayed on the
          // wire below (so the UI gets the full picture), but they
          // don't make it into the assistant message body. Its
          // .content field stays text-only by design.
          let recovered = "";
          for (const ev of fullEvents) {
            if (ev.type !== "delta") continue;
            try {
              const text = JSON.parse(ev.payload);
              if (typeof text === "string") recovered += text;
            } catch (err) {
              console.warn(
                `[chat] recovered delta event has non-JSON payload (chat=${chatId} msg=${messageId} seq=${ev.seq}):`,
                err,
              );
            }
          }
          try {
            // The dead turn's user message is the active branch's tip (the
            // leaf advanced onto it at turn start, and the assistant row
            // never landed to advance it further), so hang the recovered
            // row there. If the tip is somehow an assistant row, leave the
            // recovered message parentless rather than fork a bogus branch.
            const tip = chatManager.resolveTip(chatId);
            const parentId = tip?.role === "user" ? tip.id : null;
            chatManager.addMessageWithId(chatId, messageId, "assistant", recovered, { parentId });
            if (parentId) chatManager.setActiveLeaf(chatId, messageId);
          } catch (e) {
            console.warn(
              `[chat] failed to backfill recovered message (chat=${chatId} msg=${messageId}):`,
              e,
            );
          }
        }
        const events = chatManager.getEventsForMessage(messageId, afterSeq);
        for (const ev of events) {
          let payload: unknown;
          try {
            payload = JSON.parse(ev.payload);
          } catch (err) {
            // A corrupted payload column suggests the row got written
            // with something other than JSON.stringify, an invariant
            // violation in appendEvent. Preserve the string so the
            // client still gets *something*, but make the corruption
            // visible.
            console.warn(
              `[chat] event payload not JSON on replay (chat=${chatId} msg=${messageId} seq=${ev.seq} type=${ev.type}):`,
              err,
            );
            payload = ev.payload;
          }
          await safeWrite({
            id: String(ev.seq),
            event: ev.type,
            data: JSON.stringify(payload),
          });
        }
        await safeWrite({ event: "done", data: "" });
        return;
      }

      // Heartbeat: keeps proxies happy and lets the client detect a
      // dead connection even when the model is thinking silently.
      // Pushed through the outbox so it serializes with real events
      // rather than racing the drain loop, since two concurrent writeSSE
      // calls can interleave SSE frames.
      const heartbeat = setInterval(() => {
        if (aborted) return;
        enqueue({ kind: "ping" });
      }, 15_000);

      // Client disconnects (tab close, refresh, network drop). Drop
      // our subscription so the hub starts the no-subscriber grace
      // timer instead of cancelling immediately. Also wake the drain
      // loop so it exits.
      stream.onAbort(() => {
        aborted = true;
        wake?.();
        wake = null;
      });

      // Drain loop: serialize writes and await each one so the bytes
      // hit the wire before we return.
      while (!aborted) {
        if (outbox.length === 0) {
          await new Promise<void>((r) => {
            wake = r;
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
        } else if (item.kind === "ping") {
          await safeWrite({ data: "", event: "ping" });
        } else {
          await safeWrite({ event: "error", data: item.message });
          break;
        }
      }

      sub.unsubscribe();
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
    const existing = chatManager.get(chatId);
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
    const chatId = c.req.param("chatId");
    if (!chatManager.get(chatId)) return c.json({ error: "not found" }, 404);
    chatStreamHub.cancelForChat(chatId);
    // Shut down the chat's persistent `claude` process (and its background
    // tasks). The chat is gone, so the warm process has nothing to serve.
    realClaudeBackend.disposeChat(chatId);
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
    const chat = chatManager.get(chatId);
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
    if (chatStreamHub.inFlightFor(chatId)) {
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

  app.get("/api/instances/:id/chats/:chatId/messages", (c) => {
    const chatId = c.req.param("chatId");
    if (!chatManager.get(chatId)) return c.json({ error: "not found" }, 404);
    return c.json(chatManager.getMessages(chatId));
  });

  // Structured event log for the chat. The client groups by `messageId`
  // and feeds the events through its chunk reducer to rebuild tool
  // calls, thinking blocks, etc. Returned ordered for caller convenience
  // (no client-side sort needed).
  app.get("/api/instances/:id/chats/:chatId/events", (c) => {
    const chatId = c.req.param("chatId");
    if (!chatManager.get(chatId)) return c.json({ error: "not found" }, 404);
    // Already ordered by (messageId, seq) in SQL. See ChatManager.getEvents.
    return c.json(chatManager.getEvents(chatId));
  });

  app.post("/api/instances/:id/chats/:chatId/messages", async (c) => {
    const instanceId = c.req.param("id");
    const chatId = c.req.param("chatId");
    const instance = instances.get(instanceId);
    if (!instance) return c.json({ error: "instance not found" }, 404);
    if (instance.archived) return archivedError(c);
    const chat = chatManager.get(chatId);
    if (!chat) return c.json({ error: "chat not found" }, 404);
    const { content } = createChatMessageBodySchema.parse(await c.req.json());
    if (!content) return c.json({ error: "content is required" }, 400);

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
    if (chatStreamHub.inFlightFor(chatId)) {
      return c.json({ error: "another turn is in flight for this chat" }, 409);
    }

    // Persist the user message and start the assistant turn (titling, prelude
    // injection, usage persistence, abort semantics all live in the service).
    const { assistantMessageId, userMessage } = chatTurnService.start({
      instance,
      chat,
      content,
    });

    return pumpHub(c, chatId, assistantMessageId, -1, userMessage);
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
    const chat = chatManager.get(chatId);
    if (!chat) return c.json({ error: "chat not found" }, 404);
    const edited = chatManager.getMessage(c.req.param("messageId"));
    if (!edited || edited.chatId !== chatId) return c.json({ error: "message not found" }, 404);
    if (edited.role !== "user") return c.json({ error: "only user messages can be edited" }, 400);
    const { content } = editChatMessageBodySchema.parse(await c.req.json());

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
    if (chatStreamHub.inFlightFor(chatId)) {
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
      edit: edited,
    });

    return pumpHub(c, chatId, assistantMessageId, -1, userMessage);
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
    const chat = chatManager.get(chatId);
    if (!chat) return c.json({ error: "chat not found" }, 404);
    const { leafId } = setActiveLeafBodySchema.parse(await c.req.json());
    const target = chatManager.getMessage(leafId);
    if (!target || target.chatId !== chatId) return c.json({ error: "message not found" }, 404);
    // A streaming turn belongs to the branch it started on. Re-pointing the
    // session out from under it would corrupt both branches, so block the
    // switch until it settles (the client disables navigation while
    // streaming, this is the server-side guarantee).
    if (chatStreamHub.inFlightFor(chatId)) {
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
    return c.json(updated ? await enrichChat(updated) : updated);
  });

  // Resume an in-flight turn after a network drop, or replay a
  // completed turn from the event log. The client passes
  // `?afterSeq=N` so we don't re-emit events it already applied.
  // Returns 404 only when neither the hub nor the DB has any events
  // for this messageId, i.e. the caller is referencing a turn that
  // never existed.
  app.get("/api/instances/:id/chats/:chatId/messages/:messageId/stream", async (c) => {
    const chatId = c.req.param("chatId");
    if (!chatManager.get(chatId)) return c.json({ error: "chat not found" }, 404);
    const messageId = c.req.param("messageId");
    const afterSeq = Math.max(
      -1,
      Number.isFinite(Number(c.req.query("afterSeq"))) ? Number(c.req.query("afterSeq")) : -1,
    );

    // Reject obviously bogus references: not in flight AND no
    // persisted events. Without this we'd accept any UUID and emit a
    // bare `done`, masking client bugs.
    if (!chatStreamHub.has(messageId)) {
      // Count the seq=-1 `turn_started` marker too (afterSeq=-2), not just
      // real events. The client's in-flight detection keys off that marker
      // (listChatEvents / getEvents returns it), so a turn that was started
      // but died before publishing anything (its hub entry since evicted)
      // still looks "in flight" to the client and gets resumed. Checking only
      // seq>-1 here would 404 it, surfacing as a spurious "turn not found on
      // server". Route it to the DB-replay path below instead, which
      // materializes the dead turn so it stops being re-detected. Only a
      // messageId with no rows at all is a genuine never-existed reference.
      const persisted = chatManager.getEventsForMessage(messageId, -2);
      if (persisted.length === 0) {
        return c.json({ error: "message not found" }, 404);
      }
    }

    return pumpHub(c, chatId, messageId, afterSeq);
  });

  // Explicit cancel for an in-flight turn (Stop button). Falls through
  // to 404 only when the turn isn't running. Completed turns can't be
  // cancelled, and we don't need to surface that as an error.
  app.delete("/api/instances/:id/chats/:chatId/messages/:messageId", (c) => {
    const chatId = c.req.param("chatId");
    if (!chatManager.get(chatId)) return c.json({ error: "chat not found" }, 404);
    const messageId = c.req.param("messageId");
    const cancelled = chatStreamHub.cancel(messageId);
    if (!cancelled) return c.json({ error: "no in-flight turn" }, 404);
    return c.json({ ok: true });
  });

  return app;
}
