import { ArrowDown } from "lucide-react";
import {
  memo,
  type PointerEvent as ReactPointerEvent,
  type UIEvent as ReactUIEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  API_BASE,
  getChatContextBreakdown,
  getChatToolDetails,
  getInFlightChatRender,
  listChatRenderChunks,
  listChatTranscript,
  setChatActiveLeaf,
  updateChatModel,
} from "../lib/api";
import { writeLastEffort, writeLastModelId } from "../lib/chat-defaults";
import {
  type ChatTurnEvent,
  cancelChatTurn,
  resumeChatTurn,
  runChatTurn,
} from "../lib/chat-stream";
import type {
  ChatEffort,
  ChatModelDefinition,
  Chat as ChatRow,
  ContextBreakdown,
  ModelOverrides,
  TranscriptMessage,
  UpdateChatBody,
  Upload,
} from "../lib/contracts";
import { findChatModel } from "../lib/contracts";
import { scheduleIdleWork } from "../lib/idle-work-queue";
import { RequestGeneration } from "../lib/request-generation";
import {
  resolveFontFamily,
  useAgentFontSetting,
  useDebugSetting,
  useUserFontSetting,
} from "../lib/settings";
import { useAttachments } from "../lib/use-attachments";
import { AttachmentStrip } from "./chat/AttachmentStrip";
import {
  applyEvent,
  mergeToolDetails,
  REVEAL_CATCHUP_SECONDS,
  REVEAL_CHARACTERS_PER_SECOND,
  REVEAL_LAG_CHARACTERS,
  REVEAL_MAX_CHARACTERS_PER_SECOND,
  replaceChunksFromSnapshot,
  revealableLength,
  revealChunks,
  type StreamChunk,
  type SubscriptionShare,
  type TokenUsage,
  type UsageState,
  usageSeedFromChat,
} from "./chat/chunks";
import {
  type LiveAssistantRow,
  MessageHistory,
  type MessageHistoryHandle,
  type MessageHistoryPage,
  type SessionMessageRow,
} from "./chat/MessageHistory";
import { ContextBar, ContextBreakdownDetail, ContextDetail } from "./chat/UsagePanel";
import { MessageBox } from "./MessageBox";
import { ModelEffortPicker } from "./ModelEffortPicker";

// Distance (px) from the bottom within which the user counts as "pinned"
// to the live tail. Pinned: streaming keeps auto-scrolling. Beyond it the
// user is reading history, so streaming must not yank the viewport and the
// jump-to-bottom button shows instead.
const SCROLL_PIN_THRESHOLD_PX = 2;

function pageKey(messages: TranscriptMessage[], fallback: string): string {
  return `${messages[0]?.id ?? fallback}:${messages.at(-1)?.id ?? fallback}`;
}

function chunksFromPage(page: unknown): Record<string, StreamChunk[]> {
  const chunks = (page as { chunksByMessage?: unknown }).chunksByMessage;
  return chunks && typeof chunks === "object" ? (chunks as Record<string, StreamChunk[]>) : {};
}

function optimisticUserMessage(chatId: string, content: string): TranscriptMessage {
  return {
    id: `optimistic-${chatId}`,
    chatId,
    role: "user",
    content,
    parentId: null,
    createdAt: new Date(),
    version: null,
  };
}

interface ChatProps {
  instanceId: string;
  chatId: string;
  model: string;
  effort: ChatEffort;
  // Persisted chat row, used to rebuild the cost / context-pressure UI on
  // mount. Without it the panel sits blank until the next `usage` SSE event,
  // which can be several minutes into a long-running turn.
  chat: ChatRow;
  chatModels: ChatModelDefinition[];
  modelOverrides: ModelOverrides;
  visible: boolean;
  // Optional message to send automatically on first mount. Used by the
  // new-chat flow so the user's first message (typed in the empty-state
  // pane) streams in immediately when the chat tab opens.
  initialMessage?: string;
  // Ids of files the user attached to that first message in the empty-state
  // pane (already staged against this instance). Attached to the bootstrap send.
  initialUploadIds?: string[];
  // True while the instance's VM + server-side chat haven't been created
  // yet. The chat tab still renders the optimistic user bubble + dots (via the
  // useState initializer below), but skips all server I/O and the auto-send.
  pending?: boolean;
  // Non-null when VM/chat creation failed. Surfaced as an assistant error
  // message in the same rendering path as a stream failure.
  creationError?: string | null;
  // Fires when the server-side auto-titler emits a `title` event on the
  // SSE stream of message #1. Sidebar wires it to update the row label.
  onTitle?: (title: string) => void;
}

type RenderEventFrame = Extract<ChatTurnEvent, { kind: "event" }>;

// Memoized so activating a chat tab (which re-renders the parent panel) only
// re-renders the two tabs whose `visible` flips, not every mounted chat of the
// instance. All other props (chat row, model list, callbacks) keep a
// stable identity across a tab switch, so the memo holds. Without this, each
// click reconciles the full message list of every open chat on the main
// thread — work that scales with total history across all tabs.
function Chat({
  instanceId,
  chatId,
  model,
  effort,
  chat,
  chatModels,
  modelOverrides,
  visible,
  initialMessage,
  initialUploadIds,
  pending = false,
  creationError = null,
  onTitle,
}: ChatProps) {
  // When we mount with an `initialMessage`, the parent has just bootstrapped
  // this chat (either real or synthetic-pending). Render the user's bubble +
  // streaming dots from the very first commit so the synthetic→real swap is
  // visually identical and seamless.
  const [historyPages, setHistoryPages] = useState<MessageHistoryPage[]>([]);
  const [sessionRows, setSessionRows] = useState<SessionMessageRow[]>(() =>
    initialMessage
      ? [
          {
            renderKey: `optimistic-${chatId}`,
            message: optimisticUserMessage(chatId, initialMessage),
          },
        ]
      : [],
  );
  const messages = useMemo(
    () => [
      ...historyPages.flatMap((page) => page.messages),
      ...sessionRows.map((row) => row.message),
    ],
    [historyPages, sessionRows],
  );
  const [input, setInput] = useState("");
  // Staged file attachments for the next send (browser upload / clipboard
  // paste). Uploads run in the background as files are added; sendMessage awaits
  // them for the ids. Scoped to this instance's bind-mounted uploads dir.
  const attachments = useAttachments(instanceId);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [streaming, setStreaming] = useState(!!initialMessage);
  // Which branch of the message tree is visible: the id of the path's last
  // message (or any message on it). Seeded from the persisted chat row,
  // advanced locally as turns run, and re-pointed by version navigation.
  // Mirrored into a ref so long-lived closures (drainTurn) read the current
  // value without re-subscribing.
  const activeLeafRef = useRef<string | null>(chat.activeLeafId ?? null);
  const setActiveLeaf = useCallback((id: string | null) => {
    activeLeafRef.current = id;
  }, []);
  // The user message currently being edited in place, if any.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [navigatingBranch, setNavigatingBranch] = useState(false);
  const navigatingBranchRef = useRef(false);
  // The optimistic user bubble of the in-flight turn, replaced by the
  // server's `user_message` frame (which carries the real id + parent).
  const pendingUserIdRef = useRef<string | null>(null);
  const initialLiveRenderKeyRef = useRef(initialMessage ? `live-${crypto.randomUUID()}` : null);
  const liveRenderKeyRef = useRef<string | null>(initialLiveRenderKeyRef.current);
  const [liveRow, setLiveRow] = useState<{
    renderKey: string;
    messageId: string | null;
    parentId: string | null;
    chunks: StreamChunk[];
  } | null>(() =>
    initialLiveRenderKeyRef.current
      ? { renderKey: initialLiveRenderKeyRef.current, messageId: null, parentId: null, chunks: [] }
      : null,
  );
  const [hasOlder, setHasOlder] = useState(false);
  const showDebug = useDebugSetting();
  const loadingOlderRef = useRef(false);
  const loadedChunkKeysRef = useRef(new Set<string>());
  const [chunkRequests] = useState(() => new RequestGeneration());
  const [toolDetailRequestGeneration] = useState(() => new RequestGeneration());
  const chunkModeRef = useRef(showDebug);
  const [transcriptRequests] = useState(() => new RequestGeneration());
  const hydratedRef = useRef(false);
  const [currentModel, setCurrentModel] = useState(model);
  const [currentEffort, setCurrentEffort] = useState<ChatEffort>(effort);
  // Server-synced (model, effort) pair. The picker stays interactive while a
  // turn is streaming. In that case we update the displayed values locally
  // and defer the PATCH until the user sends the next message. See
  // `sendMessage` for the flush.
  const appliedModelRef = useRef(model);
  const appliedEffortRef = useRef<ChatEffort>(effort);
  // Tracks the in-flight turn so the Stop button (and unmount) can abort the
  // SSE fetch. Stop also sends an explicit cancellation request. A plain
  // disconnect leaves the server turn running during its reconnect grace.
  const abortRef = useRef<AbortController | null>(null);
  const detachedControllersRef = useRef(new WeakSet<AbortController>());
  const detachedTurnRef = useRef<{
    messageId: string;
    lastSeq: number;
    renderKey: string;
  } | null>(null);
  const streamingMessageIdRef = useRef<string | null>(null);
  const liveLastSeqRef = useRef(-1);
  const agentFontFamily = resolveFontFamily(useAgentFontSetting());
  const userFontFamily = resolveFontFamily(useUserFontSetting());
  // Latest token-usage snapshot from the server. Seeded synchronously from
  // the persisted chat row so the composer's cost + context-pressure UI
  // survives a reload. Replaced wholesale by SSE `usage` events during a
  // turn and cleared when switching chats. Model and effort changes keep the
  // live Claude process and its accumulated usage.
  const [usage, setUsage] = useState<UsageState | null>(() => usageSeedFromChat(chat));
  // Live context breakdown requested from the persistent Claude process when
  // the model picker opens. Refreshed on every open so the table reflects the
  // current session state.
  const [breakdown, setBreakdown] = useState<ContextBreakdown | null>(null);
  const [breakdownLoading, setBreakdownLoading] = useState(false);
  const [breakdownError, setBreakdownError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const messageHistoryRef = useRef<MessageHistoryHandle>(null);
  // Latest chat prop, for effects/closures that shouldn't re-run when the
  // parent refreshes the row (only the values are read, lazily).
  const chatRef = useRef(chat);
  chatRef.current = chat;
  // The transcript API already returns the active root-to-tip path. Its last
  // loaded row is therefore the branch tip and remains O(1) to read.
  const tipIdRef = useRef<string | null>(null);
  tipIdRef.current = messages.at(-1)?.id ?? null;
  // The user message the in-flight turn replies to: the optimistic id at
  // send time, then the server id once the user_message frame lands. Null on
  // resumed turns (whose user message is already the branch tip). Where the
  // committed assistant message attaches.
  const turnUserIdRef = useRef<string | null>(null);
  // Mirror of `streaming` for stable callbacks (edit/navigation guards).
  const streamingRef = useRef(streaming);
  streamingRef.current = streaming;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const showDebugRef = useRef(showDebug);
  showDebugRef.current = showDebug;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const historyPagesRef = useRef(historyPages);
  historyPagesRef.current = historyPages;
  const sessionRowsRef = useRef(sessionRows);
  sessionRowsRef.current = sessionRows;
  const liveChunksRef = useRef<StreamChunk[]>([]);
  const liveRowRef = useRef(liveRow);
  liveRowRef.current = liveRow;
  const liveToolIndexRef = useRef(new Map<string, number>());
  const toolDetailsCacheRef = useRef(new Map<string, StreamChunk[]>());
  const toolDetailRequestsRef = useRef(new Set<string>());
  const debugReplayRef = useRef<{
    messageId: string;
    events: RenderEventFrame[];
  } | null>(null);
  const hiddenLiveRenderDirtyRef = useRef(false);
  // A hidden stream mutates its reducer without publishing React updates.
  // Include that accumulated snapshot in the reveal render itself so the
  // layout effect below can position the final-height row before first paint.
  const hotSwitchLiveChunks = useMemo(
    () =>
      visible && liveRow && hiddenLiveRenderDirtyRef.current ? [...liveChunksRef.current] : null,
    [liveRow, visible],
  );
  // Whether the viewport is within SCROLL_PIN_THRESHOLD_PX of the bottom.
  // Written by the container's onScroll, read inside scrollToBottom's rAF
  // callback, a ref (not state) so streaming scrolls never depend on a
  // re-render to see the latest value.
  const isPinnedRef = useRef(true);
  // Visibility changes can produce native scroll events while the retained
  // pane reflows. Preserve the user's logical state at hide time so a stale
  // event cannot turn a reader into a pinned viewport during reveal.
  const retainedPinnedRef = useRef(true);
  const previousVisibleRef = useRef(visible);
  const pinNextCommitRef = useRef(false);
  const [showJump, setShowJump] = useState(false);

  const positionAtBottom = useCallback(() => {
    const scrollElement = scrollContainerRef.current;
    if (!scrollElement) return;
    scrollElement.scrollTop = scrollElement.scrollHeight;
    isPinnedRef.current = true;
    setShowJump(false);
  }, []);

  const pinNextCommitToBottom = useCallback(() => {
    pinNextCommitRef.current = true;
    isPinnedRef.current = true;
  }, []);

  // State setters below can publish an entire transcript or a newly appended
  // row. Consume their one-shot placement request in the same commit so those
  // rows can never paint at scrollTop=0 before an rAF repair. The branch is a
  // ref check only, so ordinary streaming commits pay no layout cost here.
  useLayoutEffect(() => {
    if (!pinNextCommitRef.current) return;
    pinNextCommitRef.current = false;
    positionAtBottom();
  });

  const invalidateTranscriptRequests = useCallback(() => {
    loadingOlderRef.current = false;
    return transcriptRequests.invalidate();
  }, [transcriptRequests]);

  const resetChunkCache = useCallback(() => {
    chunkRequests.invalidate();
    loadedChunkKeysRef.current.clear();
    setHistoryPages((pages) =>
      pages.map((page) =>
        Object.keys(page.chunksByMessage).length === 0 ? page : { ...page, chunksByMessage: {} },
      ),
    );
  }, [chunkRequests]);

  // Debug and normal responses have different contents. Preserve the bounded
  // transcript that is already on screen while the explicit debug request
  // replaces it. Switching debug off only removes debug-only chunks. It does
  // not trigger a full-render fetch for every historical assistant message.
  useLayoutEffect(() => {
    if (chunkModeRef.current === showDebug) return;
    chunkModeRef.current = showDebug;
    chunkRequests.invalidate();
    loadedChunkKeysRef.current.clear();
    if (!showDebug) {
      const visibleOnly = (chunks: StreamChunk[]) =>
        chunks.filter((chunk) => chunk.kind !== "thinking" && chunk.kind !== "raw");
      setHistoryPages((pages) =>
        pages.map((page) => ({
          ...page,
          chunksByMessage: Object.fromEntries(
            Object.entries(page.chunksByMessage).map(([id, chunks]) => [id, visibleOnly(chunks)]),
          ),
        })),
      );
      setSessionRows((rows) =>
        rows.map((row) => (row.chunks ? { ...row, chunks: visibleOnly(row.chunks) } : row)),
      );
      const visibleChunks = visibleOnly(liveChunksRef.current);
      liveChunksRef.current.splice(0, liveChunksRef.current.length, ...visibleChunks);
      liveToolIndexRef.current.clear();
      for (const [index, chunk] of liveChunksRef.current.entries()) {
        if (chunk.kind === "tool") liveToolIndexRef.current.set(chunk.id, index);
      }
      if (streamingRef.current) {
        setLiveRow((row) => (row ? { ...row, chunks: [...liveChunksRef.current] } : row));
      }
    }
  }, [chunkRequests, showDebug]);

  // Normal streaming deliberately drops provider-debug payloads. If the user
  // enables debug mid-turn, fetch one compact full snapshot and replay any
  // render events that arrived during that request. Mutating the active
  // reducer in place keeps the existing SSE connection and tool indexes valid.
  useEffect(() => {
    if (!showDebug || !streamingRef.current) return;
    const messageId = streamingMessageIdRef.current;
    if (!messageId) return;
    const capture = { messageId, events: [] as RenderEventFrame[] };
    debugReplayRef.current = capture;
    const controller = new AbortController();
    void getInFlightChatRender(instanceId, chatId, true, controller.signal)
      .then((snapshot) => {
        if (
          controller.signal.aborted ||
          debugReplayRef.current !== capture ||
          streamingMessageIdRef.current !== messageId ||
          snapshot?.messageId !== messageId
        ) {
          return;
        }
        replaceChunksFromSnapshot(
          liveChunksRef.current,
          liveToolIndexRef.current,
          snapshot.chunks,
          snapshot.lastSeq,
          capture.events,
        );
        if (visibleRef.current) {
          setLiveRow((row) => (row ? { ...row, chunks: [...liveChunksRef.current] } : row));
        } else hiddenLiveRenderDirtyRef.current = true;
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          console.warn(`[chat] live debug replay failed (chat=${chatId}):`, error);
        }
      })
      .finally(() => {
        if (debugReplayRef.current === capture) debugReplayRef.current = null;
      });
    return () => {
      controller.abort();
      if (debugReplayRef.current === capture) debugReplayRef.current = null;
    };
  }, [chatId, instanceId, showDebug]);

  const refreshBreakdown = useCallback(() => {
    setBreakdownLoading(true);
    setBreakdownError(null);
    getChatContextBreakdown(instanceId, chatId)
      .then(setBreakdown)
      .catch((err: unknown) => {
        setBreakdownError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setBreakdownLoading(false));
  }, [instanceId, chatId]);

  // rAF-coalesced scroll. The SSE parser fires events at the rate of
  // the model's token output (hundreds per second for codex), so calling
  // `scrollIntoView` per event forces a layout per event and starves
  // the renderer to the point where new tokens visibly stall on
  // screen. Coalescing collapses any number of requests within a
  // single frame to one scroll call.
  //
  // Pinning: non-forced calls (streaming deltas, commits) only scroll
  // while the user is at the bottom. Once they scroll up to read,
  // streaming stops yanking the viewport and the jump-to-bottom button
  // takes over. `force` (sending a message, the jump button) always
  // scrolls and re-pins. Scrolls are instant rather than smooth: a
  // smooth animation aims at the bottom's position at call time, which
  // is already stale by the time it finishes while content streams in.
  const scrollRafRef = useRef<number | null>(null);
  const scrollForceRef = useRef(false);
  const scrollFollowRef = useRef(false);
  const scrollFollowStartTopRef = useRef(0);
  const userScrollIntentUntilRef = useRef(0);
  const liveRenderRafRef = useRef<number | null>(null);
  const revealRafRef = useRef<number | null>(null);
  const scrollToBottom = useCallback((force = false) => {
    if (!visibleRef.current) {
      if (force) isPinnedRef.current = true;
      return;
    }
    if (force) scrollForceRef.current = true;
    else {
      if (!isPinnedRef.current) return;
      if (!scrollFollowRef.current) {
        scrollFollowStartTopRef.current = scrollContainerRef.current?.scrollTop ?? 0;
      }
      scrollFollowRef.current = true;
    }
    if (scrollRafRef.current !== null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const forced = scrollForceRef.current;
      const follow = scrollFollowRef.current;
      scrollForceRef.current = false;
      scrollFollowRef.current = false;
      if (!forced && !follow) return;
      isPinnedRef.current = true;
      setShowJump(false);
      bottomRef.current?.scrollIntoView();
    });
  }, []);

  const handleScroll = useCallback((event: ReactUIEvent<HTMLDivElement>) => {
    // Hidden layout and warm-up writes are not user intent. In particular, a
    // delayed scroll event from a stale offset must not turn a pinned pane
    // into an unpinned pane immediately before it is revealed.
    if (!visibleRef.current) return;
    const el = scrollContainerRef.current;
    if (!el) return;
    const pinned = el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_PIN_THRESHOLD_PX;
    const hasRecentUserIntent = performance.now() <= userScrollIntentUntilRef.current;
    const movedUpDuringFollow =
      scrollFollowRef.current && el.scrollTop < scrollFollowStartTopRef.current - 1;
    // Content growth can emit a native scroll before the queued bottom
    // correction, so an arbitrary unpinned scroll must not cancel follow.
    // Reader input and explicit upward movement do cancel it, including
    // keyboard, scrollbar, touch, and imperative scrolling.
    if (
      !scrollForceRef.current &&
      (!event.nativeEvent.isTrusted || hasRecentUserIntent || movedUpDuringFollow)
    ) {
      scrollFollowRef.current = false;
      if (scrollRafRef.current !== null) {
        cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
    }
    if (hasRecentUserIntent) userScrollIntentUntilRef.current = 0;
    isPinnedRef.current = pinned;
    setShowJump(!pinned);
  }, []);
  const handleUserScrollIntent = useCallback(() => {
    if (scrollForceRef.current) return;
    userScrollIntentUntilRef.current = performance.now() + 1_000;
    scrollFollowRef.current = false;
    if (scrollRafRef.current !== null) {
      cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = null;
    }
  }, []);
  const handleScrollKeyIntent = useCallback(
    (event: KeyboardEvent) => {
      if (!visibleRef.current) return;
      const target = event.target instanceof Element ? event.target : null;
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        target?.closest("input, textarea, select, button, a, [contenteditable='true']")
      ) {
        return;
      }
      if (
        event.key === "ArrowUp" ||
        event.key === "ArrowDown" ||
        event.key === "PageUp" ||
        event.key === "PageDown" ||
        event.key === "Home" ||
        event.key === "End" ||
        event.key === " "
      ) {
        handleUserScrollIntent();
      }
    },
    [handleUserScrollIntent],
  );
  useEffect(() => {
    document.addEventListener("keydown", handleScrollKeyIntent);
    return () => document.removeEventListener("keydown", handleScrollKeyIntent);
  }, [handleScrollKeyIntent]);
  const handlePointerScrollIntent = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.pointerType !== "mouse") return;
      const element = event.currentTarget;
      const bounds = element.getBoundingClientRect();
      const scrollbarWidth = Math.max(12, element.offsetWidth - element.clientWidth);
      if (event.clientX >= bounds.right - scrollbarWidth - 2) handleUserScrollIntent();
    },
    [handleUserScrollIntent],
  );
  // Cleanup on unmount to avoid the rare case where the rAF callback
  // fires after the component is gone and the ref is stale-null.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (scrollRafRef.current !== null) {
        cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
      scrollForceRef.current = false;
      scrollFollowRef.current = false;
      userScrollIntentUntilRef.current = 0;
      if (liveRenderRafRef.current !== null) {
        cancelAnimationFrame(liveRenderRafRef.current);
        liveRenderRafRef.current = null;
      }
      if (revealRafRef.current !== null) {
        cancelAnimationFrame(revealRafRef.current);
        revealRafRef.current = null;
      }
      chunkRequests.invalidate();
      toolDetailRequestGeneration.invalidate();
      transcriptRequests.invalidate();
      // Release the in-flight stream's HTTP connection on unmount.
      // Switching chats/instances unmounts this component, and a stream that
      // is never aborted keeps its fetch (an open connection to the local
      // server) alive for the whole turn, and the resume on switch-back
      // opens another. Because the server is plain HTTP/1.1 on loopback,
      // these pile up against the webview's per-origin connection cap, and
      // once it's hit, every other request (including the next chat's
      // history load) blocks, so the view renders empty until a turn ends
      // and frees a slot. Aborting here is a client *disconnect*, not a
      // cancel: the hub keeps the producer running through its no-
      // subscriber grace window (see ChatStreamHub) and a remount resumes
      // it via the hydration -> attachResume path, so the agent keeps
      // working in the background and reattaches seamlessly on return.
      //
      // Deferred to a microtask so React StrictMode's dev-only
      // mount -> unmount -> mount probe (which re-runs this effect
      // synchronously) flips mountedRef back to true before the abort can
      // fire, leaving the live stream untouched. A real unmount never
      // re-mounts, so the abort lands.
      const ac = abortRef.current;
      if (ac) {
        queueMicrotask(() => {
          if (!mountedRef.current) ac.abort();
        });
      }
    };
  }, [chunkRequests, toolDetailRequestGeneration, transcriptRequests]);

  // The composer floats over the scroll container so the scrollbar runs the
  // full height of the pane instead of stopping above the message box. Its
  // height is dynamic (the textarea auto-grows), so we measure it and pad the
  // scroll content by the same amount, so scrolled fully down, the last message
  // sits just above the box rather than hidden behind it. The padding lives
  // on the inner content wrapper, not the scroll container: Firefox drops
  // end-side padding on overflow containers.
  const composerRef = useRef<HTMLDivElement>(null);
  const [composerHeight, setComposerHeight] = useState(72);
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    const measure = () => {
      setComposerHeight(el.offsetHeight);
      // A growing composer (multiline draft) shifts the bottom edge down, so
      // keep the viewport pinned to the tail if the user was there.
      scrollToBottom();
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [scrollToBottom]);

  // One bounded view response carries the tail, structural chunks, and any
  // in-flight snapshot. The active chat hydrates immediately. Hidden chats
  // warm during idle time and keep the resulting DOM for instant switching.
  useEffect(() => {
    if (pending || initialMessage || hydratedRef.current) return;
    const generation = invalidateTranscriptRequests();
    const ac = transcriptRequests.createController();
    let cancelScheduled: (() => void) | null = null;
    const hydrate = async () => {
      try {
        // Cold transcript pages are always the bounded normal projection.
        // Debug mode deliberately fills full structural data afterward in
        // focused batches, so one raw provider payload cannot block first
        // paint or inflate every hidden chat's warm state.
        const page = await listChatTranscript(instanceId, chatId, { signal: ac.signal });
        if (!transcriptRequests.accepts(generation, ac)) return;
        hydratedRef.current = true;
        pinNextCommitToBottom();
        setHistoryPages([
          {
            key: pageKey(page.messages, "tail"),
            messages: page.messages,
            chunksByMessage: chunksFromPage(page),
          },
        ]);
        for (const message of page.messages) {
          if (message.role === "assistant") {
            loadedChunkKeysRef.current.add(`normal:${message.id}`);
          }
        }
        setSessionRows([]);
        setHasOlder(page.hasMore);
        setActiveLeaf(page.messages.at(-1)?.id ?? chatRef.current.activeLeafId ?? null);
        if (transcriptRequests.accepts(generation, ac) && page.inFlight) {
          attachResume(page.inFlight.messageId, page.inFlight.lastSeq, page.inFlight.chunks);
        }
      } catch (err) {
        // Aborts are routine (chat switch, unmount). Anything else is
        // a real failure to hydrate, so log it so a server-side issue
        // doesn't masquerade as an empty chat.
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (ac.signal.aborted) return;
        console.warn(`[chat] hydration failed (chat=${chatId}):`, err);
      } finally {
        transcriptRequests.release(ac);
      }
    };
    if (visible) {
      void hydrate();
    } else {
      cancelScheduled = scheduleIdleWork(hydrate);
    }
    return () => {
      cancelScheduled?.();
      ac.abort();
      transcriptRequests.release(ac);
    };
    // attachResume is stable (defined as ref-using callback below), and we
    // exclude it from deps to avoid re-running the fetch on every
    // re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    pending,
    initialMessage,
    instanceId,
    chatId,
    visible,
    invalidateTranscriptRequests,
    pinNextCommitToBottom,
    setActiveLeaf,
  ]);

  useLayoutEffect(() => {
    const wasVisible = previousVisibleRef.current;
    previousVisibleRef.current = visible;
    if (!visible) {
      if (wasVisible) {
        retainedPinnedRef.current = isPinnedRef.current;
        if (!isPinnedRef.current) messageHistoryRef.current?.captureRetainedAnchor();
        // A reveal rAF can be canceled by the subsequent stream detach before
        // it observes hidden visibility. Mark the canonical target dirty in
        // this commit so the next hot reveal uses it on its first frame.
        if (liveRowRef.current) hiddenLiveRenderDirtyRef.current = true;
      }
      return;
    }
    if (hotSwitchLiveChunks) {
      hiddenLiveRenderDirtyRef.current = false;
      setLiveRow((row) => (row ? { ...row, chunks: hotSwitchLiveChunks } : row));
    }
    const pinned = wasVisible ? isPinnedRef.current : retainedPinnedRef.current;
    isPinnedRef.current = pinned;
    if (!pinned) {
      messageHistoryRef.current?.restoreRetainedAnchor();
      return;
    }
    // The parent reveals this retained pane in the same commit. Position it
    // synchronously so the browser cannot paint scrollTop=0 and repair it on
    // a later animation frame. Ordinary streaming still uses scrollToBottom's
    // coalesced rAF path.
    positionAtBottom();
  }, [hotSwitchLiveChunks, positionAtBottom, visible]);

  const loadOlderMessages = useCallback(() => {
    if (loadingOlderRef.current || !hasOlder) return;
    const before = messages[0]?.id;
    if (!before) return;
    const generation = transcriptRequests.current;
    const controller = transcriptRequests.createController();
    loadingOlderRef.current = true;
    void listChatTranscript(instanceId, chatId, { before, signal: controller.signal })
      .then((page) => {
        if (!transcriptRequests.accepts(generation, controller)) return;
        if (messages[0]?.id !== before) return;
        messageHistoryRef.current?.capturePrependAnchor();
        setHistoryPages((current) => {
          if (current[0]?.messages[0]?.id !== before) return current;
          const known = new Set(
            current.flatMap((entry) => entry.messages.map((message) => message.id)),
          );
          const older = page.messages.filter((message) => !known.has(message.id));
          if (older.length === 0) return current;
          return [
            {
              key: pageKey(older, `older-${before}`),
              messages: older,
              chunksByMessage: chunksFromPage(page),
            },
            ...current,
          ];
        });
        setHasOlder(page.hasMore);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof DOMException && error.name === "AbortError") return;
        console.warn(`[chat] older transcript page failed (chat=${chatId}):`, error);
      })
      .finally(() => {
        transcriptRequests.release(controller);
        if (transcriptRequests.current === generation) loadingOlderRef.current = false;
      });
  }, [chatId, hasOlder, instanceId, messages, transcriptRequests]);

  const loadAssistantChunks = useCallback(
    (messageIds: string[]) => {
      const generation = chunkRequests.current;
      const includeDebug = showDebug;
      const missing = messageIds.filter((messageId) => {
        const key = `${includeDebug ? "debug" : "normal"}:${messageId}`;
        if (loadedChunkKeysRef.current.has(key)) return false;
        loadedChunkKeysRef.current.add(key);
        return true;
      });
      if (missing.length === 0) return;
      for (let start = 0; start < missing.length; start += 64) {
        const batch = missing.slice(start, start + 64);
        const controller = chunkRequests.createController();
        void listChatRenderChunks(instanceId, chatId, batch, includeDebug, controller.signal)
          .then(({ chunksByMessage }) => {
            if (
              !chunkRequests.accepts(generation, controller) ||
              chunkModeRef.current !== includeDebug
            ) {
              return;
            }
            const populated = Object.fromEntries(
              Object.entries(chunksByMessage).filter(([, chunks]) => chunks.length > 0),
            ) as Record<string, StreamChunk[]>;
            if (Object.keys(populated).length > 0) {
              setHistoryPages((pages) =>
                pages.map((page) => {
                  const relevant: Record<string, StreamChunk[]> = {};
                  for (const message of page.messages) {
                    const chunks = populated[message.id];
                    if (chunks) relevant[message.id] = chunks;
                  }
                  return Object.keys(relevant).length === 0
                    ? page
                    : { ...page, chunksByMessage: { ...page.chunksByMessage, ...relevant } };
                }),
              );
              setSessionRows((rows) =>
                rows.map((row) => {
                  const chunks = populated[row.message.id];
                  return chunks ? { ...row, chunks } : row;
                }),
              );
            }
          })
          .catch((error: unknown) => {
            if (controller.signal.aborted) return;
            if (error instanceof DOMException && error.name === "AbortError") return;
            if (chunkRequests.current === generation) {
              for (const messageId of batch) {
                loadedChunkKeysRef.current.delete(
                  `${includeDebug ? "debug" : "normal"}:${messageId}`,
                );
              }
            }
            console.warn(`[chat] visible render chunks failed (chat=${chatId}):`, error);
          })
          .finally(() => {
            chunkRequests.release(controller);
          });
      }
    },
    [chatId, chunkRequests, instanceId, showDebug],
  );

  useEffect(() => {
    if (!visible || !showDebug) return;
    const ids = [
      ...historyPages.flatMap((page) =>
        page.messages
          .filter((message) => message.role === "assistant")
          .map((message) => message.id),
      ),
      ...sessionRows.filter((row) => row.message.role === "assistant").map((row) => row.message.id),
    ];
    loadAssistantChunks(ids);
  }, [historyPages, loadAssistantChunks, sessionRows, showDebug, visible]);

  const loadToolDetails = useCallback(
    (messageId: string, toolId: string) => {
      const key = `details:${messageId}:${toolId}`;
      const applyDetails = (fetched: StreamChunk[]): { matched: boolean; complete: boolean } => {
        let matched = false;
        let complete = true;
        const inspect = (current: StreamChunk[]) => {
          const result = mergeToolDetails([...current], fetched, toolId);
          if (result.matched) {
            matched = true;
            complete = complete && result.complete;
          }
        };
        if (streamingMessageIdRef.current === messageId) inspect(liveChunksRef.current);
        for (const page of historyPagesRef.current) {
          const current = page.chunksByMessage[messageId];
          if (current) inspect(current);
        }
        for (const row of sessionRowsRef.current) {
          if (row.message.id === messageId && row.chunks) inspect(row.chunks);
        }
        const result = { matched, complete: matched && complete };
        if (streamingMessageIdRef.current === messageId) {
          const liveMerge = mergeToolDetails(liveChunksRef.current, fetched, toolId);
          if (liveMerge.changed) {
            if (visibleRef.current) {
              setLiveRow((row) => (row ? { ...row, chunks: [...liveChunksRef.current] } : row));
            } else hiddenLiveRenderDirtyRef.current = true;
          }
        }
        setHistoryPages((pages) => {
          let changed = false;
          const nextPages = pages.map((page) => {
            const current = page.chunksByMessage[messageId];
            if (!current) return page;
            const next = [...current];
            if (!mergeToolDetails(next, fetched, toolId).changed) return page;
            changed = true;
            return { ...page, chunksByMessage: { ...page.chunksByMessage, [messageId]: next } };
          });
          return changed ? nextPages : pages;
        });
        setSessionRows((rows) => {
          let changed = false;
          const nextRows = rows.map((row) => {
            if (row.message.id !== messageId || !row.chunks) return row;
            const next = [...row.chunks];
            if (!mergeToolDetails(next, fetched, toolId).changed) return row;
            changed = true;
            return { ...row, chunks: next };
          });
          return changed ? nextRows : rows;
        });
        return result;
      };
      const cached = toolDetailsCacheRef.current.get(key);
      if (cached && applyDetails(cached).complete) return;
      if (toolDetailRequestsRef.current.has(key)) return;
      toolDetailRequestsRef.current.add(key);
      const generation = toolDetailRequestGeneration.current;
      const controller = toolDetailRequestGeneration.createController();
      void getChatToolDetails(instanceId, chatId, messageId, toolId, controller.signal)
        .then(({ chunksByMessage }) => {
          if (!toolDetailRequestGeneration.accepts(generation, controller)) return;
          const chunks = chunksByMessage[messageId];
          if (!chunks || chunks.length === 0) return;
          toolDetailsCacheRef.current.set(key, chunks);
          applyDetails(chunks);
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          if (error instanceof DOMException && error.name === "AbortError") return;
          console.warn(`[chat] tool details failed (chat=${chatId} msg=${messageId}):`, error);
        })
        .finally(() => {
          toolDetailRequestsRef.current.delete(key);
          toolDetailRequestGeneration.release(controller);
        });
    },
    [chatId, instanceId, toolDetailRequestGeneration],
  );

  // A newly created, hydrated chat has no provider session or transcript to
  // lose, so its composer can choose from the full catalog. Once the first
  // turn starts, keep model changes within that chat's current provider.
  const isFreshChat = hydratedRef.current && messages.length === 0 && !streaming;

  const applyModelChange = useCallback(
    async (body: UpdateChatBody) => {
      // Keep the existing usage/cost snapshot visible across model and effort
      // changes. Claude applies both to the live process before the next turn,
      // so the accumulated cost remains valid. The next turn replaces the last
      // context-window reading with one for the new configuration.
      const updated = await updateChatModel(instanceId, chatId, body).catch((err: unknown) => {
        // PATCH failure leaves the picker showing the user's intended
        // value, but the next turn will use the server's older config.
        // Logging keeps that desync diagnosable. If it bites us in
        // practice we should also surface a toast.
        console.warn(`[chat] updateChatModel failed (chat=${chatId}):`, err);
        return null;
      });
      if (updated) {
        appliedModelRef.current = updated.model;
        appliedEffortRef.current = updated.effort;
        setCurrentModel(updated.model);
        setCurrentEffort(updated.effort);
      }
    },
    [instanceId, chatId],
  );

  const handleModelChange = useCallback(
    (newModel: string) => {
      setCurrentModel(newModel);
      // Clamp local effort against the new model's menu so the picker stays
      // consistent even when we defer the PATCH (the server applies the same
      // clamp on apply).
      const def = chatModels.find((m) => m.id === newModel);
      if (def && !def.supportedEfforts.includes(currentEffort)) {
        setCurrentEffort(def.defaultEffort);
      }
      if (isFreshChat) writeLastModelId(newModel);
      if (!streaming) void applyModelChange({ model: newModel });
    },
    [streaming, chatModels, currentEffort, isFreshChat, applyModelChange],
  );

  const handleEffortChange = useCallback(
    (next: ChatEffort) => {
      setCurrentEffort(next);
      if (isFreshChat) writeLastEffort(next);
      if (!streaming) void applyModelChange({ effort: next });
    },
    [streaming, isFreshChat, applyModelChange],
  );

  // Drives one streaming turn from `runChatTurn` (or `resumeChatTurn`).
  // Owns the local chunk-reduction state for the active turn and
  // commits it on a terminal event. The `existingChunks` argument lets
  // a resume call pre-seed the reducer with what we replayed on mount.
  const drainTurn = useCallback(
    async (
      ac: AbortController,
      existingChunks: StreamChunk[] | null,
      runner: (onEvent: (ev: ChatTurnEvent) => void) => Promise<void>,
    ) => {
      const chunks: StreamChunk[] = existingChunks ? [...existingChunks] : [];
      liveChunksRef.current = chunks;
      hiddenLiveRenderDirtyRef.current = false;
      const toolIndex = new Map<string, number>();
      liveToolIndexRef.current = toolIndex;
      // Rebuild toolIndex from any pre-seeded chunks so a resume can
      // patch the same tool entry the live stream was about to update.
      for (const [i, c] of chunks.entries()) {
        if (c.kind === "tool") toolIndex.set(c.id, i);
      }
      let serverMessageId: string | null = null;
      const snapshotState: {
        message: Extract<ChatTurnEvent, { kind: "snapshot" }>["snapshot"]["message"];
      } = { message: null };
      // Idempotency guard: ignore events we've already applied. The
      // server suppresses them via afterSeq on resume, but a buggy
      // backend or a duplicated frame shouldn't render twice.
      let lastSeq = existingChunks ? liveLastSeqRef.current : -1;
      // Tracks whether onEvent saw a terminal event (done OR error)
      // from the server. If the runner returns without firing one
      // (caller aborted between events, server protocol failure),
      // we surface a fallback message ourselves below. Otherwise
      // the UI would be stuck with a streaming bubble that has no
      // terminal state. NOT just a "successfully committed" flag:
      // an error event with no partial chunks also counts, so the
      // fallback path doesn't add a second error message on top of
      // the one the error handler already rendered.
      let terminalHandled = false;
      let revealed = revealableLength(chunks);
      let pendingCommit: (() => void) | null = null;
      let finishingDrain: Promise<void> | null = null;
      let previousRevealTimestamp: number | null = null;
      let queuedLiveChunks: StreamChunk[] | null = null;
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

      // Provider events mutate the canonical reducer immediately. Only output
      // received while this chat and the app are visible is revealed at a
      // readable character cadence. A hidden chat, a backgrounded app, or a
      // resume snapshot catches up immediately so old output is never replayed
      // as an animation when the user returns.
      if (liveRenderRafRef.current !== null) {
        cancelAnimationFrame(liveRenderRafRef.current);
        liveRenderRafRef.current = null;
      }
      if (revealRafRef.current !== null) {
        cancelAnimationFrame(revealRafRef.current);
        revealRafRef.current = null;
      }
      const cancelLiveRender = () => {
        if (liveRenderRafRef.current === null) return;
        cancelAnimationFrame(liveRenderRafRef.current);
        liveRenderRafRef.current = null;
        queuedLiveChunks = null;
      };
      const cancelReveal = () => {
        if (revealRafRef.current === null) return;
        cancelAnimationFrame(revealRafRef.current);
        revealRafRef.current = null;
        previousRevealTimestamp = null;
      };
      const canRenderLive = () => visibleRef.current && document.visibilityState === "visible";
      const canAnimateLive = () => canRenderLive() && !reduceMotion;
      const renderLive = (renderedChunks: StreamChunk[]) => {
        if (!canRenderLive()) {
          hiddenLiveRenderDirtyRef.current = true;
          return;
        }
        hiddenLiveRenderDirtyRef.current = false;
        setLiveRow((row) => (row ? { ...row, chunks: renderedChunks } : row));
        scrollToBottom();
      };
      const queueLiveRender = (renderedChunks: StreamChunk[]) => {
        if (!canRenderLive()) {
          hiddenLiveRenderDirtyRef.current = true;
          return;
        }
        queuedLiveChunks = renderedChunks;
        if (liveRenderRafRef.current !== null) return;
        liveRenderRafRef.current = requestAnimationFrame(() => {
          liveRenderRafRef.current = null;
          const queued = queuedLiveChunks;
          queuedLiveChunks = null;
          if (queued) renderLive(queued);
        });
      };
      const finishPendingCommit = () => {
        const finish = pendingCommit;
        pendingCommit = null;
        finish?.();
      };
      const settleRevealWithoutAnimation = (publish: boolean) => {
        cancelReveal();
        revealed = revealableLength(chunks);
        if (publish) queueLiveRender([...chunks]);
        else hiddenLiveRenderDirtyRef.current = true;
        finishPendingCommit();
      };
      const pumpReveal = () => {
        if (revealRafRef.current !== null) return;
        cancelLiveRender();
        const step = (timestamp: number) => {
          revealRafRef.current = null;
          if (!canAnimateLive()) {
            settleRevealWithoutAnimation(canRenderLive());
            return;
          }
          const target = revealableLength(chunks);
          if (revealed < target) {
            const elapsed =
              previousRevealTimestamp === null
                ? 16
                : Math.min(64, timestamp - previousRevealTimestamp);
            previousRevealTimestamp = timestamp;
            const backlog = target - revealed;
            const charactersPerSecond =
              backlog > REVEAL_LAG_CHARACTERS
                ? Math.min(
                    REVEAL_MAX_CHARACTERS_PER_SECOND,
                    REVEAL_CHARACTERS_PER_SECOND +
                      (backlog - REVEAL_LAG_CHARACTERS) / REVEAL_CATCHUP_SECONDS,
                  )
                : REVEAL_CHARACTERS_PER_SECOND;
            revealed = Math.min(
              target,
              revealed + Math.max(1, Math.round((charactersPerSecond * elapsed) / 1000)),
            );
            renderLive(revealChunks(chunks, revealed));
          }
          if (revealed < target) {
            revealRafRef.current = requestAnimationFrame(step);
          } else {
            previousRevealTimestamp = null;
            finishPendingCommit();
          }
        };
        revealRafRef.current = requestAnimationFrame(step);
      };
      const finishThenCommit = (commit: () => void): Promise<void> => {
        if (!canAnimateLive() || revealed >= revealableLength(chunks)) {
          revealed = revealableLength(chunks);
          commit();
          return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
          const finish = () => {
            ac.signal.removeEventListener("abort", onAbort);
            commit();
            resolve();
          };
          const onAbort = () => {
            cancelReveal();
            finish();
          };
          pendingCommit = finish;
          ac.signal.addEventListener("abort", onAbort, { once: true });
          pumpReveal();
        });
      };
      const handleVisibilityChange = () => {
        if (document.visibilityState !== "visible") {
          settleRevealWithoutAnimation(false);
          return;
        }
        if (visibleRef.current && hiddenLiveRenderDirtyRef.current) {
          revealed = revealableLength(chunks);
          queueLiveRender([...chunks]);
        }
      };
      document.addEventListener("visibilitychange", handleVisibilityChange);
      const discardLiveRow = () => {
        cancelLiveRender();
        cancelReveal();
        pendingCommit = null;
        setLiveRow(null);
        liveRenderKeyRef.current = null;
        liveChunksRef.current = [];
        liveToolIndexRef.current = new Map();
        hiddenLiveRenderDirtyRef.current = false;
      };
      const accumulatedContent = () =>
        chunks
          .filter((chunk): chunk is Extract<StreamChunk, { kind: "text" }> => chunk.kind === "text")
          .map((chunk) => chunk.text)
          .join("");

      const applyMetaEvent = (type: string, payload: unknown): boolean => {
        if (type === "usage") {
          const usagePayload = payload as {
            last: TokenUsage;
            total: TokenUsage;
            modelContextWindow?: number;
            costUsd?: number;
            subscriptionShare?: SubscriptionShare;
          };
          setUsage((prev) => ({
            last: usagePayload.last,
            total: usagePayload.total,
            modelContextWindow: usagePayload.modelContextWindow,
            costUsd: usagePayload.costUsd,
            subscriptionShare: usagePayload.subscriptionShare,
            compacted: prev?.compacted,
          }));
          return true;
        }
        if (type === "title") {
          const title = typeof payload === "string" ? payload : String(payload ?? "");
          onTitle?.(title);
          return true;
        }
        if (type === "context_compacted") {
          setUsage((prev) => (prev ? { ...prev, compacted: true } : prev));
          return true;
        }
        return false;
      };

      const commit = (id: string, content: string) => {
        cancelLiveRender();
        cancelReveal();
        pendingCommit = null;
        terminalHandled = true;
        const msg: TranscriptMessage = snapshotState.message
          ? { ...snapshotState.message, version: null }
          : {
              id,
              chatId,
              role: "assistant",
              // The assistant message replies to the turn's user message. For a
              // resumed turn (no turnUserIdRef) that message is the visible
              // branch's tip: the leaf advanced onto it at turn start and the
              // tip derivation descends to it even from a stale leaf.
              parentId: turnUserIdRef.current ?? activeLeafRef.current ?? tipIdRef.current,
              content,
              createdAt: new Date(),
              version: null,
            };
        setSessionRows((rows) => {
          // Skip duplicate commits when a resume races with the committed row.
          if (rows.some((row) => row.message.id === msg.id)) return rows;
          return [
            ...rows,
            {
              renderKey: liveRenderKeyRef.current ?? msg.id,
              message: msg,
              chunks: [...chunks],
            },
          ];
        });
        setActiveLeaf(id);
        setLiveRow(null);
        liveRenderKeyRef.current = null;
        liveChunksRef.current = [];
        liveToolIndexRef.current = new Map();
        debugReplayRef.current = null;
        hiddenLiveRenderDirtyRef.current = false;
        scrollToBottom();
      };

      // Append a client-only assistant error bubble at the tip of the
      // visible branch (and advance the leaf so it stays visible).
      const appendErrorBubble = (content: string) => {
        const errMsg: TranscriptMessage = {
          id: `err-${crypto.randomUUID()}`,
          chatId,
          role: "assistant",
          parentId: activeLeafRef.current,
          content,
          createdAt: new Date(),
          version: null,
        };
        setSessionRows((rows) => [...rows, { renderKey: errMsg.id, message: errMsg }]);
        setActiveLeaf(errMsg.id);
      };

      const onEvent = (ev: ChatTurnEvent) => {
        if (ev.kind === "message_id") {
          serverMessageId = ev.messageId;
          streamingMessageIdRef.current = ev.messageId;
          setLiveRow((current) => (current ? { ...current, messageId: ev.messageId } : current));
          // Re-key any pre-seeded chunks under the canonical id so a
          // resume that landed before message_id still rendered into
          // the right bubble.
          return;
        }
        if (ev.kind === "snapshot") {
          serverMessageId = ev.snapshot.messageId;
          streamingMessageIdRef.current = ev.snapshot.messageId;
          lastSeq = ev.snapshot.lastSeq;
          liveLastSeqRef.current = lastSeq;
          snapshotState.message = ev.snapshot.message;
          for (const metaEvent of ev.snapshot.metaEvents) {
            applyMetaEvent(metaEvent.type, metaEvent.payload);
          }
          const snapshotChunks = [...ev.snapshot.chunks];
          if (
            snapshotChunks.length === 0 &&
            ev.snapshot.message?.content &&
            ev.snapshot.message.content.length > 0
          ) {
            snapshotChunks.push({ kind: "text", text: ev.snapshot.message.content });
          }
          replaceChunksFromSnapshot(chunks, toolIndex, snapshotChunks, ev.snapshot.lastSeq, []);
          cancelReveal();
          revealed = revealableLength(chunks);
          setLiveRow((current) =>
            current ? { ...current, messageId: ev.snapshot.messageId } : current,
          );
          queueLiveRender([...chunks]);
          return;
        }
        if (ev.kind === "user_message") {
          // The persisted user-message row: swap it in for our optimistic
          // bubble so the ids the tree navigates by are the server's.
          const pendingId = pendingUserIdRef.current;
          pendingUserIdRef.current = null;
          const serverMsg = ev.message;
          turnUserIdRef.current = serverMsg.id;
          setSessionRows((rows) => {
            const idx = pendingId ? rows.findIndex((row) => row.message.id === pendingId) : -1;
            if (idx >= 0) {
              const next = [...rows];
              const row = next[idx];
              if (!row) return rows;
              next[idx] = {
                ...row,
                message: { ...serverMsg, version: row.message.version ?? null },
              };
              return next;
            }
            if (rows.some((row) => row.message.id === serverMsg.id)) return rows;
            return [
              ...rows,
              {
                renderKey: serverMsg.id,
                message: { ...serverMsg, version: null },
              },
            ];
          });
          setLiveRow((current) => (current ? { ...current, parentId: serverMsg.id } : current));
          if (activeLeafRef.current === pendingId || activeLeafRef.current === null) {
            setActiveLeaf(serverMsg.id);
          }
          return;
        }
        if (ev.kind === "done") {
          const id = serverMessageId ?? crypto.randomUUID();
          finishingDrain = finishThenCommit(() =>
            commit(id, snapshotState.message?.content ?? accumulatedContent()),
          );
          streamingMessageIdRef.current = null;
          return;
        }
        if (ev.kind === "error") {
          // Cancel is signalled as { kind: "error" } from the hub
          // (the producer's AbortSignal got tripped). We treat the
          // partial output as a real (stopped) message rather than a
          // red error bubble, matching the previous semantics.
          const isCancel = ac.signal.aborted || /aborted|cancelled|canceled/i.test(ev.message);
          // Whatever chunks made it before the error were already
          // streamed to the user AND persisted to chat_events. If we
          // drop them now, a refresh resurrects them via the
          // crash-recovery backfill, so the UI flickers an empty
          // assistant slot then fills in on reload. Commit them
          // either way so the live and post-refresh views agree.
          if (chunks.length > 0 || snapshotState.message) {
            const id = serverMessageId ?? crypto.randomUUID();
            commit(id, snapshotState.message?.content ?? accumulatedContent());
          } else {
            terminalHandled = true;
            discardLiveRow();
          }
          if (!isCancel) {
            // Real failures (CLI exit code, upstream API error, …)
            // get an additional error bubble after the partial so
            // the cause is visible. Cancellations don't, since the
            // partial alone matches the "stopped" semantics.
            appendErrorBubble(`Error: ${ev.message}`);
            scrollToBottom();
          }
          streamingMessageIdRef.current = null;
          return;
        }
        // ev.kind === "event"
        if (ev.seq >= 0 && ev.seq <= lastSeq) return;
        if (ev.seq >= 0) {
          lastSeq = ev.seq;
          liveLastSeqRef.current = lastSeq;
        }
        // Meta events that don't produce chunks but update other UI.
        if (applyMetaEvent(ev.type, ev.payload)) return;
        // Chunk-producing events flow through the shared reducer so
        // mount-time replay and live streaming end up with byte-for-
        // byte identical chunks.
        if (
          ev.type === "delta" ||
          ev.type === "thinking_start" ||
          ev.type === "thinking_delta" ||
          ev.type === "thinking_tokens" ||
          ev.type === "thinking_done" ||
          ev.type === "thinking" ||
          ev.type === "tool_call_start" ||
          ev.type === "tool_call_input" ||
          ev.type === "tool_call_result" ||
          ev.type === "api_retry" ||
          ev.type === "raw"
        ) {
          const debugReplay = debugReplayRef.current;
          if (debugReplay?.messageId === streamingMessageIdRef.current) {
            debugReplay.events.push(ev);
          }
          if ((ev.type === "thinking" || ev.type === "raw") && !showDebugRef.current) return;
          applyEvent(chunks, toolIndex, ev.type, ev.payload);
          if (
            ev.type === "delta" ||
            ev.type === "thinking_delta" ||
            ev.type === "thinking_done" ||
            ev.type === "thinking"
          ) {
            if (canAnimateLive()) pumpReveal();
            else settleRevealWithoutAnimation(canRenderLive());
          } else if (revealRafRef.current === null) {
            queueLiveRender(revealChunks(chunks, revealed));
          }
          return;
        }
        // Unknown event type, so surface as a raw debug chunk rather
        // than dropping silently.
        console.warn(`[chat] unknown SSE event '${ev.type}'`, ev.payload);
        chunks.push({
          kind: "raw",
          source: "claude",
          label: `unknown sse: ${ev.type}`,
          payload: ev.payload,
        });
        if (revealRafRef.current === null) {
          queueLiveRender(revealChunks(chunks, revealed));
        }
      };

      try {
        try {
          await runner(onEvent);
        } catch (err) {
          if (detachedControllersRef.current.has(ac)) return;
          if (ac.signal.aborted) {
            // Local abort (Stop button / unmount). Commit partial.
            if (!terminalHandled && (chunks.length > 0 || snapshotState.message)) {
              const id = serverMessageId ?? crypto.randomUUID();
              commit(id, snapshotState.message?.content ?? accumulatedContent());
            } else if (!terminalHandled) {
              discardLiveRow();
            }
            return;
          }
          appendErrorBubble(`Error: ${err instanceof Error ? err.message : String(err)}`);
          discardLiveRow();
          scrollToBottom();
          return;
        }

        if (finishingDrain) await finishingDrain;

        // Runner returned without throwing AND without firing a
        // terminal onEvent. Two cases:
        //   1. Outer-signal abort (user hit Stop, component unmounted):
        //      treat as a cancelled partial, same as a hub-emitted
        //      `error: aborted`.
        //   2. Anything else: the runner exited without telling us why.
        //      That's a bug or a server protocol failure, so surface it as
        //      a visible error so the user knows the chat didn't
        //      complete normally.
        if (!terminalHandled) {
          if (detachedControllersRef.current.has(ac)) return;
          if (ac.signal.aborted) {
            if (chunks.length > 0 || snapshotState.message) {
              const id = serverMessageId ?? crypto.randomUUID();
              commit(id, snapshotState.message?.content ?? accumulatedContent());
            } else {
              discardLiveRow();
            }
          } else {
            console.warn(
              `[chat] runner exited without terminal event (chat=${chatId} msg=${serverMessageId})`,
            );
            appendErrorBubble(
              "Error: stream ended without a completion signal, and " +
                "the server may have dropped the connection. " +
                "Reload to see any partial output that was persisted.",
            );
            discardLiveRow();
            scrollToBottom();
          }
        }
      } finally {
        document.removeEventListener("visibilitychange", handleVisibilityChange);
        cancelLiveRender();
        cancelReveal();
      }
    },
    [chatId, scrollToBottom, onTitle, setActiveLeaf],
  );

  const sendMessage = useCallback(
    async (override?: string, force = false, overrideUploadIds?: string[]) => {
      const content = (override ?? input).trim();
      // For a normal send, await any in-flight composer uploads and collect
      // their ids. For a bootstrap/override send (the new-chat first message),
      // the ids were resolved in the empty-state pane and passed in directly.
      const uploads = override === undefined ? await attachments.resolveUploads() : [];
      const uploadIds =
        override === undefined ? uploads.map((u) => u.id) : (overrideUploadIds ?? []);
      if (!content && uploadIds.length === 0) return;
      // `force` bypasses the streaming guard for the bootstrap re-entry where
      // the optimistic state already has `streaming=true` from the useState
      // initializer.
      if ((streaming || navigatingBranchRef.current) && !force) return;

      invalidateTranscriptRequests();

      if (override === undefined) {
        setInput("");
        attachments.clear();
      }
      setStreaming(true);
      liveLastSeqRef.current = -1;

      // Flush any model/effort change the user made while the previous turn
      // was still streaming. Picker edits are local-only mid-turn and apply
      // here, just before the new turn kicks off.
      if (currentModel !== appliedModelRef.current || currentEffort !== appliedEffortRef.current) {
        const body: UpdateChatBody = {};
        if (currentModel !== appliedModelRef.current) body.model = currentModel;
        if (currentEffort !== appliedEffortRef.current) body.effort = currentEffort;
        await applyModelChange(body);
      }

      // Optimistic user bubble at the tip of the visible branch. The server's
      // `user_message` frame swaps in the real row (id + parent) once the
      // POST lands. If the parent bootstrapped us with this same message as
      // an optimistic bubble, reuse it instead of duplicating.
      const last = messages[messages.length - 1];
      const reuseBootstrap = last?.role === "user" && last.content === content;
      const optimisticId = reuseBootstrap ? last.id : crypto.randomUUID();
      pendingUserIdRef.current = optimisticId;
      turnUserIdRef.current = optimisticId;
      const renderKey = liveRenderKeyRef.current ?? `live-${crypto.randomUUID()}`;
      liveRenderKeyRef.current = renderKey;
      pinNextCommitToBottom();
      setLiveRow({ renderKey, messageId: null, parentId: optimisticId, chunks: [] });
      if (!reuseBootstrap) {
        const optimistic: TranscriptMessage = {
          id: optimisticId,
          chatId,
          role: "user",
          content,
          parentId: tipIdRef.current,
          // Already uploaded, so previews resolve before the server swaps in
          // the persisted user message.
          uploads: uploads.length > 0 ? uploads : undefined,
          createdAt: new Date(),
          version: null,
        };
        setSessionRows((rows) => [...rows, { renderKey: optimistic.id, message: optimistic }]);
      }
      setActiveLeaf(optimisticId);

      const ac = new AbortController();
      abortRef.current = ac;
      try {
        await drainTurn(ac, null, (onEvent) =>
          runChatTurn({
            apiBase: API_BASE,
            instanceId,
            chatId,
            content,
            uploadIds,
            includeDebug: showDebugRef.current,
            onEvent,
            signal: ac.signal,
          }),
        );
      } finally {
        if (abortRef.current === ac) abortRef.current = null;
        if (!detachedControllersRef.current.has(ac)) setStreaming(false);
      }
    },
    [
      input,
      attachments,
      streaming,
      instanceId,
      chatId,
      messages,
      pinNextCommitToBottom,
      setActiveLeaf,
      currentModel,
      currentEffort,
      applyModelChange,
      drainTurn,
      invalidateTranscriptRequests,
    ],
  );

  // Pull image (and any file) blobs out of a paste and stage them as
  // attachments. Only prevents the default paste when there's actually a file,
  // so pasting text still works normally.
  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const files = Array.from(e.clipboardData.items)
        .filter((it) => it.kind === "file")
        .map((it) => it.getAsFile())
        .filter((f): f is File => f !== null);
      if (files.length === 0) return;
      e.preventDefault();
      attachments.add(files);
    },
    [attachments],
  );

  // Edit a user message: renders a sibling version optimistically (the path
  // switches to the new branch immediately) and streams the recomputed
  // answer through the same drain machinery as a normal send. The server
  // forks the provider session at the point before the edited message.
  const sendEdit = useCallback(
    async (messageId: string, content: string, uploads: Upload[]) => {
      const trimmed = content.trim();
      if ((!trimmed && uploads.length === 0) || streamingRef.current) return;
      const currentMessages = messagesRef.current;
      const editedIndex = currentMessages.findIndex((message) => message.id === messageId);
      const edited = currentMessages[editedIndex];
      if (!edited || editedIndex < 0) return;

      invalidateTranscriptRequests();
      resetChunkCache();

      setEditingId(null);
      setStreaming(true);
      liveLastSeqRef.current = -1;

      // Same deferred model/effort flush as a normal send.
      if (currentModel !== appliedModelRef.current || currentEffort !== appliedEffortRef.current) {
        const body: UpdateChatBody = {};
        if (currentModel !== appliedModelRef.current) body.model = currentModel;
        if (currentEffort !== appliedEffortRef.current) body.effort = currentEffort;
        await applyModelChange(body);
      }

      // The optimistic sibling: same parent as the edited message, so the
      // derived path swaps branches right away. Replaced by the server row
      // via the user_message frame.
      const optimisticId = crypto.randomUUID();
      pendingUserIdRef.current = optimisticId;
      turnUserIdRef.current = optimisticId;
      const oldVersion = edited.version ?? {
        index: 1,
        count: 1,
        previousId: null,
        nextId: null,
      };
      const optimistic: TranscriptMessage = {
        id: optimisticId,
        chatId,
        role: "user",
        content: trimmed,
        parentId: edited.parentId ?? null,
        uploads: uploads.length > 0 ? uploads : undefined,
        createdAt: new Date(),
        version: {
          index: oldVersion.count + 1,
          count: oldVersion.count + 1,
          previousId: edited.id,
          nextId: null,
        },
      };
      const retainedMessages = currentMessages.slice(0, editedIndex);
      pinNextCommitToBottom();
      setHistoryPages([
        {
          key: pageKey(retainedMessages, `edit-${messageId}`),
          messages: retainedMessages,
          chunksByMessage: Object.assign(
            {},
            ...historyPagesRef.current.map((page) => page.chunksByMessage),
            Object.fromEntries(
              sessionRowsRef.current.flatMap((row) =>
                row.chunks ? [[row.message.id, row.chunks]] : [],
              ),
            ),
          ),
        },
      ]);
      setSessionRows([{ renderKey: optimistic.id, message: optimistic }]);
      const renderKey = `live-${crypto.randomUUID()}`;
      liveRenderKeyRef.current = renderKey;
      setLiveRow({ renderKey, messageId: null, parentId: optimisticId, chunks: [] });
      setActiveLeaf(optimisticId);

      const ac = new AbortController();
      abortRef.current = ac;
      try {
        await drainTurn(ac, null, (onEvent) =>
          runChatTurn({
            apiBase: API_BASE,
            instanceId,
            chatId,
            content: trimmed,
            uploadIds: uploads.map((upload) => upload.id),
            editMessageId: messageId,
            includeDebug: showDebugRef.current,
            onEvent,
            signal: ac.signal,
          }),
        );
      } finally {
        if (abortRef.current === ac) abortRef.current = null;
        if (!detachedControllersRef.current.has(ac)) setStreaming(false);
      }
    },
    [
      instanceId,
      chatId,
      pinNextCommitToBottom,
      setActiveLeaf,
      currentModel,
      currentEffort,
      applyModelChange,
      drainTurn,
      invalidateTranscriptRequests,
      resetChunkCache,
    ],
  );

  const handleStartEdit = useCallback((id: string) => {
    if (streamingRef.current) return;
    setEditingId(id);
  }, []);
  const handleCancelEdit = useCallback(() => setEditingId(null), []);
  const sendEditRef = useRef(sendEdit);
  sendEditRef.current = sendEdit;
  const handleSubmitEdit = useCallback((id: string, content: string, uploads: Upload[]) => {
    void sendEditRef.current(id, content, uploads);
  }, []);

  // Switch branches on the server, then replace the bounded tail page. No
  // inactive branch bodies are kept in the renderer.
  const handleNavigateVersion = useCallback(
    (messageId: string, dir: 1 | -1) => {
      if (streamingRef.current || navigatingBranchRef.current) return;
      const info = messagesRef.current.find((message) => message.id === messageId)?.version;
      if (!info) return;
      const targetId = dir === -1 ? info.previousId : info.nextId;
      if (!targetId) return;
      const generation = invalidateTranscriptRequests();
      const controller = transcriptRequests.createController();
      navigatingBranchRef.current = true;
      setNavigatingBranch(true);
      setChatActiveLeaf(instanceId, chatId, targetId, controller.signal)
        .then((updated) => {
          const page = updated.transcript;
          if (!transcriptRequests.accepts(generation, controller)) return;
          resetChunkCache();
          pinNextCommitToBottom();
          setHistoryPages([
            {
              key: pageKey(page.messages, `branch-${targetId}`),
              messages: page.messages,
              chunksByMessage: chunksFromPage(page),
            },
          ]);
          setSessionRows([]);
          setHasOlder(page.hasMore);
          setActiveLeaf(updated.activeLeafId ?? page.messages.at(-1)?.id ?? null);
          setEditingId(null);
        })
        .catch(async (err: unknown) => {
          if (controller.signal.aborted) return;
          if (err instanceof DOMException && err.name === "AbortError") return;
          console.warn(`[chat] branch switch failed (chat=${chatId}):`, err);
          // The POST may have reached the server even when its response was
          // lost. Re-read the authoritative branch instead of guessing which
          // side committed, while retaining the current chunk cache if this
          // recovery request also fails.
          try {
            const page = await listChatTranscript(instanceId, chatId, {
              signal: controller.signal,
            });
            if (!transcriptRequests.accepts(generation, controller)) return;
            resetChunkCache();
            pinNextCommitToBottom();
            setHistoryPages([
              {
                key: pageKey(page.messages, "branch-recovery"),
                messages: page.messages,
                chunksByMessage: chunksFromPage(page),
              },
            ]);
            setSessionRows([]);
            setHasOlder(page.hasMore);
            setActiveLeaf(page.messages.at(-1)?.id ?? null);
            setEditingId(null);
          } catch (recoveryError) {
            if (!controller.signal.aborted) {
              console.warn(`[chat] branch recovery failed (chat=${chatId}):`, recoveryError);
            }
          }
        })
        .finally(() => {
          transcriptRequests.release(controller);
          navigatingBranchRef.current = false;
          setNavigatingBranch(false);
        });
    },
    [
      chatId,
      instanceId,
      invalidateTranscriptRequests,
      pinNextCommitToBottom,
      resetChunkCache,
      setActiveLeaf,
      transcriptRequests,
    ],
  );

  // Attach to an in-flight turn discovered during mount-time
  // hydration. Re-uses the same drain machinery as a fresh send so
  // resumed events feed into the same UI state as if the client had
  // been connected throughout. `seedChunks` is whatever the event
  // replay reconstructed for this messageId, and drainTurn picks up the
  // text accumulator and tool index from there.
  const attachResume = useCallback(
    (
      messageId: string,
      afterSeq: number,
      seedChunks: StreamChunk[],
      retainedRenderKey?: string,
    ) => {
      setStreaming(true);
      liveLastSeqRef.current = afterSeq;
      const renderKey = retainedRenderKey ?? messageId;
      liveRenderKeyRef.current = renderKey;
      setLiveRow({
        renderKey,
        messageId,
        parentId: activeLeafRef.current ?? tipIdRef.current,
        chunks: seedChunks,
      });
      const ac = new AbortController();
      abortRef.current = ac;
      streamingMessageIdRef.current = messageId;
      // A resumed turn's user message is already persisted and hydrated: the
      // commit path resolves it as the visible branch's tip instead.
      pendingUserIdRef.current = null;
      turnUserIdRef.current = null;
      void (async () => {
        try {
          await drainTurn(ac, seedChunks, (onEvent) => {
            // The resume runner immediately fires a synthetic message_id
            // event so drainTurn's serverMessageId tracking lights up
            // before any server event arrives.
            onEvent({ kind: "message_id", messageId });
            return resumeChatTurn({
              apiBase: API_BASE,
              instanceId,
              chatId,
              messageId,
              afterSeq,
              includeDebug: showDebugRef.current,
              onEvent,
              signal: ac.signal,
            });
          });
        } finally {
          if (abortRef.current === ac) abortRef.current = null;
          if (!detachedControllersRef.current.has(ac)) setStreaming(false);
        }
      })();
    },
    [chatId, instanceId, drainTurn],
  );

  useEffect(() => {
    if (!streamingRef.current) return;
    if (!visible) {
      const messageId = streamingMessageIdRef.current;
      const ac = abortRef.current;
      if (!messageId || !ac) return;
      detachedControllersRef.current.add(ac);
      detachedTurnRef.current = {
        messageId,
        lastSeq: liveLastSeqRef.current,
        renderKey: liveRenderKeyRef.current ?? messageId,
      };
      ac.abort();
      return;
    }

    const detached = detachedTurnRef.current;
    if (!detached) return;
    let cancelled = false;
    let retryFrame: number | null = null;
    const resumeWhenReleased = () => {
      if (cancelled) return;
      if (abortRef.current) {
        retryFrame = requestAnimationFrame(resumeWhenReleased);
        return;
      }
      detachedTurnRef.current = null;
      attachResume(
        detached.messageId,
        detached.lastSeq,
        [...liveChunksRef.current],
        detached.renderKey,
      );
    };
    resumeWhenReleased();
    return () => {
      cancelled = true;
      if (retryFrame !== null) cancelAnimationFrame(retryFrame);
    };
  }, [attachResume, chatId, instanceId, liveRow?.messageId, streaming, visible]);

  // Fire the initial-message send exactly once per (chatId, initialMessage).
  // The new-chat flow passes a message typed in the empty-state pane.
  // we kick off streaming as soon as the tab mounts with real ids. While
  // `pending`, we still render the optimistic bubble + dots but defer the
  // server call until the real VM + chat are ready.
  const initialFiredRef = useRef<string | null>(null);
  useEffect(() => {
    if (pending) return;
    if (!initialMessage) return;
    const sig = `${chatId}:${initialMessage}`;
    if (initialFiredRef.current === sig) return;
    initialFiredRef.current = sig;
    void sendMessage(initialMessage, true, initialUploadIds);
  }, [pending, chatId, initialMessage, initialUploadIds, sendMessage]);

  // VM/chat creation failed in the parent. Surface it through the regular
  // assistant-message path (same rendering as a stream failure) so the chat
  // ends in a coherent state instead of dots-forever.
  const creationErrorFiredRef = useRef<string | null>(null);
  useEffect(() => {
    if (!creationError) return;
    if (creationErrorFiredRef.current === creationError) return;
    creationErrorFiredRef.current = creationError;
    setStreaming(false);
    const errMsg: TranscriptMessage = {
      id: `creation-error-${crypto.randomUUID()}`,
      chatId,
      role: "assistant",
      parentId: activeLeafRef.current,
      content: `Error: ${creationError}`,
      createdAt: new Date(),
      version: null,
    };
    setSessionRows((rows) => [...rows, { renderKey: errMsg.id, message: errMsg }]);
    setActiveLeaf(errMsg.id);
  }, [creationError, chatId, setActiveLeaf]);

  const currentProvider =
    findChatModel(currentModel)?.provider ??
    chatModels.find((m) => m.id === currentModel)?.provider;
  const sameProviderModels = chatModels.filter((m) => m.provider === currentProvider);
  const pickerModels = isFreshChat ? chatModels : sameProviderModels;
  const liveAssistantRow = useMemo<LiveAssistantRow | null>(() => {
    if (!liveRow) return null;
    return {
      renderKey: liveRow.renderKey,
      message: {
        id: liveRow.messageId ?? liveRow.renderKey,
        chatId,
        role: "assistant",
        parentId: liveRow.parentId,
        content: "",
        createdAt: new Date(0),
        version: null,
      },
      chunks: hotSwitchLiveChunks ?? liveRow.chunks,
      streaming,
    };
  }, [chatId, hotSwitchLiveChunks, liveRow, streaming]);

  return (
    <div data-chat-root className="relative h-full w-full min-w-0 bg-background">
      <div
        ref={scrollContainerRef}
        data-chat-scroll
        onScroll={handleScroll}
        onWheel={handleUserScrollIntent}
        onTouchMove={handleUserScrollIntent}
        onPointerDown={handlePointerScrollIntent}
        className="h-full overflow-y-auto pt-16 flex flex-col gap-4 items-center"
      >
        <div
          className="w-full max-w-3xl px-4 flex flex-col gap-4"
          style={{ paddingBottom: composerHeight + 16 }}
        >
          <MessageHistory
            ref={messageHistoryRef}
            instanceId={instanceId}
            pages={historyPages}
            sessionRows={sessionRows}
            live={liveAssistantRow}
            scrollElementRef={scrollContainerRef}
            showDebug={showDebug}
            userFontFamily={userFontFamily}
            agentFontFamily={agentFontFamily}
            editingId={editingId}
            actionsDisabled={streaming || navigatingBranch}
            visible={visible}
            hasOlder={hasOlder && !streaming && !navigatingBranch}
            onStartEdit={handleStartEdit}
            onCancelEdit={handleCancelEdit}
            onSubmitEdit={handleSubmitEdit}
            onNavigateVersion={handleNavigateVersion}
            onRequestToolDetails={loadToolDetails}
            onLoadOlder={loadOlderMessages}
            onLayoutChange={scrollToBottom}
          />
          <div ref={bottomRef} />
        </div>
      </div>
      {showJump && (
        <button
          type="button"
          aria-label="Jump to latest"
          onClick={() => scrollToBottom(true)}
          style={{ bottom: composerHeight + 12 }}
          className="absolute left-1/2 -translate-x-1/2 flex h-8 w-8 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-md transition-colors hover:text-foreground"
        >
          <ArrowDown className="h-4 w-4" />
        </button>
      )}

      {/* pointer-events-none keeps the strip around the floating box (and the
          scrollbar underneath it) interactive; the inner wrapper re-enables. */}
      <div
        ref={composerRef}
        className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center pb-3"
      >
        <div className="pointer-events-auto w-full max-w-3xl px-4">
          {/* Hidden picker driven by the composer's paperclip button. */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) {
                attachments.add(Array.from(e.target.files));
              }
              // Reset so re-picking the same file fires change again.
              e.target.value = "";
            }}
          />
          <MessageBox
            className="backdrop-blur-md"
            value={input}
            onChange={setInput}
            onSubmit={() => void sendMessage()}
            onStop={() => {
              // Tell the server to abort the producer (the local
              // abort below just tears down our reader. Without the
              // DELETE the server's CLI subprocess would happily run
              // to completion).
              const mid = streamingMessageIdRef.current;
              if (mid) cancelChatTurn(API_BASE, instanceId, chatId, mid);
              abortRef.current?.abort();
            }}
            loading={streaming}
            autoFocus
            placeholder="Message... (Enter to send, Shift+Enter for newline)"
            onAttachClick={() => fileInputRef.current?.click()}
            onPaste={handlePaste}
            hasAttachments={attachments.items.length > 0}
            attachments={
              <AttachmentStrip items={attachments.items} onRemove={attachments.remove} />
            }
            leftToolbar={
              <ModelEffortPicker
                models={pickerModels}
                overrides={modelOverrides}
                currentModelId={currentModel}
                currentEffort={currentEffort}
                onModelChange={handleModelChange}
                onEffortChange={handleEffortChange}
                prepend={
                  <div className="px-2 pt-2 pb-1.5 space-y-2">
                    {usage && (
                      <ContextDetail
                        usage={usage}
                        catalogWindow={findChatModel(currentModel)?.contextWindow}
                      />
                    )}
                    <ContextBreakdownDetail
                      breakdown={breakdown}
                      loading={breakdownLoading}
                      error={breakdownError}
                      onLoad={refreshBreakdown}
                    />
                  </div>
                }
                belowLabel={
                  <ContextBar
                    usage={usage}
                    catalogWindow={findChatModel(currentModel)?.contextWindow}
                  />
                }
              />
            }
          />
        </div>
      </div>
    </div>
  );
}

export default memo(Chat);
