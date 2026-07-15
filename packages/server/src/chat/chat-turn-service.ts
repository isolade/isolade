import { randomUUID } from "node:crypto";
import type { Chat, ChatManager } from "../chats";
import type { UsageStats } from "../contracts";
import type { DiffStatsPoller } from "../diff-stats";
import type { InstanceManager } from "../instances";
import type { ProfileManager } from "../profiles";
import type { TitleVmManager } from "../title-vm-manager";
import type { ChatBackend } from "./backend";
import type { ChatStreamHub } from "./stream-hub";
import { computeSubscriptionShare } from "./subscription-share";

// The instance row shape the turn orchestration reads (profile/vm/title). Taken
// from InstanceManager.get so it tracks the manager without a hand-written type.
type InstanceRecord = NonNullable<ReturnType<InstanceManager["get"]>>;

export interface ChatTurnDeps {
  chatManager: ChatManager;
  instances: InstanceManager;
  profiles: ProfileManager;
  titleVmManager: TitleVmManager;
  diffStatsPoller: DiffStatsPoller;
  chatStreamHub: ChatStreamHub;
  // Provider backends for this turn. In tests both point at the same fake.
  claudeBackend: ChatBackend;
  codexBackend: ChatBackend;
  // The profile-scoped, 20s-cached upstream usage snapshot. Injected (rather
  // than fetched here) so the per-turn `usage` enrichment reuses the same
  // cached numbers /api/usage and the chat list see.
  profileUsageStats: (profileId: string) => Promise<UsageStats>;
}

// Owns the orchestration of a single assistant turn: user-message persistence,
// auto-titling, environment prelude injection, the backend send loop, usage
// persistence + subscription-share enrichment, and abort semantics. The HTTP
// layer (chats router) handles request validation and the SSE pump. Everything
// between "we've decided to run a turn" and "the turn settled" lives here.
export class ChatTurnService {
  constructor(private readonly deps: ChatTurnDeps) {}

  // Persist the user message and kick off the assistant turn on the stream hub.
  // Returns the reserved assistant messageId so the caller can pump the SSE
  // response for it. The producer runs asynchronously on the hub, and this returns
  // as soon as the turn is registered.
  start(opts: { instance: InstanceRecord; chat: Chat; content: string }): string {
    const {
      chatManager,
      instances,
      profiles,
      titleVmManager,
      diffStatsPoller,
      chatStreamHub,
      claudeBackend,
      codexBackend,
      profileUsageStats,
    } = this.deps;
    const { instance, chat, content } = opts;
    const instanceId = instance.id;
    const chatId = chat.id;

    chatManager.addMessage(chatId, "user", content);
    instances.touch(instanceId);

    // Reserve the assistant message id up front so every chat_events
    // row can link to it (even though the chat_messages row only gets
    // inserted on producer success). The client receives this as the
    // first SSE event and uses it both as the React key for the
    // streaming bubble and as the lookup key for replayed events on a
    // future reload or reconnect.
    const assistantMessageId = randomUUID();
    // Kick off auto-titling on the first user message of an untitled
    // chat. Runs in parallel with the assistant response. The SSE
    // stream emits a `title` event when it completes so the sidebar
    // can update in place. The title is minted by the chat's own provider
    // CLI inside a VM (see the backends' generateTitle). If that fails we
    // fall back to a truncation of the first message below.
    const needsTitle = instance.title === null;

    chatStreamHub.startTurn({
      chatId,
      messageId: assistantMessageId,
      run: async (api) => {
        // One backend for this turn, picked by the chat's own provider, used
        // for both the title and the actual response. Titling through the
        // chat's provider (not always Claude) means a Codex-only profile still
        // gets a real title instead of always truncating.
        const backend = chat.provider === "anthropic" ? claudeBackend : codexBackend;

        let titlePromise: Promise<void> | null = null;
        if (needsTitle) {
          // Mint the title in the profile's always-warm titling VM when one is
          // ready, so it's not gated on this instance's own (often still
          // cold-booting) VM, and falls back to the instance VM otherwise.
          const titleVmId =
            (instance.profileId && titleVmManager.getReadyVmId(instance.profileId)) ||
            instance.vmId;
          // Sidebar gates entry visibility on `title !== null`, so the chat
          // appears once the title lands. Fall back to a truncation of the
          // first message only if the model call fails, so the chat still
          // eventually appears.
          titlePromise = backend
            .generateTitle(titleVmId, content)
            .catch(() => null)
            .then((generated) => {
              const fallback = content.replace(/\s+/g, " ").trim().slice(0, 60) || "Untitled";
              return generated && generated.length > 0 ? generated : fallback;
            })
            .then((title) => {
              instances.setTitle(instanceId, title);
              api.publish("title", title);
            })
            .catch(() => {});
        }

        let assistantContent = "";
        try {
          const sessionId =
            chat.provider === "anthropic"
              ? (chat.claudeSessionId ?? undefined)
              : (chat.codexThreadId ?? undefined);
          // Environment-level prelude: prepended to the first user
          // message of a new chat (no provider session yet) and sent
          // to the backend only. The DB still holds the user's
          // original `content`, so the prelude is invisible in the
          // UI's message list. Wrapped in <prelude> tags so the model
          // can tell it apart from the user's own text.
          const prelude =
            sessionId || !instance.profileId ? null : profiles.getPrelude(instance.profileId);
          const outgoingMessage = prelude
            ? `<prelude>\n${prelude}\n</prelude>\n\n${content}`
            : content;
          const result = await backend.sendMessage({
            vmId: instance.vmId,
            chatId,
            message: outgoingMessage,
            model: chat.model,
            effort: chat.effort,
            sessionId,
            signal: api.signal,
            onDelta: (text) => {
              assistantContent += text;
              api.publish("delta", text);
            },
            onEvent: async (event) => {
              // Persist the full usage snapshot onto the chat row so
              // the next mount of the chat UI can rehydrate UsageState
              // without waiting for a new turn.
              if (event.type === "usage") {
                chatManager.updateUsage(chatId, {
                  total: event.total,
                  last: event.last,
                  modelContextWindow: event.modelContextWindow,
                  costUsd: event.costUsd,
                });
                if (instance.profileId) {
                  event.subscriptionShare = await computeSubscriptionShare({
                    provider: chat.provider,
                    modelId: chat.model,
                    total: event.total,
                    stats: await profileUsageStats(instance.profileId),
                    authStore: profiles.auth(instance.profileId),
                  });
                }
              } else if (event.type === "tool_call_result") {
                // A finished tool call is the moment the VM's filesystem
                // may have changed, so refresh the sidebar diff stats.
                diffStatsPoller.nudge(instanceId);
              } else if (event.type === "context_compacted") {
                chatManager.markCompacted(chatId);
              }
              api.publish(event.type, event);
            },
          });
          assistantContent = result.content || assistantContent;
          chatManager.addMessageWithId(chatId, assistantMessageId, "assistant", assistantContent);
          // Turn finished: float the instance up and flag it unread. The client
          // clears the flag immediately if the user is viewing this instance, so
          // it only sticks for turns that complete in the background.
          instances.markActivity(instanceId);
          // Catch the turn's final filesystem state even when the last
          // tool result's debounced probe raced an in-flight one.
          diffStatsPoller.nudge(instanceId);
          if (titlePromise) await titlePromise.catch(() => {});
        } catch (err) {
          // Cancellation (Stop button, idle grace, chat-delete) lands
          // here as an aborted signal. We persist whatever assistant
          // text we already streamed so the transcript shows the
          // partial turn instead of dropping it, then re-throw so the
          // hub emits the standard `error` signal (clients render it
          // as "cancelled").
          if (api.signal.aborted) {
            if (assistantContent.length > 0) {
              try {
                chatManager.addMessageWithId(
                  chatId,
                  assistantMessageId,
                  "assistant",
                  assistantContent,
                );
              } catch (e) {
                console.warn("[chat] failed to persist aborted assistant message", e);
              }
            }
            instances.touch(instanceId);
            if (titlePromise) await titlePromise.catch(() => {});
          }
          throw err;
        }
      },
    });

    return assistantMessageId;
  }
}
