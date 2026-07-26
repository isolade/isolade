import type { ChatManager } from "../chats";
import type { QueuedMessage } from "../db/schema";
import type { InstanceManager } from "../instances";
import { type UploadStore, uploadGuestPath } from "../uploads";
import type { ChatBackend, UploadAttachment, UserMessageReceipt } from "./backend";
import { buildAttachmentsPreamble, type ChatTurnService } from "./chat-turn-service";
import type { ChatStreamHub } from "./stream-hub";

export class ChatQueueService {
  private readonly dispatching = new Set<string>();
  private readonly dispatchSuspensions = new Map<string, number>();

  constructor(
    private readonly deps: {
      chatManager: ChatManager;
      uploadStore: UploadStore;
      instances: InstanceManager;
      chatStreamHub: ChatStreamHub;
      chatTurnService: ChatTurnService;
      claudeBackend: ChatBackend;
      codexBackend: ChatBackend;
    },
  ) {
    deps.chatStreamHub.onSettled(({ chatId }) => {
      queueMicrotask(() => void this.dispatchNext(chatId));
    });
    queueMicrotask(() => {
      for (const chat of deps.chatManager.listAll()) {
        void this.dispatchNext(chat.id);
      }
    });
  }

  enqueue(opts: {
    instanceId: string;
    chatId: string;
    id: string;
    content: string;
    uploadIds?: string[];
  }): QueuedMessage {
    const message = this.deps.chatManager.enqueueMessage(opts);
    this.deps.uploadStore.attach(opts.instanceId, opts.chatId, opts.id, opts.uploadIds ?? []);
    return message;
  }

  async dispatchNext(chatId: string): Promise<string | null> {
    if (this.dispatchSuspensions.has(chatId)) return null;
    if (this.dispatching.has(chatId)) return null;
    if (
      this.deps.chatManager.inFlightMessageId(chatId) ||
      this.deps.chatStreamHub.inFlightFor(chatId)
    ) {
      return null;
    }
    const queued = this.deps.chatManager.nextQueuedMessage(chatId);
    if (!queued) return null;
    const chat = this.deps.chatManager.get(chatId);
    if (!chat) return null;
    const instance = this.deps.instances.get(chat.instanceId);
    if (!instance || instance.archived || instance.status === "error") return null;

    this.dispatching.add(chatId);
    try {
      const uploadIds = this.deps.uploadStore.listForMessage(queued.id).map((upload) => upload.id);
      const { assistantMessageId } = this.deps.chatTurnService.start({
        instance,
        chat,
        content: queued.content,
        uploadIds,
        userMessageId: queued.id,
      });
      return assistantMessageId;
    } catch (error) {
      this.deps.chatManager.updateQueuedMessage(queued.id, {
        status: "unknown",
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    } finally {
      this.dispatching.delete(chatId);
    }
  }

  // Branch changes cancel and settle the active turn before rewinding the
  // provider conversation. Suppress the settlement listener's automatic
  // queue promotion during that window so a queued message cannot become a
  // competing turn between cancellation and the replacement.
  suspendDispatch(chatId: string): () => void {
    this.dispatchSuspensions.set(chatId, (this.dispatchSuspensions.get(chatId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.dispatchSuspensions.get(chatId) ?? 1) - 1;
      if (remaining > 0) {
        this.dispatchSuspensions.set(chatId, remaining);
        return;
      }
      this.dispatchSuspensions.delete(chatId);
      queueMicrotask(() => void this.dispatchNext(chatId));
    };
  }

  async activate(
    instanceId: string,
    chatId: string,
    messageId: string,
    mode: "next" | "now",
  ): Promise<QueuedMessage | undefined> {
    const queued = this.deps.chatManager.getQueuedMessage(messageId);
    if (!queued || queued.chatId !== chatId) return undefined;
    if (queued.status !== "queued" && queued.status !== "unknown" && queued.status !== "rejected") {
      return queued;
    }
    const chat = this.deps.chatManager.get(chatId);
    const instance = this.deps.instances.get(instanceId);
    if (!chat || chat.instanceId !== instanceId || !instance) return undefined;
    const activeMessageId =
      this.deps.chatStreamHub.inFlightFor(chatId) ??
      this.deps.chatManager.inFlightMessageId(chatId);

    // If the turn won the race and already ended, either action becomes the
    // next ordinary turn.
    if (!activeMessageId) {
      this.deps.chatManager.updateQueuedMessage(messageId, {
        mode: "later",
        status: "queued",
        targetMessageId: null,
        error: null,
      });
      await this.dispatchNext(chatId);
      return this.deps.chatManager.getQueuedMessage(messageId);
    }

    // Codex has no atomic "now" operation. Persist the intent, interrupt only
    // this chat's turn, then let the settlement listener promote this exact
    // message into a fresh turn.
    if (mode === "now" && chat.provider === "openai") {
      const updated = this.deps.chatManager.updateQueuedMessage(messageId, {
        mode,
        status: "interrupting",
        targetMessageId: activeMessageId,
        error: null,
      });
      const interruption = this.deps.chatStreamHub.publishToTurn(
        chatId,
        activeMessageId,
        "turn_interrupted",
        { id: queued.id },
      );
      if (interruption === null || !this.deps.chatStreamHub.cancel(activeMessageId)) {
        this.deps.chatManager.updateQueuedMessage(messageId, {
          mode: "later",
          status: "queued",
          targetMessageId: null,
        });
        await this.dispatchNext(chatId);
      }
      return updated;
    }

    const backend =
      chat.provider === "anthropic" ? this.deps.claudeBackend : this.deps.codexBackend;
    if (!backend.steer) {
      return this.deps.chatManager.updateQueuedMessage(messageId, {
        mode,
        status: "rejected",
        error: "the active backend does not support steering",
      });
    }
    this.deps.chatManager.updateQueuedMessage(messageId, {
      mode,
      status: "steering",
      targetMessageId: activeMessageId,
      error: null,
    });
    try {
      const confirmSteeredMessage = (receipt?: UserMessageReceipt) => {
        const current = this.deps.chatManager.getQueuedMessage(messageId);
        if (!current || current.status === "delivered") return;
        const editable =
          chat.provider === "anthropic" &&
          typeof receipt?.sessionId === "string" &&
          typeof receipt.priorAnchorId === "string";
        if (mode === "now") {
          const interrupted = this.deps.chatStreamHub.publishToTurn(
            chatId,
            activeMessageId,
            "turn_interrupted",
            { id: queued.id },
          );
          if (interrupted === null) {
            throw new Error("the active turn ended before the interruption was displayed");
          }
        }
        const published = this.deps.chatStreamHub.publishToTurn(
          chatId,
          activeMessageId,
          "steered_user_message",
          {
            id: queued.id,
            content: queued.content,
            uploads: this.deps.uploadStore.listForMessage(queued.id),
            deliveryStatus: "confirmed",
            ...(editable ? { capabilities: { edit: true } } : {}),
          },
        );
        if (published === null) {
          throw new Error("the active turn ended before the steering message was displayed");
        }
        this.deps.chatManager.updateQueuedMessage(messageId, {
          status: "delivered",
          ...(editable
            ? {
                editSessionId: receipt.sessionId,
                editAnchorId: receipt.priorAnchorId,
              }
            : {}),
          error: null,
        });
      };
      if (queued.status === "unknown" && chat.provider === "openai" && backend.hasUserMessage) {
        const delivered = await backend.hasUserMessage({
          vmId: instance.vmId,
          chatId,
          sessionId: chat.codexThreadId ?? undefined,
          userMessageId: queued.id,
        });
        if (delivered) {
          confirmSteeredMessage();
          return this.deps.chatManager.getQueuedMessage(messageId);
        }
      }
      const outgoing = this.outgoingMessage(queued);
      await backend.steer({
        vmId: instance.vmId,
        chatId,
        message: outgoing,
        userMessageId: queued.id,
        priority: mode,
        onUserMessageAcknowledged: confirmSteeredMessage,
      });
      return this.deps.chatManager.getQueuedMessage(messageId);
    } catch (error) {
      return this.deps.chatManager.updateQueuedMessage(messageId, {
        status: "unknown",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async remove(
    instanceId: string,
    chatId: string,
    messageId: string,
  ): Promise<{
    removed: boolean;
    reason?: "already_delivered" | "not_retractable";
  }> {
    const queued = this.deps.chatManager.getQueuedMessage(messageId);
    if (!queued || queued.chatId !== chatId) {
      throw new Error("queued message not found");
    }
    const chat = this.deps.chatManager.get(chatId);
    const instance = this.deps.instances.get(instanceId);
    if (!chat || chat.instanceId !== instanceId || !instance) {
      throw new Error("chat not found");
    }

    const providerOwned =
      queued.mode === "next" &&
      (queued.status === "steering" ||
        queued.status === "unknown" ||
        queued.status === "delivered");
    if (providerOwned) {
      if (chat.provider !== "anthropic" || !this.deps.claudeBackend.cancelSteer) {
        return { removed: false, reason: "not_retractable" };
      }
      const cancelled = await this.deps.claudeBackend.cancelSteer({
        vmId: instance.vmId,
        chatId,
        userMessageId: queued.id,
      });
      if (!cancelled) {
        this.deps.chatManager.updateQueuedMessage(queued.id, {
          status: "delivered",
          error: null,
        });
        return { removed: false, reason: "already_delivered" };
      }
      this.deps.chatManager.removeQueuedMessage(queued.id, true);
      this.deps.uploadStore.releaseQueuedMessage(chatId, queued.id);
      return { removed: true };
    }

    if (queued.status === "interrupting") {
      return { removed: false, reason: "not_retractable" };
    }
    this.deps.chatManager.removeQueuedMessage(queued.id);
    this.deps.uploadStore.releaseQueuedMessage(chatId, queued.id);
    return { removed: true };
  }

  private outgoingMessage(message: QueuedMessage): string {
    const uploads: UploadAttachment[] = this.deps.uploadStore
      .listForMessage(message.id)
      .map((upload) => ({
        ...upload,
        guestPath: uploadGuestPath(upload.id, upload.filename),
      }));
    return [
      ...(uploads.length > 0 ? [buildAttachmentsPreamble(uploads)] : []),
      ...(message.content.length > 0 ? [message.content] : []),
    ].join("\n\n");
  }
}
