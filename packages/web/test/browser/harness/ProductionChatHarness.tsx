import { memo, useEffect, useMemo, useState } from "react";
import { flushSync } from "react-dom";
import Chat from "@/components/Chat";
import RetainedInstanceViews from "@/components/home/RetainedInstanceViews";
import type { ChatModelDefinition, Chat as ChatRow, Instance } from "@/lib/contracts";
import { findChatModel } from "@/lib/contracts";
import { getRenderMetrics, type MetricSnapshot } from "./metrics";

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const emptyModelOverrides = {};
const noop = () => {};

interface ProductionChatPaneProps {
  chat: ChatRow;
  chatModels: ChatModelDefinition[];
  visible: boolean;
}

const ProductionChatPane = memo(function ProductionChatPane({
  chat,
  chatModels,
  visible,
}: ProductionChatPaneProps) {
  return (
    <section
      data-production-chat={chat.id}
      data-active={visible ? "true" : "false"}
      aria-hidden={!visible}
      inert={!visible}
      className="absolute inset-0 flex h-full min-h-0"
      style={{
        contain: "strict",
        opacity: visible ? 1 : 0,
        pointerEvents: visible ? "auto" : "none",
      }}
    >
      <Chat
        instanceId={chat.instanceId}
        chatId={chat.id}
        model={chat.model}
        effort={chat.effort}
        chat={chat}
        chatModels={chatModels}
        modelOverrides={emptyModelOverrides}
        visible={visible}
      />
    </section>
  );
});

export interface ProductionHarnessApi {
  metrics: () => MetricSnapshot;
  resetMetrics: () => Promise<void>;
  switchChat: (chatId: string) => Promise<void>;
  switchChatImmediately: (chatId: string) => {
    distanceFromBottom: number;
    scrollTop: number;
  };
  unmountRetained: () => Promise<void>;
  waitFrames: (count?: number) => Promise<void>;
}

export function ProductionChatHarness() {
  const parameters = useMemo(() => new URLSearchParams(window.location.search), []);
  const chatCount = Number(parameters.get("chats") ?? 2);
  const retainInstances = parameters.get("instancePanes") === "1";
  const crossProviderPicker = parameters.get("crossProviderPicker") === "1";
  const chatsPerInstance = Math.max(1, Number(parameters.get("chatsPerInstance") ?? 1));
  const chats = useMemo<ChatRow[]>(
    () =>
      Array.from({ length: chatCount }, (_, index) => {
        const id = `chat-${String.fromCharCode(97 + index)}`;
        return {
          id,
          instanceId: retainInstances
            ? `instance-${String.fromCharCode(97 + Math.floor(index / chatsPerInstance))}`
            : "instance-production-harness",
          model: crossProviderPicker ? "gpt-5.6-sol" : "claude-sonnet-5",
          provider: crossProviderPicker ? "openai" : "anthropic",
          effort: crossProviderPicker ? "ultra" : "high",
          claudeSessionId: null,
          codexThreadId: null,
          inputTokens: null,
          cachedInputTokens: null,
          cacheCreationInputTokens: null,
          outputTokens: null,
          reasoningOutputTokens: null,
          costUsd: null,
          lastInputTokens: null,
          lastCachedInputTokens: null,
          lastCacheCreationInputTokens: null,
          lastOutputTokens: null,
          lastReasoningOutputTokens: null,
          modelContextWindow: null,
          compacted: null,
          activeLeafId: null,
          createdAt: new Date(index * 1_000),
        };
      }),
    [chatCount, chatsPerInstance, crossProviderPicker, retainInstances],
  );
  const instances = useMemo<Instance[]>(
    () =>
      retainInstances
        ? [...new Set(chats.map((chat) => chat.instanceId))].map(
            (instanceId, index) =>
              ({
                id: instanceId,
                vmId: `vm-${index}`,
                title: instanceId,
                status: "running",
                lastError: null,
                image: "test",
                profileId: "test",
                diffAdded: null,
                diffDeleted: null,
                working: false,
                unread: false,
                archived: false,
                pinned: false,
                createdAt: new Date(index * 1_000),
                updatedAt: new Date(index * 1_000),
              }) satisfies Instance,
          )
        : [],
    [chats, retainInstances],
  );
  const chatsByInstance = useMemo(() => {
    const grouped = new Map<string, ChatRow[]>();
    for (const chat of chats) {
      const rows = grouped.get(chat.instanceId) ?? [];
      rows.push(chat);
      grouped.set(chat.instanceId, rows);
    }
    return grouped;
  }, [chats]);
  const chatModels = useMemo(() => {
    const ids = crossProviderPicker ? ["claude-opus-4-8", "gpt-5.6-sol"] : ["claude-sonnet-5"];
    return ids.flatMap((id) => {
      const model = findChatModel(id);
      return model ? [model] : [];
    });
  }, [crossProviderPicker]);
  const [activeChat, setActiveChat] = useState(chats[0]!.id);
  const [retainedMounted, setRetainedMounted] = useState(true);

  useEffect(() => {
    const api: ProductionHarnessApi = {
      metrics: () => getRenderMetrics().snapshot(),
      async resetMetrics() {
        await frame();
        await frame();
        getRenderMetrics().reset();
      },
      async switchChat(chatId) {
        setActiveChat(chatId);
        await frame();
        await frame();
      },
      switchChatImmediately(chatId) {
        flushSync(() => setActiveChat(chatId));
        const chat = chats.find((candidate) => candidate.id === chatId);
        if (!chat) throw new Error(`Missing chat ${chatId}`);
        const paneSelector = retainInstances
          ? `[data-retained-instance="${CSS.escape(chat.instanceId)}"]`
          : `[data-production-chat="${CSS.escape(chatId)}"]`;
        const scrollElement = document.querySelector<HTMLElement>(
          `${paneSelector} [data-chat-scroll]`,
        );
        if (!scrollElement) throw new Error(`Missing scroll element for ${chatId}`);
        return {
          distanceFromBottom:
            scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight,
          scrollTop: scrollElement.scrollTop,
        };
      },
      async unmountRetained() {
        setRetainedMounted(false);
        await frame();
        await frame();
      },
      async waitFrames(frameCount = 2) {
        for (let index = 0; index < frameCount; index++) await frame();
      },
    };
    window.__isoladeProductionChatHarness = api;
    document.documentElement.dataset.productionHarnessReady = "true";
    return () => {
      delete window.__isoladeProductionChatHarness;
      delete document.documentElement.dataset.productionHarnessReady;
    };
  }, [chats, retainInstances]);

  return (
    <main className="flex h-screen flex-col overflow-hidden bg-muted/40 text-foreground">
      <nav className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-background px-3">
        {chats.map((chat) => (
          <button
            key={chat.id}
            type="button"
            data-production-chat-button={chat.id}
            aria-pressed={activeChat === chat.id}
            onClick={() => setActiveChat(chat.id)}
            className="rounded border border-border px-3 py-1 text-xs"
          >
            {chat.id}
          </button>
        ))}
      </nav>
      <div data-production-stage className="relative min-h-0 flex-1 overflow-hidden">
        {retainInstances && retainedMounted ? (
          <RetainedInstanceViews
            instances={instances}
            chatsByInstance={chatsByInstance}
            activeInstanceId={chats.find((chat) => chat.id === activeChat)?.instanceId ?? null}
            pendingFirstMessage={null}
            chatModels={chatModels}
            modelOverrides={emptyModelOverrides}
            onTitleAutoUpdated={noop}
            onResourceChange={noop}
          />
        ) : !retainInstances ? (
          chats.map((chat) => (
            <ProductionChatPane
              key={chat.id}
              chat={chat}
              chatModels={chatModels}
              visible={activeChat === chat.id}
            />
          ))
        ) : null}
      </div>
    </main>
  );
}

declare global {
  interface Window {
    __isoladeProductionChatHarness?: ProductionHarnessApi;
  }
}
