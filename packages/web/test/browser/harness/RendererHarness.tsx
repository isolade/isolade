import {
  forwardRef,
  memo,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { SessionMessageRow } from "@/components/chat/MessageHistory";
import PanelWorkspace, { DragLayer } from "@/components/home/PanelWorkspace";
import WindowChrome from "@/components/home/WindowChrome";
import type { Instance } from "@/lib/contracts";
import { type HarnessPage, makeOlderPage, makePages } from "./fixtures";
import { getRenderMetrics, type MetricSnapshot } from "./metrics";
import {
  type HarnessLiveRow,
  type MessageHistoryHandle,
  RendererAdapter,
} from "./renderer-adapter";

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

interface ChatPaneHandle {
  appendLive: (text: string) => void;
  assignMessageId: (messageId: string) => void;
  commitLive: () => void;
  prepend: (count: number) => void;
  startLive: () => void;
}

interface ChatPaneProps {
  chatId: string;
  count: number;
  visible: boolean;
}

const ChatPane = memo(
  forwardRef<ChatPaneHandle, ChatPaneProps>(function ChatPane({ chatId, count, visible }, ref) {
    const [pages, setPages] = useState<HarnessPage[]>(() => makePages(chatId, count));
    const [sessionRows, setSessionRows] = useState<SessionMessageRow[]>([]);
    const [live, setLive] = useState<HarnessLiveRow | null>(null);
    const olderOrdinalRef = useRef(0);
    const scrollElementRef = useRef<HTMLDivElement>(null);
    const historyRef = useRef<MessageHistoryHandle>(null);
    const contentRef = useRef<HTMLDivElement>(null);

    useLayoutEffect(() => {
      const element = scrollElementRef.current;
      if (element && element.scrollTop === 0) element.scrollTop = element.scrollHeight;
    }, [visible]);

    useEffect(() => {
      const content = contentRef.current;
      if (!content) return;
      const metrics = getRenderMetrics();
      const resizeObserver = new ResizeObserver(() => {
        metrics.increment("contentResizeNotifications");
      });
      const mutationObserver = new MutationObserver((entries) => {
        metrics.increment("domMutations", entries.length);
      });
      resizeObserver.observe(content);
      mutationObserver.observe(content, { attributes: true, childList: true, subtree: true });
      return () => {
        resizeObserver.disconnect();
        mutationObserver.disconnect();
      };
    }, []);

    useImperativeHandle(ref, () => ({
      appendLive(text) {
        setLive((current) => {
          if (!current) return current;
          const last = current.chunks.at(-1);
          const chunks = [...current.chunks];
          if (last?.kind === "text") {
            chunks[chunks.length - 1] = { kind: "text", text: last.text + text };
          } else {
            chunks.push({ kind: "text", text });
          }
          return {
            ...current,
            message: { ...current.message, content: current.message.content + text },
            chunks,
          };
        });
      },
      assignMessageId(messageId) {
        if (!live) return;
        setLive({ ...live, message: { ...live.message, id: messageId } });
      },
      commitLive() {
        if (!live) return;
        setSessionRows((rows) => [
          ...rows,
          { renderKey: live.renderKey, message: live.message, chunks: live.chunks },
        ]);
        setLive(null);
      },
      prepend(pageCount) {
        historyRef.current?.capturePrependAnchor?.();
        getRenderMetrics().increment("apiRequests");
        const ordinal = olderOrdinalRef.current++;
        setPages((current) => [makeOlderPage(chatId, ordinal, pageCount), ...current]);
      },
      startLive() {
        const renderKey = `${chatId}-turn-render-key`;
        const id = `${chatId}-live-client`;
        setLive({
          renderKey,
          message: {
            id,
            chatId,
            role: "assistant",
            content: "",
            parentId: sessionRows.at(-1)?.message.id ?? pages.at(-1)?.messages.at(-1)?.id ?? null,
            createdAt: new Date(),
            version: null,
          },
          chunks: [],
          streaming: true,
        });
      },
    }));

    return (
      <section
        data-active={visible ? "true" : "false"}
        data-chat-id={chatId}
        aria-hidden={!visible}
        inert={!visible}
        className="absolute inset-0 h-full min-h-0"
        style={{
          contain: "strict",
          opacity: visible ? 1 : 0,
          pointerEvents: visible ? "auto" : "none",
        }}
      >
        <div
          ref={scrollElementRef}
          data-scroll-chat={chatId}
          className="h-full overflow-y-auto bg-background px-4 py-8"
        >
          <div ref={contentRef} data-history-content={chatId} className="mx-auto w-full max-w-3xl">
            <RendererAdapter
              pages={pages}
              sessionRows={sessionRows}
              live={live}
              historyRef={historyRef}
              scrollElementRef={scrollElementRef}
              visible={visible}
            />
          </div>
        </div>
      </section>
    );
  }),
);

export interface HarnessApi {
  animateWidth: (from: number, to: number, steps?: number) => Promise<void>;
  appendLive: (text: string) => void;
  assignMessageId: (messageId: string) => void;
  commitLive: () => void;
  metrics: () => MetricSnapshot;
  prepend: (count: number) => void;
  resetMetrics: () => Promise<void>;
  startLive: () => void;
  switchChat: (chatId: string) => Promise<void>;
  waitFrames: (count?: number) => Promise<void>;
}

const PANEL_GESTURE_INSTANCE: Instance = {
  id: "panel-gesture-instance",
  vmId: "panel-gesture-vm",
  title: "Panel gesture test",
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
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

function PanelGestureHarness() {
  const parameters = new URLSearchParams(window.location.search);
  const withChromeInset = parameters.get("chromeInset") === "1";
  const sidebarExpanded = parameters.get("sidebarExpanded") === "1";
  const [chromeWidth, setChromeWidth] = useState(0);
  return (
    <main className="relative h-screen bg-background text-foreground">
      <p data-selection-target className="absolute top-2 left-2">
        Text outside the panel must not become selected during a tab drag.
      </p>
      <div
        className="absolute flex"
        style={{
          left: withChromeInset ? 0 : 100,
          top: withChromeInset ? 0 : 80,
          width: 500,
          height: 400,
          contain: "strict",
        }}
      >
        <PanelWorkspace
          instance={PANEL_GESTURE_INSTANCE}
          chats={[]}
          terminals={[]}
          ports={[]}
          prs={[]}
          onDetachPr={() => {}}
          chatModels={[]}
          modelOverrides={{}}
          pendingFirstMessage={null}
          visible
          sidebarCollapsed={!sidebarExpanded}
          chromeInset={withChromeInset ? chromeWidth : 0}
          isTauri={false}
          onTitleAutoUpdated={() => {}}
          onChatCreated={() => {}}
          onChatDeleted={() => {}}
          onTerminalCreated={() => {}}
          onTerminalDeleted={() => {}}
        />
      </div>
      {withChromeInset && (
        <WindowChrome
          isTauri={false}
          settingsOpen={false}
          onToggleSidebar={() => {}}
          onOpenSettings={() => {}}
          onCloseSettings={() => {}}
          onWidthChange={setChromeWidth}
        />
      )}
    </main>
  );
}

export function RendererHarness() {
  if (new URLSearchParams(window.location.search).get("panelGesture") === "1") {
    return <PanelGestureHarness />;
  }
  if (new URLSearchParams(window.location.search).get("dragLayer") === "1") {
    return (
      <main className="relative h-screen bg-background text-foreground">
        <div
          data-drag-containing-block
          className="absolute"
          style={{ left: 100, top: 80, width: 500, height: 400, contain: "strict" }}
        >
          <DragLayer
            drag={{
              tabId: "test-tab",
              label: "Dragged tab",
              kind: "chat",
              x: 200,
              y: 160,
              preview: { left: 160, top: 120, width: 240, height: 180 },
            }}
          />
        </div>
      </main>
    );
  }
  return <MessageRendererHarness />;
}

function MessageRendererHarness() {
  const parameters = useMemo(() => new URLSearchParams(window.location.search), []);
  const count = Number(parameters.get("messages") ?? 400);
  const chatCount = Number(parameters.get("chats") ?? 2);
  const chatIds = useMemo(
    () =>
      Array.from({ length: chatCount }, (_, index) => `chat-${String.fromCharCode(97 + index)}`),
    [chatCount],
  );
  const [activeChat, setActiveChat] = useState(chatIds[0]!);
  const [stageWidth, setStageWidth] = useState(920);
  const paneRefs = useRef(new Map<string, ChatPaneHandle>());

  useEffect(() => {
    const api: HarnessApi = {
      async animateWidth(from, to, steps = 24) {
        setStageWidth(from);
        await frame();
        for (let step = 1; step <= steps; step++) {
          setStageWidth(from + ((to - from) * step) / steps);
          await frame();
        }
      },
      appendLive(text) {
        paneRefs.current.get(activeChat)?.appendLive(text);
      },
      assignMessageId(messageId) {
        paneRefs.current.get(activeChat)?.assignMessageId(messageId);
      },
      commitLive() {
        paneRefs.current.get(activeChat)?.commitLive();
      },
      metrics: () => getRenderMetrics().snapshot(),
      prepend(pageCount) {
        paneRefs.current.get(activeChat)?.prepend(pageCount);
      },
      async resetMetrics() {
        await frame();
        await frame();
        getRenderMetrics().reset();
      },
      startLive() {
        paneRefs.current.get(activeChat)?.startLive();
      },
      async switchChat(chatId) {
        setActiveChat(chatId);
        await frame();
        await frame();
      },
      async waitFrames(frameCount = 2) {
        for (let index = 0; index < frameCount; index++) await frame();
      },
    };
    window.__isoladeRendererHarness = api;
    document.documentElement.dataset.harnessReady = "true";
    return () => {
      delete window.__isoladeRendererHarness;
      delete document.documentElement.dataset.harnessReady;
    };
  }, [activeChat]);

  return (
    <main className="flex h-screen flex-col overflow-hidden bg-muted/40 text-foreground">
      <nav className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-background px-3">
        {chatIds.map((chatId) => (
          <button
            key={chatId}
            type="button"
            data-chat-button={chatId}
            aria-pressed={activeChat === chatId}
            onClick={() => setActiveChat(chatId)}
            className="rounded border border-border px-3 py-1 text-xs"
          >
            {chatId}
          </button>
        ))}
        <output data-stage-width className="ml-auto text-xs tabular-nums">
          {Math.round(stageWidth)}px
        </output>
      </nav>
      <div className="flex min-h-0 flex-1 justify-center overflow-hidden p-3">
        <div
          data-render-stage
          className="relative h-full min-w-0 overflow-hidden rounded border border-border bg-background"
          style={{ width: stageWidth }}
        >
          {chatIds.map((chatId) => (
            <ChatPane
              key={chatId}
              ref={(handle) => {
                if (handle) paneRefs.current.set(chatId, handle);
                else paneRefs.current.delete(chatId);
              }}
              chatId={chatId}
              count={count}
              visible={activeChat === chatId}
            />
          ))}
        </div>
      </div>
    </main>
  );
}

declare global {
  interface Window {
    __isoladeRendererHarness?: HarnessApi;
  }
}
