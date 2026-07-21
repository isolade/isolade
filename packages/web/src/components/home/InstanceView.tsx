import { Bot, Plus, X } from "lucide-react";
import { memo, useCallback, useLayoutEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { createChat, deleteChat } from "../../lib/api";
import type { ChatModelDefinition, Chat as ChatT, ModelOverrides } from "../../lib/contracts";
import { findChatModel, splitModelsByTier } from "../../lib/contracts";
import Chat from "../Chat";

interface InstanceViewProps {
  instanceId: string;
  chats: ChatT[];
  chatModels: ChatModelDefinition[];
  modelOverrides: ModelOverrides;
  visible: boolean;
  // First message to auto-send when this chat was just created. Keyed by
  // chatId so we only fire it for the right chat tab.
  pendingFirstMessage: { chatId: string; content: string; uploadIds?: string[] } | null;
  // True while the backing VM/chat resources haven't landed yet. The chat tab
  // still mounts (showing the optimistic user message + dots) but defers any
  // server I/O until the real ids are swapped in.
  pending: boolean;
  creationError: string | null;
  onTitleAutoUpdated: (instanceId: string, title: string) => void;
  onResourceChange: (instanceId: string) => void;
}

function chatLabel(chatId: string, chats: ChatT[], chatModels: ChatModelDefinition[]): string {
  const chat = chats.find((c) => c.id === chatId);
  const model = chat
    ? (findChatModel(chat.model) ?? chatModels.find((m) => m.id === chat.model))
    : null;
  return model?.name ?? "Chat";
}

function InstanceView({
  instanceId,
  chats,
  chatModels,
  modelOverrides,
  visible,
  pendingFirstMessage,
  pending,
  creationError,
  onTitleAutoUpdated,
  onResourceChange,
}: InstanceViewProps) {
  // Open chat tabs, by chat id. The shell terminal now lives in the side panel,
  // so tabs are chats and nothing else.
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [showLegacyChatModels, setShowLegacyChatModels] = useState(false);

  // When the instance changes, recompute openTabs from the chat list: every
  // chat becomes a tab.
  //
  // useLayoutEffect (not useEffect) so the sync happens before paint. When the
  // synthetic chat id is swapped for the real one on VM-ready, openTabs lands
  // in the same commit as the new chat prop, avoiding an empty-tab frame.
  useLayoutEffect(() => {
    const next = chats.map((c) => c.id);
    setOpenTabs((prev) => {
      // Preserve the order of pre-existing tabs.
      next.sort((a, b) => {
        const ai = prev.indexOf(a);
        const bi = prev.indexOf(b);
        if (ai === -1 && bi === -1) return 0;
        if (ai === -1) return 1;
        if (bi === -1) return -1;
        return ai - bi;
      });
      if (next.length === prev.length && next.every((id, index) => id === prev[index])) return prev;
      return next;
    });
    // If we just created the instance, focus the chat the first message will
    // land on. Otherwise keep the active tab if it still exists, or else activate
    // the first tab.
    setActiveKey((prev) => {
      if (pendingFirstMessage) return pendingFirstMessage.chatId;
      if (prev && next.includes(prev)) return prev;
      return next[0] ?? null;
    });
    // We intentionally re-run when chat ids change, not just their count.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId, chats.map((c) => c.id).join(",")]);

  const handleAddChat = async (modelId: string) => {
    const chat = await createChat(instanceId, { model: modelId });
    onResourceChange(instanceId);
    setOpenTabs((prev) => [...prev, chat.id]);
    setActiveKey(chat.id);
  };

  const handleCloseTab = async (chatId: string) => {
    const idx = openTabs.indexOf(chatId);
    const newTabs = openTabs.filter((t) => t !== chatId);
    setOpenTabs(newTabs);
    if (activeKey === chatId) {
      const fallback = newTabs[idx] ?? newTabs[idx - 1] ?? newTabs[0] ?? null;
      setActiveKey(fallback);
    }
    await deleteChat(instanceId, chatId).catch(() => {});
    onResourceChange(instanceId);
  };

  // Stable per-instance callback so the memoized Chat tabs don't all re-render
  // on every InstanceView render (e.g. a tab click flipping activeKey). An
  // inline `(t) => onTitleAutoUpdated(instanceId, t)` would be a fresh
  // identity each render and defeat the memo.
  const handleTitle = useCallback(
    (title: string) => onTitleAutoUpdated(instanceId, title),
    [onTitleAutoUpdated, instanceId],
  );

  const showStrip = openTabs.length > 1;
  const { frontier: frontierChatModels, more: legacyChatModels } = splitModelsByTier(
    chatModels,
    modelOverrides,
  );

  // The "+" menu is now just the model picker, so a new tab is always a chat.
  const addMenuItems = (
    <>
      {frontierChatModels.map((m) => (
        <DropdownMenuItem key={m.id} onClick={() => void handleAddChat(m.id)}>
          <Bot className="size-3.5" />
          {m.name}
        </DropdownMenuItem>
      ))}
      {legacyChatModels.length > 0 &&
        (showLegacyChatModels ? (
          legacyChatModels.map((m) => (
            <DropdownMenuItem key={m.id} onClick={() => void handleAddChat(m.id)}>
              <Bot className="size-3.5" />
              {m.name}
            </DropdownMenuItem>
          ))
        ) : (
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              setShowLegacyChatModels(true);
            }}
            className="text-muted-foreground"
          >
            More…
          </DropdownMenuItem>
        ))}
    </>
  );

  return (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col bg-background">
      {showStrip && (
        <div className="flex items-center pl-2 pt-1 pr-2 gap-1 border-b border-border bg-background flex-shrink-0 overflow-x-auto">
          {openTabs.map((chatId) => {
            const isActive = activeKey === chatId;
            return (
              <div
                key={chatId}
                role="tab"
                aria-selected={isActive}
                tabIndex={isActive ? 0 : -1}
                className={cn(
                  "group/tab flex items-center gap-1.5 px-2.5 h-7 rounded-t border-t border-l border-r text-xs cursor-pointer select-none",
                  isActive
                    ? "border-border bg-background text-foreground -mb-px"
                    : "border-transparent bg-muted/30 text-muted-foreground hover:text-foreground",
                )}
                onClick={() => setActiveKey(chatId)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setActiveKey(chatId);
                  }
                }}
              >
                <Bot className="size-3.5" />
                <span className="truncate max-w-[160px]">
                  {chatLabel(chatId, chats, chatModels)}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-4 opacity-0 group-hover/tab:opacity-100 data-[active=true]:opacity-100 -mr-1"
                  data-active={isActive}
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleCloseTab(chatId);
                  }}
                  aria-label="Close tab"
                >
                  <X className="size-3" />
                </Button>
              </div>
            );
          })}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="size-7 ml-1" aria-label="New tab">
                <Plus className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">{addMenuItems}</DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}

      <div className="flex-1 min-h-0 relative">
        {!showStrip && (
          <div className="absolute top-1.5 right-1.5 z-20 flex items-center gap-1">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="New tab"
                  title="New tab"
                  className="size-7 opacity-40 hover:opacity-100 transition-opacity"
                >
                  <Plus className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">{addMenuItems}</DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}

        {openTabs.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
            No tabs open. Use + to add one
          </div>
        )}

        {chats.map((chat) => {
          const inOpen = openTabs.includes(chat.id);
          if (!inOpen) return null;
          const isActive = activeKey === chat.id;
          const isPendingChat = pendingFirstMessage && pendingFirstMessage.chatId === chat.id;
          const initialMessage = isPendingChat ? pendingFirstMessage.content : undefined;
          const initialUploadIds = isPendingChat ? pendingFirstMessage.uploadIds : undefined;
          return (
            <div
              key={chat.id}
              className="absolute inset-0"
              aria-hidden={!isActive}
              inert={!isActive}
              style={{
                contain: "strict",
                opacity: isActive ? 1 : 0,
                pointerEvents: isActive ? "auto" : "none",
              }}
            >
              <Chat
                instanceId={instanceId}
                chatId={chat.id}
                model={chat.model}
                effort={chat.effort}
                chat={chat}
                chatModels={chatModels}
                modelOverrides={modelOverrides}
                visible={visible && isActive}
                initialMessage={initialMessage}
                initialUploadIds={initialUploadIds}
                pending={pending}
                creationError={creationError}
                onTitle={handleTitle}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function instanceViewPropsEqual(previous: InstanceViewProps, next: InstanceViewProps): boolean {
  return (
    previous.instanceId === next.instanceId &&
    previous.visible === next.visible &&
    previous.chatModels === next.chatModels &&
    previous.modelOverrides === next.modelOverrides &&
    previous.pendingFirstMessage === next.pendingFirstMessage &&
    previous.pending === next.pending &&
    previous.creationError === next.creationError &&
    previous.onTitleAutoUpdated === next.onTitleAutoUpdated &&
    previous.onResourceChange === next.onResourceChange &&
    previous.chats.length === next.chats.length &&
    previous.chats.every((chat, index) => chat === next.chats[index])
  );
}

export default memo(InstanceView, instanceViewPropsEqual);
