import { randomUUID } from "node:crypto";
import type { Chat, ChatManager } from "../chats";
import type { ChatEffort, ChatProvider, ChatRenderChunk, Upload } from "../contracts";
import { findChatModel, provisionalTitle } from "../contracts";
import type { ChatMessage } from "../db/schema";
import type { DiffStatsPoller } from "../diff-stats";
import type { InstanceManager } from "../instances";
import type { ProfileManager } from "../profiles";
import type { TitleVmManager } from "../title-vm-manager";
import { toUpload, type UploadStore, uploadGuestPath } from "../uploads";
import type { ChatBackend, UploadAttachment } from "./backend";
import {
  capSummaryText,
  estimateFirstTargetRequest,
  type HandoffAttachment,
  handoffSummaryInstruction,
  type IsoladeBranchMessage,
  isoladeBranchToHandoff,
  makeHandoff,
  reduceHandoffItems,
  renderHandoffEnvelope,
} from "./handoff";
import type { ProviderSwitchStore } from "./provider-switch-store";
import type { ChatStreamHub } from "./stream-hub";

const DEFAULT_DELIVERY_CONFIRMATION_TIMEOUT_MS = 10_000;

// The bytes are cited to the model by absolute path; this block tells the agent
// what was attached and where to find it. Claude reads them with its Read tool,
// and codex uses view_image or the shell. Kept out of the stored message content
// (like the prelude), so the transcript shows only the user's own text.
export function buildAttachmentsPreamble(uploads: UploadAttachment[]): string {
  const lines = uploads.map((u) => `- ${u.guestPath} (${u.mediaType})`);
  return (
    "<attachments>\n" +
    "The user attached these files. They are available at these absolute paths " +
    "inside the workspace:\n" +
    `${lines.join("\n")}\n` +
    "</attachments>"
  );
}

// The instance row shape the turn orchestration reads (profile/vm/title). Taken
// from InstanceManager.get so it tracks the manager without a hand-written type.
type InstanceRecord = NonNullable<ReturnType<InstanceManager["get"]>>;

export interface ChatTurnDeps {
  chatManager: ChatManager;
  providerSwitchStore: ProviderSwitchStore;
  uploadStore: UploadStore;
  instances: InstanceManager;
  profiles: ProfileManager;
  titleVmManager: TitleVmManager;
  diffStatsPoller: DiffStatsPoller;
  chatStreamHub: ChatStreamHub;
  // Provider backends for this turn. In tests both point at the same fake.
  claudeBackend: ChatBackend;
  codexBackend: ChatBackend;
  // Retire the chat's live Claude process before a cross-provider switch
  // activates, so a Claude target starts a fresh session instead of reusing a
  // process positioned at an old Claude tip. No-op when there is no live
  // process. Optional so tests that don't exercise switching can omit it.
  disposeChatProcess?: (chatId: string) => void;
  deliveryConfirmationTimeoutMs?: number;
}

// Owns the orchestration of a single assistant turn: user-message persistence,
// auto-titling, environment prelude injection, the backend send loop, usage
// persistence, and abort semantics. The HTTP layer (chats router) handles
// request validation and the SSE pump. Everything between "we've decided to run
// a turn" and "the turn settled" lives here.
export class ChatTurnService {
  constructor(private readonly deps: ChatTurnDeps) {}

  // Persist the user message and kick off the assistant turn on the stream hub.
  // Returns the reserved assistant messageId (so the caller can pump the SSE
  // response for it) and the persisted user message row (so the client learns
  // its id and tree position). The producer runs asynchronously on the hub, and
  // this returns as soon as the turn is registered.
  //
  // `edit` recomputes the conversation from an earlier point: instead of
  // appending to the active branch's tip, the new user message is inserted as
  // a *sibling* of the edited message (same parent), and the provider session
  // is forked at the nearest anchored turn before it, so the model answers
  // with exactly the context that preceded the edited message. The original
  // branch (messages and session) stays intact and navigable.
  //
  // `inTurnEdit` uses the same assistant-branch model without inserting a
  // top-level user row. Its initial render is the source assistant prefix plus
  // the replacement user chunk, and Claude forks from the acknowledgement
  // checkpoint immediately before that chunk.
  start(opts: {
    instance: InstanceRecord;
    chat: Chat;
    content: string;
    // Ids of files staged via the upload endpoint to attach to this message.
    uploadIds?: string[];
    userMessageId?: string;
    assistantMessageId?: string;
    edit?: ChatMessage;
    inTurnEdit?: {
      sourceAssistant: ChatMessage;
      initialChunks: ChatRenderChunk[];
      sessionId: string;
      anchorId: string;
    };
  }): {
    assistantMessageId: string;
    userMessage?: ChatMessage & { uploads?: Upload[] };
  } {
    const {
      chatManager,
      providerSwitchStore,
      uploadStore,
      instances,
      profiles,
      titleVmManager,
      diffStatsPoller,
      chatStreamHub,
      claudeBackend,
      codexBackend,
      disposeChatProcess,
    } = this.deps;
    const {
      instance,
      chat,
      content,
      uploadIds,
      userMessageId,
      assistantMessageId: requestedAssistantMessageId,
      edit,
      inTurnEdit,
    } = opts;
    const instanceId = instance.id;
    const chatId = chat.id;

    // Where this turn attaches and which provider session it runs in.
    // Normal send: the active branch's tip, resuming the chat's current
    // session. Edit: the edited message's parent, forking (or freshly
    // starting) the session as of that point.
    let parentId: string | null;
    let sessionId: string | undefined;
    let fork: { anchorId: string } | undefined;
    if (inTurnEdit) {
      parentId = inTurnEdit.sourceAssistant.parentId;
      sessionId = inTurnEdit.sessionId;
      fork = { anchorId: inTurnEdit.anchorId };
      chatManager.updateSessionId(chatId, null);
    } else if (edit) {
      // Legacy turns predate per-message session snapshots, but the chat
      // column knows the ACTIVE branch's session. Stamp it onto the branch's
      // nearest un-snapshotted assistant tip now, before the fork overwrites
      // the column, so switching back to this branch later can still resume
      // its session.
      const currentSession =
        chat.provider === "anthropic" ? chat.claudeSessionId : chat.codexThreadId;
      const tip = chatManager.resolveTip(chatId);
      if (currentSession && tip) {
        for (const msg of chatManager.pathToRoot(tip.id)) {
          if (msg.role !== "assistant") continue;
          if (!msg.sessionId) chatManager.setMessageTurnMeta(msg.id, { sessionId: currentSession });
          break;
        }
      }

      parentId = edit.parentId;
      // Fork the current provider's session only. If the edited prefix crosses
      // providers, this returns null and the turn starts a fresh session
      // instead of handing one provider's session id to the other's fork.
      const forkPoint = chatManager.resolveForkPoint(parentId, chat.provider);
      if (forkPoint) {
        sessionId = forkPoint.sessionId;
        fork = { anchorId: forkPoint.anchorId };
      }
      // The new branch's session doesn't exist until the backend forks (or
      // freshly starts) one. Clear the column so a failed fork can't leave
      // the next turn resuming the OLD branch's session against this
      // branch's messages. The backend re-fills it as soon as the new
      // session is established.
      if (chat.provider === "anthropic") chatManager.updateSessionId(chatId, null);
      else chatManager.updateSessionId(chatId, undefined, null);
    } else {
      parentId = chatManager.resolveTip(chatId)?.id ?? null;
      sessionId =
        chat.provider === "anthropic"
          ? (chat.claudeSessionId ?? undefined)
          : (chat.codexThreadId ?? undefined);
    }

    // A pending cross-provider switch activates on this send when it is a normal
    // send (not an edit or an in-turn edit, both of which pin their own provider
    // session) and its recorded source leaf is still on the active branch's
    // lineage. Using lineage (rather than an exact tip match) keeps the switch
    // valid across a failed prior activation that left an orphan user message on
    // the same branch, while a real branch change (the source leaf no longer an
    // ancestor of the tip) still invalidates it.
    const onActiveLineage = (leafId: string | null): boolean => {
      if (leafId == null) return parentId == null;
      if (parentId == null) return false;
      for (const msg of chatManager.pathToRoot(parentId)) {
        if (msg.id === leafId) return true;
      }
      return false;
    };
    let activatingSwitch = !edit && !inTurnEdit ? providerSwitchStore.get(chatId) : undefined;
    if (activatingSwitch && !onActiveLineage(activatingSwitch.sourceLeafId)) {
      providerSwitchStore.clear(chatId);
      activatingSwitch = undefined;
    }
    // The turn's effective provider/model/effort: the target when activating a
    // switch, the chat's own otherwise. All backend selection, pricing, usage
    // enrichment, and persistence below use these, never the stale chat row.
    const turnProvider: ChatProvider = activatingSwitch
      ? activatingSwitch.targetProvider
      : chat.provider;
    const turnModel = activatingSwitch ? activatingSwitch.targetModel : chat.model;
    const turnEffort: ChatEffort = activatingSwitch
      ? ((activatingSwitch.targetEffort as ChatEffort | null) ??
        findChatModel(turnModel)?.defaultEffort ??
        "high")
      : chat.effort;
    if (activatingSwitch) {
      // A cross-provider switch always starts a fresh target native session
      // (no resume, no fork): the target has never seen this conversation, so
      // the handoff carries the context instead.
      sessionId = undefined;
      fork = undefined;
    }

    // Reserve the assistant message id up front so every chat_events
    // row can link to it (even though the chat_messages row only gets
    // inserted on producer success). The client receives this as the
    // first SSE event and uses it both as the React key for the
    // streaming bubble and as the lookup key for replayed events on a
    // future reload or reconnect.
    const assistantMessageId = requestedAssistantMessageId ?? randomUUID();
    const userMessage = inTurnEdit
      ? ({
          id: userMessageId ?? randomUUID(),
          chatId,
          role: "user",
          content,
          parentId,
          sessionId: null,
          anchorId: null,
          deliveryStatus: "sending",
          deliveryError: null,
          provider: null,
          model: null,
          createdAt: new Date(),
        } satisfies ChatMessage)
      : chatManager.beginTurn(chatId, assistantMessageId, content, parentId, userMessageId);
    if (inTurnEdit) chatManager.beginInFlightTurn(chatId, assistantMessageId);
    instances.touch(instanceId);

    // Claim the staged uploads for this message. Their bytes are already in the
    // VM, so we only need the guest paths to cite them to the model.
    const uploadRows = uploadStore.attach(instanceId, chatId, userMessage.id, uploadIds ?? []);
    const uploads: UploadAttachment[] = uploadRows.map((row) => ({
      id: row.id,
      filename: row.filename,
      mediaType: row.mediaType,
      guestPath: uploadGuestPath(row.id, row.filename),
    }));
    // Decorate the row the caller streams back so the client's optimistic
    // bubble reconciles with the persisted attachments (id + preview).
    const userMessageWithUploads: ChatMessage & { uploads?: Upload[] } =
      uploads.length > 0 ? { ...userMessage, uploads: uploadRows.map(toUpload) } : userMessage;
    if (inTurnEdit && uploadRows.length > 0) {
      const inline = inTurnEdit.initialChunks.find(
        (chunk) => chunk.kind === "user_message" && chunk.id === userMessage.id,
      );
      if (inline?.kind === "user_message") inline.uploads = uploadRows.map(toUpload);
    }
    // Title the chat on the first user message of an untitled one. Two steps,
    // both emitting a `title` event so the sidebar updates in place: the
    // provisional title right away (see below), then the generated one when it
    // lands. Runs in parallel with the assistant response. The generated title
    // is minted by the chat's own provider CLI inside a VM (see the backends'
    // generateTitle); if that fails, the provisional one stands.
    const needsTitle = !inTurnEdit && instance.title === null;

    chatStreamHub.startTurn({
      chatId,
      messageId: assistantMessageId,
      initialChunks: inTurnEdit?.initialChunks,
      run: async (api) => {
        // One backend for this turn, picked by the turn's effective provider
        // (the switch target when activating, else the chat's own). Titling
        // through it means a Codex-only profile still gets a real title instead
        // of always truncating.
        const backend = turnProvider === "anthropic" ? claudeBackend : codexBackend;

        // Commit a pending cross-provider switch exactly once, on the first sign
        // the target provider accepted the request (a session id, first delta,
        // or any event). Sets provider/model/effort and resets active usage in
        // one transaction, then clears the pending switch, so the first target
        // usage event diffs against a fresh total instead of the source's larger
        // one. Runs before any usage handling below.
        let switchCommitted = !activatingSwitch;
        const commitSwitchIfAccepted = () => {
          if (switchCommitted) return;
          switchCommitted = true;
          chatManager.commitProviderSwitch(chatId, {
            provider: turnProvider,
            model: turnModel,
            effort: turnEffort,
          });
          providerSwitchStore.clear(chatId);
          // Persist a visible divider at the switch point. Emitted as the target
          // turn's first render event (commit runs before the first delta), so
          // it folds into this assistant message's render chunks and survives a
          // reload. `chat` still holds the source provider/model here.
          api.publish("provider_switch", {
            fromProvider: chat.provider,
            fromModel: chat.model,
            toProvider: turnProvider,
            toModel: turnModel,
          });
        };

        let titlePromise: Promise<void> | null = null;
        if (needsTitle) {
          // Title the chat before the model is even asked. The sidebar gates
          // entry visibility on `title !== null`, so this is what makes the
          // chat show up the moment it is sent rather than a round-trip later.
          const provisional = provisionalTitle(content);
          instances.setTitle(instanceId, provisional);
          api.publish("title", provisional);
          // Mint the real title in the profile's always-warm titling VM when one
          // is ready, so it's not gated on this instance's own (often still
          // cold-booting) VM, and falls back to the instance VM otherwise.
          const titleVmId =
            (instance.profileId && titleVmManager.getReadyVmId(instance.profileId)) ||
            instance.vmId;
          titlePromise = backend
            .generateTitle(titleVmId, content)
            .catch(() => null)
            .then((generated) => {
              if (api.signal.aborted || !generated) return;
              // Swap it in only while the chat still wears the provisional
              // title: a rename in this window is the user's own choice and
              // outranks the model's.
              if (!instances.replaceTitle(instanceId, provisional, generated)) return;
              api.publish("title", generated);
            })
            .catch(() => {});
        }

        let assistantContent =
          inTurnEdit?.initialChunks
            .filter((chunk): chunk is Extract<ChatRenderChunk, { kind: "text" }> => {
              return chunk.kind === "text";
            })
            .map((chunk) => chunk.text)
            .join("") ?? "";
        // Provider-session snapshot for this turn, reported by the backend
        // as facts become known and stamped onto the assistant row on both
        // the success and abort paths, so even an interrupted turn stays
        // forkable later.
        const turnMeta: { sessionId?: string; anchorId?: string } = {};
        let userMessageAcknowledged = false;
        let deliveryConfirmationTimer: ReturnType<typeof setTimeout> | null = null;
        const clearDeliveryConfirmationTimer = () => {
          if (!deliveryConfirmationTimer) return;
          clearTimeout(deliveryConfirmationTimer);
          deliveryConfirmationTimer = null;
        };
        const confirmUserMessage = () => {
          if (userMessageAcknowledged) return;
          userMessageAcknowledged = true;
          clearDeliveryConfirmationTimer();
          if (inTurnEdit) {
            api.publish("steered_user_message", {
              id: userMessage.id,
              content,
              uploads: uploadRows.map(toUpload),
              deliveryStatus: "confirmed",
              capabilities: { edit: true },
            });
          } else {
            chatManager.setUserMessageDelivery(userMessage.id, "confirmed");
            api.publish("user_message_confirmed", { id: userMessage.id });
          }
        };
        const markUserMessageUncertain = (error: string) => {
          if (userMessageAcknowledged) return;
          if (inTurnEdit) {
            api.publish("steered_user_message", {
              id: userMessage.id,
              content,
              uploads: uploadRows.map(toUpload),
              deliveryStatus: "unknown",
              capabilities: { edit: true },
            });
            return;
          }
          const delivery = chatManager.getMessage(userMessage.id);
          if (!delivery) return;
          if (delivery.deliveryStatus === "confirmed") return;
          chatManager.setUserMessageDelivery(userMessage.id, "unknown", error);
          try {
            api.publish("user_message_delivery", {
              id: userMessage.id,
              status: "unknown",
              error,
            });
          } catch (publishError) {
            console.warn("[chat] failed to publish user delivery warning", publishError);
          }
        };
        deliveryConfirmationTimer = setTimeout(
          () => markUserMessageUncertain("the provider did not acknowledge this message in time"),
          this.deps.deliveryConfirmationTimeoutMs ?? DEFAULT_DELIVERY_CONFIRMATION_TIMEOUT_MS,
        );
        deliveryConfirmationTimer.unref?.();
        try {
          // Environment-level prelude: prepended to the first user
          // message of a new chat (no provider session yet) and sent
          // to the backend only. The DB still holds the user's
          // original `content`, so the prelude is invisible in the
          // UI's message list. Wrapped in <prelude> tags so the model
          // can tell it apart from the user's own text. (An edit of the
          // first message also lands here: its recomputed session is just
          // as fresh, so it needs the prelude again.)
          const prelude =
            sessionId || !instance.profileId ? null : profiles.getPrelude(instance.profileId);
          // Compose the message actually sent to the model: optional prelude,
          // optional cross-provider handoff envelope, optional attachments block
          // (cites each file's absolute VM path), then the user's own text. The
          // DB row keeps only `content`, so none of the injected framing shows
          // in the UI.
          const parts: string[] = [];
          if (prelude) parts.push(`<prelude>\n${prelude}\n</prelude>`);
          const attachmentsPreamble = uploads.length > 0 ? buildAttachmentsPreamble(uploads) : null;
          if (activatingSwitch) {
            // Build the provider-neutral handoff from the source branch (every
            // message before this turn) and estimate the complete first target
            // request.
            let handoff = this.buildBranchHandoff(chatId, parentId, chat.provider);
            const targetModelDef = findChatModel(turnModel);
            const capacity = {
              contextWindow: targetModelDef?.contextWindow ?? chat.modelContextWindow ?? 200_000,
            };
            const estimate = estimateFirstTargetRequest(
              { prelude, handoff, attachmentsPreamble, userMessage: content },
              capacity,
            );
            // A current user message that alone exceeds the target's hard limit
            // can't be fixed by reducing history, so refuse rather than silently
            // summarizing a new instruction.
            if (estimate.userMessageExceedsHardLimit) {
              throw new Error(
                "This message is too large for the selected model even with no prior context. " +
                  "Shorten it or split it into smaller messages.",
              );
            }
            console.info(
              `[chat] activating provider switch ${chat.provider}→${turnProvider} (chat=${chatId}) ` +
                `handoff bucket=${estimate.bucket} est_input=${estimate.estimatedInputTokens}`,
            );
            // Too big to hand over verbatim: reduce the conversation to a
            // compact summary. Summarization always runs on the SOURCE model in
            // a throwaway scratch session, so it never touches the chat's own
            // session and any scratch Claude process is retired after.
            if (estimate.bucket === "oversized") {
              const sourceBackend = chat.provider === "anthropic" ? claudeBackend : codexBackend;
              // Run one summarization turn on the source backend in a throwaway
              // scratch session. When `fork` is given, the scratch turn forks the
              // source's live session (which already holds the whole conversation
              // prompt-cached) so the summary is one cache-advantaged pass; when
              // it is not, the prompt itself carries the conversation.
              const scratchSummarize = async (
                prompt: string,
                sourceFork?: { sessionId: string; anchorId: string },
                signal?: AbortSignal,
              ): Promise<string> => {
                const scratchChatId = `handoff-reduce-${chatId}-${randomUUID()}`;
                try {
                  const summary = await sourceBackend.sendMessage({
                    vmId: instance.vmId,
                    chatId: scratchChatId,
                    message: prompt,
                    model: chat.model,
                    effort: chat.effort,
                    sessionId: sourceFork?.sessionId,
                    fork: sourceFork ? { anchorId: sourceFork.anchorId } : undefined,
                    signal,
                    onDelta: () => {},
                  });
                  return summary.content;
                } finally {
                  // No-op for a Codex scratch id (no per-chat process); retires
                  // the throwaway Claude process otherwise.
                  disposeChatProcess?.(scratchChatId);
                }
              };

              let reduced: typeof handoff.items | null = null;
              // Preferred, cheap path: fork the source session and summarize the
              // conversation the model already holds, in a single turn.
              const src = activatingSwitch;
              if (src.sourceSessionId && src.sourceAnchorId) {
                try {
                  const summary = (
                    await scratchSummarize(
                      handoffSummaryInstruction(),
                      { sessionId: src.sourceSessionId, anchorId: src.sourceAnchorId },
                      api.signal,
                    )
                  ).trim();
                  if (summary) reduced = [{ kind: "summary", text: capSummaryText(summary) }];
                } catch (err) {
                  console.warn(
                    `[chat] fork summarize failed (chat=${chatId}); falling back to chunked reduce:`,
                    err,
                  );
                }
              }
              // Fallback: no forkable source session (or the fork failed), so
              // re-feed the branch in bounded chunks and roll a running summary.
              if (!reduced) {
                const sourceWindow =
                  findChatModel(chat.model)?.contextWindow ?? chat.modelContextWindow ?? 200_000;
                reduced = await reduceHandoffItems(handoff.items, {
                  summarize: (prompt, signal) => scratchSummarize(prompt, undefined, signal),
                  // Leave headroom for the running summary, instructions, and the
                  // response within the summarizer's window.
                  chunkBudgetTokens: Math.floor(sourceWindow * 0.5),
                  signal: api.signal,
                  onProgress: (step, total) =>
                    console.info(
                      `[chat] summarizing handoff (chat=${chatId}) chunk ${step}/${total}`,
                    ),
                });
              }
              handoff = makeHandoff(handoff.source, reduced);
              // Belt and suspenders: confirm the reduced handoff plus the
              // current message now fits. It only wouldn't if the current
              // message is itself nearly the whole window, which no amount of
              // history reduction can fix, so refuse rather than send a request
              // the target will reject.
              const after = estimateFirstTargetRequest(
                { prelude, handoff, attachmentsPreamble, userMessage: content },
                capacity,
              );
              if (after.bucket === "oversized") {
                throw new Error(
                  "This message is too large for the selected model. " +
                    "Shorten it or split it into smaller messages.",
                );
              }
            }
            // Retire the chat's live Claude process ONLY when the target is
            // Claude, so a Claude target starts a fresh session rather than
            // resuming an old Claude tip. For a Codex target the Claude process
            // is never reused (different backend), so leave it for the idle
            // reaper: disposing it here needlessly churns the VM's exec-streams
            // right as the Codex app-server is starting.
            if (turnProvider === "anthropic") disposeChatProcess?.(chatId);
            parts.push(renderHandoffEnvelope(handoff));
          }
          if (attachmentsPreamble) parts.push(attachmentsPreamble);
          // Content can be empty when the message is attachments-only.
          if (content.length > 0) parts.push(content);
          const outgoingMessage = parts.join("\n\n");
          const result = await backend.sendMessage({
            vmId: instance.vmId,
            chatId,
            message: outgoingMessage,
            model: turnModel,
            effort: turnEffort,
            // Gated on the TURN's model, not the row's flag alone: fast mode only
            // exists where the provider offers a fast rate card, and a turn that
            // asked for it without one would be costed at a premium the provider
            // never charged. The flag is cleared wherever a model change strands
            // it, so this is the belt to that braces.
            fast: chat.fastMode && findChatModel(turnModel)?.fastPricing != null,
            sessionId,
            userMessageId: userMessage.id,
            fork,
            signal: api.signal,
            onDelta: (text) => {
              commitSwitchIfAccepted();
              api.publish("delta", text);
              assistantContent += text;
            },
            onMeta: (meta) => {
              commitSwitchIfAccepted();
              if (meta.sessionId !== undefined) turnMeta.sessionId = meta.sessionId;
              if (meta.anchorId !== undefined) turnMeta.anchorId = meta.anchorId;
            },
            onUserMessageAcknowledged: confirmUserMessage,
            // A settled turn's bill. Never published: it is accounting, and the
            // event log is a transcript. The figure reaches the client on the
            // next `usage` frame, as part of the chat's running total.
            onBilling: (models) => {
              commitSwitchIfAccepted();
              chatManager.recordTurnBilling(chatId, models);
            },
            onEvent: (event) => {
              // Any event proves the target accepted the request, so commit a
              // pending switch before touching usage: updateUsage below reads
              // the (now target) provider/model for pricing and diffs against
              // the reset totals.
              commitSwitchIfAccepted();
              // Persist the full usage snapshot onto the chat row so
              // the next mount of the chat UI can rehydrate UsageState
              // without waiting for a new turn.
              if (event.type === "usage") {
                // What the client sees as one number is two facts: what the chat
                // has been billed for its finished turns, which only the chat row
                // knows, plus whatever the turn in flight has run up so far,
                // which only the backend knows and which nothing records. Adding
                // them here is the one place both are in hand, and it keeps the
                // published frame to a single figure the UI can just display.
                const settled = chatManager.get(chatId)?.costUsd ?? 0;
                const costUsd = settled + (event.turnCostUsd ?? 0);
                const usageEvent = {
                  type: "usage" as const,
                  last: event.last,
                  total: event.total,
                  modelContextWindow: event.modelContextWindow,
                  costUsd,
                };
                // Publish before mutating any other durable or compact state.
                // If the event log write fails, the turn aborts without
                // finalizing data that no live client or reconnect could see.
                api.publish(usageEvent.type, usageEvent);
                chatManager.updateUsage(chatId, {
                  total: event.total,
                  last: event.last,
                  modelContextWindow: event.modelContextWindow,
                });
                return;
              }
              api.publish(event.type, event);
              if (event.type === "tool_call_result") {
                // A finished tool call is the moment the VM's filesystem
                // may have changed, so refresh the sidebar diff stats.
                diffStatsPoller.nudge(instanceId);
              } else if (event.type === "context_compacted") {
                chatManager.markCompacted(chatId);
              }
            },
          });
          // Successful completion is itself definitive evidence that the
          // provider accepted the user input, even if an older provider
          // version omitted or raced the explicit acknowledgement event.
          confirmUserMessage();
          // A successful result (even an empty one) also proves the target
          // accepted the request, so commit any pending switch before finalizing.
          commitSwitchIfAccepted();
          assistantContent = result.content || assistantContent;
          const renderChunks = api.renderChunks();
          const persistedContent = inTurnEdit
            ? renderChunks
                .filter((chunk): chunk is Extract<ChatRenderChunk, { kind: "text" }> => {
                  return chunk.kind === "text";
                })
                .map((chunk) => chunk.text)
                .join("")
            : assistantContent;
          chatManager.finalizeTurn(
            chatId,
            assistantMessageId,
            persistedContent,
            {
              parentId: inTurnEdit ? inTurnEdit.sourceAssistant.parentId : userMessage.id,
              sessionId: turnMeta.sessionId ?? result.sessionId ?? null,
              anchorId: turnMeta.anchorId ?? null,
              // Record which provider/model produced this turn, so a chat that
              // later switches providers can tell each turn's native session
              // apart (a native fork is only valid with the same provider).
              provider: turnProvider,
              model: turnModel,
            },
            renderChunks,
          );
          // Turn finished: float the instance up and flag it unread. The client
          // clears the flag immediately if the user is viewing this instance, so
          // it only sticks for turns that complete in the background.
          instances.markActivity(instanceId);
          // Catch the turn's final filesystem state even when the last
          // tool result's debounced probe raced an in-flight one.
          diffStatsPoller.nudge(instanceId);
          if (titlePromise) await titlePromise.catch(() => {});
        } catch (err) {
          markUserMessageUncertain(err instanceof Error ? err.message : String(err));
          // Persist any partial text for both cancellation and provider
          // failures. The live client commits that same partial before showing
          // an error, so durable history must agree after a reload.
          const renderChunks = api.renderChunks();
          if (assistantContent.length > 0 || renderChunks.length > 0) {
            try {
              chatManager.finalizeTurn(
                chatId,
                assistantMessageId,
                assistantContent,
                {
                  parentId: inTurnEdit ? inTurnEdit.sourceAssistant.parentId : userMessage.id,
                  sessionId: turnMeta.sessionId ?? null,
                  anchorId: turnMeta.anchorId ?? null,
                  // Partial content means the target accepted and streamed, so
                  // the switch already committed: record the target here too.
                  provider: turnProvider,
                  model: turnModel,
                },
                renderChunks,
              );
            } catch (persistError) {
              console.warn("[chat] failed to persist partial assistant message", persistError);
            }
          }
          if (assistantContent.length === 0 && renderChunks.length === 0) {
            chatManager.clearInFlightTurn(chatId, assistantMessageId);
          }
          if (api.signal.aborted) {
            instances.touch(instanceId);
            if (titlePromise) await titlePromise.catch(() => {});
          }
          throw err;
        } finally {
          clearDeliveryConfirmationTimer();
        }
      },
    });

    return {
      assistantMessageId,
      ...(inTurnEdit ? {} : { userMessage: userMessageWithUploads }),
    };
  }

  // Build the provider-neutral handoff for a cross-provider switch from the
  // Isolade message and event stores: every message on the active branch up to
  // and including `throughMessageId` (the source branch tip, i.e. the parent of
  // the turn being sent). This host-side path needs no guest access and no
  // source model request, so it powers direct transfer. Assistant turns use
  // their persisted render chunks (full, non-debug) so tool calls and results
  // carry over; user messages carry their attachments by guest path.
  private buildBranchHandoff(
    chatId: string,
    throughMessageId: string | null,
    source: ChatProvider,
  ) {
    const { chatManager, uploadStore } = this.deps;
    const rootToTip: IsoladeBranchMessage[] = [];
    for (const msg of chatManager.pathToRoot(throughMessageId)) {
      rootToTip.push({ id: msg.id, role: msg.role, content: msg.content });
    }
    rootToTip.reverse();
    const assistantIds = rootToTip.filter((m) => m.role === "assistant").map((m) => m.id);
    const renderChunksByMessageId = chatManager.getMessageRenderChunks(
      chatId,
      assistantIds,
      false,
      false,
    );
    const userIds = rootToTip.filter((m) => m.role === "user").map((m) => m.id);
    const attachmentsByMessageId: Record<string, HandoffAttachment[]> = {};
    for (const [messageId, ups] of uploadStore.byMessageForChat(chatId, userIds)) {
      attachmentsByMessageId[messageId] = ups.map((u) => ({
        filename: u.filename,
        mediaType: u.mediaType,
        guestPath: uploadGuestPath(u.id, u.filename),
      }));
    }
    return isoladeBranchToHandoff({
      source,
      messages: rootToTip,
      renderChunksByMessageId,
      attachmentsByMessageId,
    });
  }
}
