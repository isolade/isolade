import {
  Bot,
  ChevronLeft,
  ChevronRight,
  FolderTree,
  GitPullRequest,
  Globe,
  type LucideIcon,
  Network,
  Plus,
  Terminal as TerminalIcon,
  X,
} from "lucide-react";
import {
  createContext,
  memo,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useWindowDrag } from "@/lib/window-drag";
import {
  createChat,
  createTerminal,
  deleteChat,
  deleteTerminal,
  getInstanceLayout,
  updateInstanceLayout,
} from "../../lib/api";
import { readLastEffort, readLastModelId } from "../../lib/chat-defaults";
import type {
  AttachedPr,
  ChatModelDefinition,
  Chat as ChatT,
  Instance,
  Layout,
  LayoutNode,
  ModelOverrides,
  PanelNode,
  PanelTab,
  PortForward,
  SplitNode,
  TabKind,
  Terminal as TerminalT,
} from "../../lib/contracts";
import { clampEffortToModel, DEFAULT_CHAT_MODEL_ID, findChatModel } from "../../lib/contracts";
import {
  addTab,
  closeTab,
  type DropZone,
  defaultLayout,
  findTopLeftPanelId,
  leftEdgePanelIds,
  makeChatTab,
  makeTab,
  makeTerminalTab,
  moveTab,
  moveTabToIndex,
  reconcile,
  setActiveTab,
  setSplitSizes,
  topEdgePanelIds,
} from "../../lib/panel-layout";
import Chat from "../Chat";
import Terminal from "../Terminal";
import TitleBarPrs from "../TitleBarPrs";
import BrowserPreview from "./BrowserPreview";
import FileTree from "./FileTree";
import PortsPanel from "./PortsPanel";
import ReviewPanel from "./ReviewPanel";

const TAB_ICON: Record<TabKind, LucideIcon> = {
  chat: Bot,
  terminal: TerminalIcon,
  browser: Globe,
  files: FolderTree,
  review: GitPullRequest,
  ports: Network,
};

// The "+" menu: a single "Chat" entry (opens on the default/last-selected
// model, like the draft composer), then the per-instance utilities.
const UTILITY_KINDS: { kind: Exclude<TabKind, "chat">; label: string }[] = [
  { kind: "terminal", label: "Terminal" },
  { kind: "files", label: "Files" },
  { kind: "review", label: "Review" },
  { kind: "browser", label: "Browser" },
  { kind: "ports", label: "Ports" },
];

type Rect = { left: number; top: number; width: number; height: number };
type DropTarget =
  | { panelId: string; kind: "body"; zone: DropZone }
  | { panelId: string; kind: "strip"; index: number };
export interface DragState {
  tabId: string;
  label: string;
  kind: TabKind;
  x: number;
  y: number;
  preview: Rect | null;
}

// Everything the recursive tree needs, kept referentially stable *during a
// drag* (it deliberately excludes the live drag state) so the memoized tree
// doesn't re-render on every pointer move. The drag ghost/preview live in a
// separate <DragLayer> instead.
interface WorkspaceCtx {
  leftEdge: Set<string>;
  topEdge: Set<string>;
  topLeftPanelId: string;
  focusedPanelId: string;
  chromeInset: number;
  sidebarCollapsed: boolean;
  isTauri: boolean;
  onSelect: (panelId: string, tabId: string) => void;
  onClose: (tab: PanelTab) => void;
  onAdd: (panelId: string, kind: TabKind) => void;
  onResizeSplit: (splitId: string, sizes: [number, number]) => void;
  onFocusPanel: (panelId: string) => void;
  beginDrag: (tab: PanelTab, e: React.PointerEvent, onActivate?: () => void) => void;
  renderBody: (tab: PanelTab, active: boolean) => ReactNode;
  tabLabel: (tab: PanelTab) => string;
}
const Ctx = createContext<WorkspaceCtx | null>(null);
function useWorkspace(): WorkspaceCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useWorkspace outside provider");
  return ctx;
}

const EDGE = 0.25;
function computeZone(rx: number, ry: number): DropZone {
  if (rx > EDGE && rx < 1 - EDGE && ry > EDGE && ry < 1 - EDGE) return "center";
  const m = Math.min(rx, 1 - rx, ry, 1 - ry);
  if (m === rx) return "left";
  if (m === 1 - rx) return "right";
  if (m === ry) return "top";
  return "bottom";
}
function previewForZone(zone: DropZone, r: Rect): Rect {
  const halfW = r.width / 2;
  const halfH = r.height / 2;
  switch (zone) {
    case "left":
      return { left: r.left, top: r.top, width: halfW, height: r.height };
    case "right":
      return { left: r.left + halfW, top: r.top, width: halfW, height: r.height };
    case "top":
      return { left: r.left, top: r.top, width: r.width, height: halfH };
    case "bottom":
      return { left: r.left, top: r.top + halfH, width: r.width, height: halfH };
    default:
      return r;
  }
}

function containsPanel(node: LayoutNode, panelId: string): boolean {
  if (node.type === "panel") return node.id === panelId;
  return containsPanel(node.children[0], panelId) || containsPanel(node.children[1], panelId);
}

interface PanelWorkspaceProps {
  instance: Instance;
  chats: ChatT[];
  terminals: TerminalT[];
  ports: PortForward[];
  // Pull requests attached to this instance, plus the detach handler. Rendered
  // as a slim bar inside each chat tab's body (they have no home in the panel
  // chrome, and shouldn't push on the layout).
  prs: AttachedPr[];
  onDetachPr: (pr: AttachedPr) => void;
  chatModels: ChatModelDefinition[];
  modelOverrides: ModelOverrides;
  pendingFirstMessage: { chatId: string; content: string; uploadIds?: string[] } | null;
  visible: boolean;
  sidebarCollapsed: boolean;
  // Rendered width of the window-chrome cluster, used to inset the top-left
  // panel's tab strip so its tabs clear the traffic lights / toggle / gear.
  chromeInset: number;
  isTauri: boolean;
  onTitleAutoUpdated: (instanceId: string, title: string) => void;
  // Optimistic parent-state sync so a freshly created/closed resource is in the
  // live set before the next poll, and reconcile can't drop its just-added tab.
  onChatCreated: (chat: ChatT) => void;
  onChatDeleted: (chatId: string) => void;
  onTerminalCreated: (terminal: TerminalT) => void;
  onTerminalDeleted: (terminalId: string) => void;
}

export default function PanelWorkspace({
  instance,
  chats,
  terminals,
  ports,
  prs,
  onDetachPr,
  chatModels,
  modelOverrides,
  pendingFirstMessage,
  visible,
  sidebarCollapsed,
  chromeInset,
  isTauri,
  onTitleAutoUpdated,
  onChatCreated,
  onChatDeleted,
  onTerminalCreated,
  onTerminalDeleted,
}: PanelWorkspaceProps) {
  const instanceId = instance.id;
  const [layout, setLayout] = useState<Layout | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [focusedPanelId, setFocusedPanelId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => () => dragCleanupRef.current?.(), []);

  const chatIds = useMemo(() => chats.map((c) => c.id), [chats]);
  const terminalIds = useMemo(() => terminals.map((t) => t.id), [terminals]);
  const chatKey = chatIds.join(",");
  const terminalKey = terminalIds.join(",");
  // Live snapshots read by the load effect without making it depend on them.
  const idsRef = useRef({ chatIds, terminalIds });
  idsRef.current = { chatIds, terminalIds };

  // Persistence bookkeeping: the JSON we last committed to the server, so the
  // debounced save skips unchanged layouts and the initial load doesn't echo
  // straight back.
  const lastPersistedRef = useRef<string>("");

  // Load (or build) the layout when the instance changes.
  useEffect(() => {
    let cancelled = false;
    setHydrated(false);
    setLayout(null);
    void (async () => {
      let loaded: Layout | null = null;
      try {
        loaded = await getInstanceLayout(instanceId);
      } catch {
        // No saved layout (or the request failed) → fall back to a default.
      }
      if (cancelled) return;
      const { chatIds: liveChats, terminalIds: liveTerminals } = idsRef.current;
      const base = loaded ?? defaultLayout(liveChats);
      const next = reconcile(base, liveChats, liveTerminals);
      // A server hit seeds lastPersisted with its own JSON so we don't re-save
      // it; a brand-new instance (loaded null) leaves it empty so the default
      // gets written once.
      lastPersistedRef.current = loaded ? JSON.stringify(loaded) : "";
      setLayout(next);
      setHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [instanceId]);

  // Keep the tree in sync with the live resource set: drop dead chat/terminal
  // tabs, surface chats that appeared elsewhere. Runs only when the id-set
  // actually changes, and bails (returns the same reference) when there's
  // nothing to do so it never loops with the persist effect.
  useEffect(() => {
    setLayout((prev) => (prev ? reconcile(prev, chatIds, terminalIds) : prev));
    // chatKey/terminalKey are the stable string form of the arrays above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatKey, terminalKey]);

  // Persist layout changes (debounced). Skipped until hydrated so the load
  // itself never triggers a save-back, and skipped when unchanged.
  useEffect(() => {
    if (!hydrated || !layout) return;
    const json = JSON.stringify(layout);
    if (json === lastPersistedRef.current) return;
    const t = setTimeout(() => {
      lastPersistedRef.current = json;
      void updateInstanceLayout(instanceId, layout).catch(() => {});
    }, 400);
    return () => clearTimeout(t);
  }, [layout, hydrated, instanceId]);

  const applyLayout = useCallback((fn: (l: Layout) => Layout) => {
    setLayout((prev) => (prev ? fn(prev) : prev));
  }, []);

  const handleTitle = useCallback(
    (title: string) => onTitleAutoUpdated(instanceId, title),
    [onTitleAutoUpdated, instanceId],
  );

  const onSelect = useCallback(
    (panelId: string, tabId: string) => applyLayout((l) => setActiveTab(l, panelId, tabId)),
    [applyLayout],
  );

  const onClose = useCallback(
    (tab: PanelTab) => {
      applyLayout((l) => closeTab(l, tab.id));
      if (tab.kind === "chat" && tab.resourceId) {
        onChatDeleted(tab.resourceId);
        void deleteChat(instanceId, tab.resourceId).catch(() => {});
      } else if (tab.kind === "terminal" && tab.resourceId) {
        onTerminalDeleted(tab.resourceId);
        void deleteTerminal(instanceId, tab.resourceId).catch(() => {});
      }
    },
    [applyLayout, instanceId, onChatDeleted, onTerminalDeleted],
  );

  const onAdd = useCallback(
    (panelId: string, kind: TabKind) => {
      if (kind === "chat") {
        const model = readLastModelId() ?? DEFAULT_CHAT_MODEL_ID;
        const modelDefinition =
          chatModels.find((item) => item.id === model) ?? findChatModel(model);
        const storedEffort = readLastEffort();
        const effort = modelDefinition
          ? clampEffortToModel(storedEffort ?? modelDefinition.defaultEffort, modelDefinition)
          : (storedEffort ?? undefined);
        void (async () => {
          try {
            const chat = await createChat(instanceId, { model, effort });
            onChatCreated(chat);
            applyLayout((l) => addTab(l, panelId, makeChatTab(chat.id)));
          } catch {}
        })();
      } else if (kind === "terminal") {
        void (async () => {
          try {
            const term = await createTerminal(instanceId);
            onTerminalCreated(term);
            applyLayout((l) => addTab(l, panelId, makeTerminalTab(term.id)));
          } catch {}
        })();
      } else {
        applyLayout((l) => addTab(l, panelId, makeTab(kind)));
      }
    },
    [applyLayout, chatModels, instanceId, onChatCreated, onTerminalCreated],
  );

  const onResizeSplit = useCallback(
    (splitId: string, sizes: [number, number]) =>
      applyLayout((l) => setSplitSizes(l, splitId, sizes)),
    [applyLayout],
  );

  const tabLabel = useCallback(
    (tab: PanelTab): string => {
      switch (tab.kind) {
        case "chat": {
          const chat = chats.find((c) => c.id === tab.resourceId);
          const model = chat
            ? (findChatModel(chat.model) ?? chatModels.find((m) => m.id === chat.model))
            : null;
          return model?.name ?? "Chat";
        }
        case "terminal":
          return "Terminal";
        default:
          return UTILITY_KINDS.find((u) => u.kind === tab.kind)?.label ?? tab.kind;
      }
    },
    [chats, chatModels],
  );

  const renderBody = useCallback(
    (tab: PanelTab, active: boolean): ReactNode => {
      switch (tab.kind) {
        case "chat": {
          const chat = chats.find((c) => c.id === tab.resourceId);
          if (!chat) return null;
          const initialMessage =
            pendingFirstMessage && pendingFirstMessage.chatId === chat.id
              ? pendingFirstMessage.content
              : undefined;
          const initialUploadIds =
            pendingFirstMessage && pendingFirstMessage.chatId === chat.id
              ? pendingFirstMessage.uploadIds
              : undefined;
          return (
            <div className="flex h-full flex-col">
              {prs.length > 0 && (
                <div className="flex-shrink-0 flex items-center justify-center gap-1 border-b border-border px-2 py-1">
                  <TitleBarPrs prs={prs} onDetach={onDetachPr} />
                </div>
              )}
              <div className="flex-1 min-h-0">
                <Chat
                  instanceId={instanceId}
                  chatId={chat.id}
                  model={chat.model}
                  effort={chat.effort}
                  chat={chat}
                  chatModels={chatModels}
                  modelOverrides={modelOverrides}
                  visible={visible && active}
                  initialMessage={initialMessage}
                  initialUploadIds={initialUploadIds}
                  pending={false}
                  creationError={null}
                  onTitle={handleTitle}
                />
              </div>
            </div>
          );
        }
        case "terminal": {
          const term = terminals.find((t) => t.id === tab.resourceId);
          if (!term) {
            return (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                Terminal closed
              </div>
            );
          }
          return (
            <Terminal
              key={term.id}
              wsUrl={`/api/instances/${instanceId}/terminals/${term.id}/socket?rows=24&cols=80`}
              active={visible && active}
            />
          );
        }
        case "browser":
          return (
            <BrowserPreview instanceId={instanceId} ports={ports} active={visible && active} />
          );
        case "files":
          return <FileTree instanceId={instanceId} active={visible && active} />;
        case "review":
          return <ReviewPanel instanceId={instanceId} active={visible && active} />;
        case "ports":
          return <PortsPanel instanceId={instanceId} active={visible && active} />;
      }
    },
    [
      chats,
      terminals,
      ports,
      prs,
      onDetachPr,
      instanceId,
      chatModels,
      modelOverrides,
      pendingFirstMessage,
      visible,
      handleTitle,
    ],
  );

  // ---- drag orchestration ----
  // Latest label lookup, read inside the (stable) pointer handlers.
  const tabLabelRef = useRef(tabLabel);
  tabLabelRef.current = tabLabel;

  const hitTest = useCallback(
    (x: number, y: number): { target: DropTarget; preview: Rect } | null => {
      const root = rootRef.current;
      if (!root) return null;
      // Tab strips take priority: a drop there reorders (or moves in at an index).
      for (const strip of Array.from(root.querySelectorAll<HTMLElement>("[data-strip-id]"))) {
        const r = strip.getBoundingClientRect();
        if (x < r.left || x >= r.right || y < r.top || y >= r.bottom) continue;
        const panelId = strip.dataset.stripId as string;
        const tabEls = Array.from(strip.querySelectorAll<HTMLElement>("[data-tab-id]"));
        let index = tabEls.length;
        let lineX = r.right;
        for (let i = 0; i < tabEls.length; i++) {
          const tr = (tabEls[i] as HTMLElement).getBoundingClientRect();
          if (x < tr.left + tr.width / 2) {
            index = i;
            lineX = tr.left;
            break;
          }
          lineX = tr.right;
        }
        return {
          target: { panelId, kind: "strip", index },
          preview: { left: lineX - 1, top: r.top, width: 2, height: r.height },
        };
      }
      for (const body of Array.from(root.querySelectorAll<HTMLElement>("[data-body-id]"))) {
        const r = body.getBoundingClientRect();
        if (x < r.left || x >= r.right || y < r.top || y >= r.bottom) continue;
        const panelId = body.dataset.bodyId as string;
        const zone = computeZone((x - r.left) / r.width, (y - r.top) / r.height);
        return { target: { panelId, kind: "body", zone }, preview: previewForZone(zone, r) };
      }
      return null;
    },
    [],
  );

  const beginDrag = useCallback(
    (tab: PanelTab, e: React.PointerEvent, onActivate?: () => void) => {
      if (e.button !== 0) return;
      dragCleanupRef.current?.();
      // Stop the browser's native text/image drag before the pointer leaves the
      // tab. The document-wide lock covers the rest of the gesture, including
      // content outside the tab strip, where WebKit can otherwise extend a text
      // selection despite the tab itself being `select-none`.
      e.preventDefault();
      const rootStyle = document.documentElement.style;
      const previousUserSelect = rootStyle.userSelect;
      const previousWebkitUserSelect = rootStyle.webkitUserSelect;
      rootStyle.userSelect = "none";
      rootStyle.webkitUserSelect = "none";
      const startX = e.clientX;
      const startY = e.clientY;
      let active = false;
      const cleanup = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("blur", onCancel);
        rootStyle.userSelect = previousUserSelect;
        rootStyle.webkitUserSelect = previousWebkitUserSelect;
        if (dragCleanupRef.current === cleanup) dragCleanupRef.current = null;
      };
      const onMove = (ev: PointerEvent) => {
        if (!active) {
          if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
          active = true;
          onActivate?.();
        }
        const hit = hitTest(ev.clientX, ev.clientY);
        setDrag({
          tabId: tab.id,
          label: tabLabelRef.current(tab),
          kind: tab.kind,
          x: ev.clientX,
          y: ev.clientY,
          preview: hit?.preview ?? null,
        });
      };
      const onUp = (ev: PointerEvent) => {
        cleanup();
        setDrag(null);
        if (!active) return;
        const hit = hitTest(ev.clientX, ev.clientY);
        if (!hit) return;
        const t = hit.target;
        setFocusedPanelId(t.panelId);
        if (t.kind === "strip") {
          applyLayout((l) => moveTabToIndex(l, tab.id, t.panelId, t.index));
        } else {
          applyLayout((l) => moveTab(l, tab.id, t.panelId, t.zone));
        }
      };
      const onCancel = () => {
        cleanup();
        setDrag(null);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("blur", onCancel);
      dragCleanupRef.current = cleanup;
    },
    [applyLayout, hitTest],
  );

  const leftEdge = useMemo(() => (layout ? leftEdgePanelIds(layout) : new Set<string>()), [layout]);
  const topEdge = useMemo(() => (layout ? topEdgePanelIds(layout) : new Set<string>()), [layout]);
  const topLeftPanelId = useMemo(() => (layout ? findTopLeftPanelId(layout) : ""), [layout]);
  const effectiveFocusedPanelId =
    layout && focusedPanelId && containsPanel(layout, focusedPanelId)
      ? focusedPanelId
      : topLeftPanelId;

  const ctx = useMemo<WorkspaceCtx>(
    () => ({
      leftEdge,
      topEdge,
      topLeftPanelId,
      focusedPanelId: effectiveFocusedPanelId,
      chromeInset,
      sidebarCollapsed,
      isTauri,
      onSelect,
      onClose,
      onAdd,
      onResizeSplit,
      onFocusPanel: setFocusedPanelId,
      beginDrag,
      renderBody,
      tabLabel,
    }),
    [
      leftEdge,
      topEdge,
      topLeftPanelId,
      effectiveFocusedPanelId,
      chromeInset,
      sidebarCollapsed,
      isTauri,
      onSelect,
      onClose,
      onAdd,
      onResizeSplit,
      beginDrag,
      renderBody,
      tabLabel,
    ],
  );

  return (
    <div ref={rootRef} className="flex-1 min-w-0 min-h-0 flex bg-background">
      {layout && (
        <Ctx.Provider value={ctx}>
          <LayoutNodeView key={layout.id} node={layout} />
        </Ctx.Provider>
      )}
      <DragLayer drag={drag} />
    </div>
  );
}

// The recursive tree renderer. Memoized so a drag (which updates state on the
// parent but leaves `node` and the context value untouched) doesn't re-render
// panels or their bodies.
const LayoutNodeView = memo(function LayoutNodeView({ node }: { node: LayoutNode }) {
  return node.type === "split" ? <SplitView node={node} /> : <PanelView panel={node} />;
});

function ScrollableTabList({
  panelId,
  activeTabId,
  tabKey,
  children,
}: {
  panelId: string;
  activeTabId: string | null;
  tabKey: string;
  children: ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  const updateEdges = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setEdges((current) =>
      current.left === left && current.right === right ? current : { left, right },
    );
  }, []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    updateEdges();
    const observer = new ResizeObserver(updateEdges);
    observer.observe(el);
    el.addEventListener("scroll", updateEdges, { passive: true });
    return () => {
      observer.disconnect();
      el.removeEventListener("scroll", updateEdges);
    };
  }, [tabKey, updateEdges]);

  // A newly added or programmatically selected tab may start outside the
  // viewport. Keep the active tab visible without moving the whole page.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !activeTabId) return;
    const tab = el.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(activeTabId)}"]`);
    if (!tab) return;
    const viewportRect = el.getBoundingClientRect();
    const tabRect = tab.getBoundingClientRect();
    if (tabRect.left < viewportRect.left) el.scrollLeft += tabRect.left - viewportRect.left;
    else if (tabRect.right > viewportRect.right) {
      el.scrollLeft += tabRect.right - viewportRect.right;
    }
    updateEdges();
  }, [activeTabId, tabKey, updateEdges]);

  const scroll = (direction: -1 | 1) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({ left: direction * Math.max(120, el.clientWidth * 0.65), behavior: "smooth" });
  };

  return (
    <div className="flex flex-1 min-w-0 h-full items-center">
      {edges.left && (
        <button
          type="button"
          data-panel-tabs-scroll-left={panelId}
          className="flex h-full w-5 flex-shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
          onClick={() => scroll(-1)}
          aria-label="Scroll tabs left"
        >
          <ChevronLeft className="size-3.5" />
        </button>
      )}
      <div
        ref={scrollRef}
        data-panel-tabs-scroll={panelId}
        role="tablist"
        aria-label="Panel tabs"
        className="flex flex-1 min-w-0 h-full items-center overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        onWheel={(e) => {
          if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
          e.preventDefault();
          e.currentTarget.scrollLeft += e.deltaY;
        }}
      >
        {children}
      </div>
      {edges.right && (
        <button
          type="button"
          data-panel-tabs-scroll-right={panelId}
          className="flex h-full w-5 flex-shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
          onClick={() => scroll(1)}
          aria-label="Scroll tabs right"
        >
          <ChevronRight className="size-3.5" />
        </button>
      )}
    </div>
  );
}

function SplitView({ node }: { node: SplitNode }) {
  const { onResizeSplit } = useWorkspace();
  const row = node.direction === "row";
  const containerRef = useRef<HTMLDivElement>(null);
  const aRef = useRef<HTMLDivElement>(null);
  const bRef = useRef<HTMLDivElement>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const [resizing, setResizing] = useState(false);

  useEffect(() => () => resizeCleanupRef.current?.(), []);

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    resizeCleanupRef.current?.();
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const total = row ? rect.width : rect.height;
    if (total <= 0) return;
    const divider = e.currentTarget;
    const pointerId = e.pointerId;
    setResizing(true);
    let latest: [number, number] = node.sizes;
    let finished = false;
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      // If release happened outside the window, the next move may be the first
      // event we receive. Its button state still tells us the gesture ended.
      if ((ev.buttons & 1) === 0) {
        finish();
        return;
      }
      const pos = row ? ev.clientX - rect.left : ev.clientY - rect.top;
      const f = Math.min(0.85, Math.max(0.15, pos / total));
      latest = [f, 1 - f];
      // Write straight to the DOM during the drag so the (potentially heavy)
      // subtree doesn't re-render on every mousemove; commit once on release.
      if (aRef.current) aRef.current.style.flexGrow = `${f}`;
      if (bRef.current) bRef.current.style.flexGrow = `${1 - f}`;
    };
    const removeListeners = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("mouseup", finish);
      window.removeEventListener("blur", finish);
      divider.removeEventListener("lostpointercapture", onLostCapture);
    };
    const releaseCapture = () => {
      if (divider.hasPointerCapture(pointerId)) divider.releasePointerCapture(pointerId);
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      removeListeners();
      releaseCapture();
      if (resizeCleanupRef.current === abandon) resizeCleanupRef.current = null;
      setResizing(false);
      onResizeSplit(node.id, latest);
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId) finish();
    };
    const onCancel = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId) finish();
    };
    const onLostCapture = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId) finish();
    };
    const abandon = () => {
      if (finished) return;
      finished = true;
      removeListeners();
      releaseCapture();
      if (resizeCleanupRef.current === abandon) resizeCleanupRef.current = null;
    };
    resizeCleanupRef.current = abandon;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("mouseup", finish);
    window.addEventListener("blur", finish);
    divider.addEventListener("lostpointercapture", onLostCapture);
    // Some webviews reject capture even for a live mouse pointer. The window
    // listeners still provide complete cleanup in that case.
    try {
      divider.setPointerCapture(pointerId);
    } catch {}
  };

  const childStyle = (grow: number): React.CSSProperties => ({
    flexGrow: grow,
    flexBasis: 0,
    minWidth: 0,
    minHeight: 0,
  });

  return (
    <div
      ref={containerRef}
      className={cn("flex flex-1 min-w-0 min-h-0", row ? "flex-row" : "flex-col")}
    >
      <div ref={aRef} className="flex min-w-0 min-h-0" style={childStyle(node.sizes[0])}>
        <LayoutNodeView key={node.children[0].id} node={node.children[0]} />
      </div>
      <div className={cn("relative flex-shrink-0 bg-border", row ? "w-px" : "h-px")}>
        <div
          onPointerDown={onDown}
          role="separator"
          aria-orientation={row ? "vertical" : "horizontal"}
          aria-label="Resize panels"
          tabIndex={-1}
          className={cn(
            "absolute z-10",
            row
              ? "inset-y-0 -left-1 w-2 cursor-col-resize"
              : "inset-x-0 -top-1 h-2 cursor-row-resize",
          )}
        />
      </div>
      <div ref={bRef} className="flex min-w-0 min-h-0" style={childStyle(node.sizes[1])}>
        <LayoutNodeView key={node.children[1].id} node={node.children[1]} />
      </div>
      {resizing && (
        <div
          data-panel-resize-overlay
          className="fixed inset-0 z-50 select-none"
          style={{ cursor: row ? "col-resize" : "row-resize" }}
        />
      )}
    </div>
  );
}

function PanelView({ panel }: { panel: PanelNode }) {
  const ctx = useWorkspace();
  const isLeftEdge = ctx.leftEdge.has(panel.id);
  const isTopEdge = ctx.topEdge.has(panel.id);
  const isTopLeft = panel.id === ctx.topLeftPanelId;
  const isFocused = panel.id === ctx.focusedPanelId;
  const windowDrag = useWindowDrag(ctx.isTauri);
  // Lazy-mount-then-keep-alive: a body is created the first time its tab is
  // active, and kept mounted thereafter so its state (chat scroll, terminal
  // socket, file-tree expansion) survives switching away. Tracked in a ref so
  // reading it during render doesn't need a state round-trip.
  const mountedRef = useRef<Set<string>>(new Set());
  if (panel.activeTabId) mountedRef.current.add(panel.activeTabId);

  // Only the tab strips of top-edge panels double as the window title bar, so
  // only their empty regions drag the window.
  const stripDrag = isTopEdge ? windowDrag : {};

  return (
    <div
      data-panel-id={panel.id}
      data-panel-focused={isFocused}
      className="flex flex-col flex-1 min-w-0 min-h-0 bg-background"
      onPointerDownCapture={() => ctx.onFocusPanel(panel.id)}
      onFocusCapture={() => ctx.onFocusPanel(panel.id)}
    >
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
      <div
        data-strip-id={panel.id}
        className={cn(
          "flex items-center h-8 bg-background flex-shrink-0 select-none",
          isLeftEdge && !ctx.sidebarCollapsed && "pl-1.5",
        )}
        {...stripDrag}
      >
        {isTopLeft && ctx.sidebarCollapsed && ctx.chromeInset > 0 && (
          <div style={{ width: ctx.chromeInset }} className="flex-shrink-0" aria-hidden />
        )}
        <ScrollableTabList
          panelId={panel.id}
          activeTabId={panel.activeTabId}
          tabKey={panel.tabs.map((tab) => tab.id).join(",")}
        >
          {panel.tabs.map((tab) => (
            <TabButton
              key={tab.id}
              tab={tab}
              panelId={panel.id}
              active={panel.activeTabId === tab.id}
              panelFocused={isFocused}
            />
          ))}
          <AddTabMenu panelId={panel.id} align={isTopEdge ? "start" : "end"} />
        </ScrollableTabList>
      </div>

      <div data-body-id={panel.id} className="flex-1 min-h-0 relative">
        {panel.tabs.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
            No tabs. Use + to add one
          </div>
        )}
        {panel.tabs.map((tab) => {
          const active = panel.activeTabId === tab.id;
          if (!active && !mountedRef.current.has(tab.id)) return null;
          return (
            <div
              key={tab.id}
              className="absolute inset-0"
              style={{ display: active ? "block" : "none" }}
            >
              {ctx.renderBody(tab, active)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TabButton({
  tab,
  panelId,
  active,
  panelFocused,
}: {
  tab: PanelTab;
  panelId: string;
  active: boolean;
  panelFocused: boolean;
}) {
  const ctx = useWorkspace();
  const Icon = TAB_ICON[tab.kind];
  // A drag that actually moved must not also fire the tab's click-to-select.
  const draggedRef = useRef(false);
  return (
    <div
      data-tab-id={tab.id}
      data-demo={`panel-tab-${tab.kind}`}
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      className={cn(
        // Flat tab: no per-tab box, just a foreground underline under the active
        // tab (the tab strip itself has no bottom border).
        "group/tab relative flex items-center gap-1 px-2 h-full text-xs cursor-pointer select-none whitespace-nowrap flex-shrink-0",
        "after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-foreground after:transition-opacity",
        active && panelFocused && "text-foreground after:opacity-100",
        active && !panelFocused && "text-foreground/70 after:opacity-35",
        !active && "text-muted-foreground hover:text-foreground after:opacity-0",
      )}
      onPointerDown={(e) => {
        draggedRef.current = false;
        ctx.beginDrag(tab, e, () => {
          draggedRef.current = true;
        });
      }}
      onClick={() => {
        if (draggedRef.current) {
          draggedRef.current = false;
          return;
        }
        ctx.onSelect(panelId, tab.id);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          ctx.onSelect(panelId, tab.id);
        }
      }}
    >
      <Icon className="size-3.5 flex-shrink-0" />
      <span className="truncate max-w-[160px]">{ctx.tabLabel(tab)}</span>
      <Button
        variant="ghost"
        size="icon"
        className="size-4 opacity-0 transition-none group-hover/tab:opacity-100 data-[active=true]:opacity-100 -mr-1"
        data-active={active}
        onClick={(e) => {
          e.stopPropagation();
          ctx.onClose(tab);
        }}
        onPointerDown={(e) => e.stopPropagation()}
        aria-label="Close tab"
      >
        <X className="size-3" />
      </Button>
    </div>
  );
}

function AddTabMenu({ panelId, align }: { panelId: string; align: "start" | "end" }) {
  const { onAdd } = useWorkspace();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 flex-shrink-0"
          aria-label="New tab"
          data-demo="panel-add"
        >
          <Plus className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align}>
        <DropdownMenuItem data-demo="panel-add-chat" onClick={() => onAdd(panelId, "chat")}>
          <Bot className="size-3.5" />
          Chat
        </DropdownMenuItem>
        {UTILITY_KINDS.map(({ kind, label }) => {
          const Icon = TAB_ICON[kind];
          return (
            <DropdownMenuItem
              key={kind}
              data-demo={`panel-add-${kind}`}
              onClick={() => onAdd(panelId, kind)}
            >
              <Icon className="size-3.5" />
              {label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// The floating overlay shown only during a drag: a full-window capture layer
// (so the pointer can't get stuck inside a preview iframe), the drop-target
// highlight, and a small ghost following the cursor. Portal it to <body> so
// the retained instance's `contain: strict` cannot turn viewport coordinates
// into coordinates relative to the instance wrapper.
export function DragLayer({ drag }: { drag: DragState | null }) {
  if (!drag) return null;
  const Icon = TAB_ICON[drag.kind];
  return createPortal(
    <>
      <div data-panel-drag-capture className="fixed inset-0 z-[60] cursor-grabbing select-none" />
      {drag.preview && (
        <div
          data-panel-drag-preview
          className="fixed z-[65] pointer-events-none rounded-sm bg-primary/20 border-2 border-primary/70"
          style={{
            left: drag.preview.left,
            top: drag.preview.top,
            width: drag.preview.width,
            height: drag.preview.height,
          }}
        />
      )}
      <div
        data-panel-drag-ghost
        className="fixed z-[70] pointer-events-none flex items-center gap-1.5 px-2.5 h-7 rounded border border-border bg-background text-xs text-foreground shadow-md"
        style={{ left: drag.x + 12, top: drag.y + 12 }}
      >
        <Icon className="size-3.5" />
        <span className="truncate max-w-[160px]">{drag.label}</span>
      </div>
    </>,
    document.body,
  );
}
