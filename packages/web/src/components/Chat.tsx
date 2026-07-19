import { ArrowDown, ChevronLeft, ChevronRight, Pencil } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  API_BASE,
  getChatContextBreakdown,
  listChatEvents,
  listChatMessages,
  setChatActiveLeaf,
  updateChatModel,
} from "../lib/api";
import {
  type ChatTurnEvent,
  cancelChatTurn,
  resumeChatTurn,
  runChatTurn,
} from "../lib/chat-stream";
import { deriveThread, tipForSibling } from "../lib/chat-tree";
import type {
  ChatEffort,
  ChatEvent,
  ChatMessage,
  ChatModelDefinition,
  Chat as ChatRow,
  ContextBreakdown,
  ModelOverrides,
  UpdateChatBody,
} from "../lib/contracts";
import { findChatModel } from "../lib/contracts";
import {
  resolveFontFamily,
  useAgentFontSetting,
  useDebugSetting,
  useUserFontSetting,
} from "../lib/settings";
import { StreamView } from "./chat/blocks";
import {
  applyEvent,
  chunksFromEvents,
  latestUsageFromEvents,
  REVEAL_ANIMATION,
  REVEAL_CATCHUP_SEC,
  REVEAL_CPS,
  REVEAL_LAG_CHARS,
  REVEAL_MAX_CPS,
  revealableLen,
  type StreamChunk,
  type SubscriptionShare,
  type TokenUsage,
  truncateChunks,
  type UsageState,
  usageSeedFromChat,
} from "./chat/chunks";
import { ContextBar, ContextBreakdownDetail, ContextDetail } from "./chat/UsagePanel";
import Markdown from "./Markdown";
import { MessageBox } from "./MessageBox";
import { ModelEffortPicker } from "./ModelEffortPicker";

// Distance (px) from the bottom within which the user counts as "pinned"
// to the live tail. Pinned: streaming keeps auto-scrolling. Beyond it the
// user is reading history, so streaming must not yank the viewport and the
// jump-to-bottom button shows instead.
const SCROLL_PIN_THRESHOLD_PX = 100;

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

// In-place editor for a user message. Draft state lives here (not in Chat)
// so keystrokes don't re-render the whole message list. Enter submits,
// Escape cancels, and the textarea auto-grows like the main composer.
function UserMessageEditor({
  initial,
  fontFamily,
  onCancel,
  onSubmit,
}: {
  initial: string;
  fontFamily: string;
  onCancel: () => void;
  onSubmit: (content: string) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const maxHeight = Math.min(window.innerHeight * 0.5, 480);
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, [draft]);

  const canSubmit = draft.trim().length > 0;
  return (
    <div className="w-full rounded-2xl border border-input bg-secondary px-4 py-2.5">
      <textarea
        ref={textareaRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          } else if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (canSubmit) onSubmit(draft);
          }
        }}
        rows={1}
        className="w-full resize-none bg-transparent text-sm leading-relaxed text-secondary-foreground outline-none"
        style={{ fontFamily }}
      />
      <div className="mt-2 flex justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 rounded-full"
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          className="h-7 rounded-full"
          disabled={!canSubmit}
          onClick={() => onSubmit(draft)}
        >
          Send
        </Button>
      </div>
    </div>
  );
}

// `‹ n/m ›` version navigation shown under a message that has sibling
// versions (i.e. it was edited at least once).
function VersionPager({
  index,
  count,
  disabled,
  onNavigate,
}: {
  index: number;
  count: number;
  disabled: boolean;
  onNavigate: (dir: 1 | -1) => void;
}) {
  return (
    <div className="flex items-center gap-0.5 text-xs text-muted-foreground">
      <button
        type="button"
        aria-label="Previous version"
        disabled={disabled || index <= 1}
        onClick={() => onNavigate(-1)}
        className="flex h-6 w-6 items-center justify-center rounded transition-colors hover:text-foreground disabled:opacity-40 disabled:hover:text-muted-foreground"
      >
        <ChevronLeft className="h-4.5 w-4.5" />
      </button>
      <span className="tabular-nums">
        {index}/{count}
      </span>
      <button
        type="button"
        aria-label="Next version"
        disabled={disabled || index >= count}
        onClick={() => onNavigate(1)}
        className="flex h-6 w-6 items-center justify-center rounded transition-colors hover:text-foreground disabled:opacity-40 disabled:hover:text-muted-foreground"
      >
        <ChevronRight className="h-4.5 w-4.5" />
      </button>
    </div>
  );
}

// One committed message in the history list. Memoized so a re-render of Chat
// while a turn is streaming (streamingChunks changes every frame) doesn't
// reconcile every prior message's bubble/StreamView. Its props are stable per
// message across those frames — `chunks` is a fixed array reference once
// committed, the font families only change on a settings edit, and the
// edit/version props only change on a send or an explicit edit action — so
// the memo holds for the whole history and only the live streaming bubble
// below updates per frame.
const MessageRow = memo(function MessageRow({
  msg,
  chunks,
  showDebug,
  userFontFamily,
  agentFontFamily,
  versionIndex,
  versionCount,
  isEditing,
  actionsDisabled,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  onNavigateVersion,
}: {
  msg: ChatMessage;
  chunks: StreamChunk[] | undefined;
  showDebug: boolean;
  userFontFamily: string;
  agentFontFamily: string;
  // Version info when this message has siblings (it was edited), else 0.
  versionIndex: number;
  versionCount: number;
  isEditing: boolean;
  // True while a turn is streaming: hides the edit affordance and freezes
  // version navigation (the server refuses both anyway).
  actionsDisabled: boolean;
  onStartEdit: (id: string) => void;
  onCancelEdit: () => void;
  onSubmitEdit: (id: string, content: string) => void;
  onNavigateVersion: (id: string, dir: 1 | -1) => void;
}) {
  const hasVersions = versionCount > 1;
  return (
    <div
      data-message-id={msg.id}
      className={cn("chat-message flex", msg.role === "user" ? "justify-end" : "justify-start")}
    >
      {msg.role === "user" ? (
        <div
          className={cn(
            "group flex flex-col items-end gap-1",
            isEditing ? "w-full" : "max-w-[80%]",
          )}
        >
          {isEditing ? (
            <UserMessageEditor
              initial={msg.content}
              fontFamily={userFontFamily}
              onCancel={onCancelEdit}
              onSubmit={(content) => onSubmitEdit(msg.id, content)}
            />
          ) : (
            <>
              <div
                className="rounded-2xl px-4 py-2.5 text-sm break-words bg-secondary text-secondary-foreground whitespace-pre-wrap"
                style={{ fontFamily: userFontFamily }}
              >
                {msg.content}
              </div>
              {/* Action row under the bubble: hover-revealed edit pencil,
                  then the version pager (always visible when the message has
                  versions). Rendered only when it has something to offer, so
                  ordinary messages don't reserve dead space mid-stream. */}
              {(hasVersions || !actionsDisabled) && (
                <div className="flex h-6 items-center">
                  {!actionsDisabled && (
                    <button
                      type="button"
                      aria-label="Edit message"
                      onClick={() => onStartEdit(msg.id)}
                      className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  )}
                  {hasVersions && (
                    <VersionPager
                      index={versionIndex}
                      count={versionCount}
                      disabled={actionsDisabled}
                      onNavigate={(dir) => onNavigateVersion(msg.id, dir)}
                    />
                  )}
                </div>
              )}
            </>
          )}
        </div>
      ) : (
        <div
          className="w-full pr-12 text-[15px] leading-relaxed text-foreground break-words"
          style={{ fontFamily: agentFontFamily }}
        >
          {chunks ? (
            <StreamView chunks={chunks} showDebug={showDebug} />
          ) : (
            <Markdown content={msg.content} />
          )}
          {hasVersions && (
            <VersionPager
              index={versionIndex}
              count={versionCount}
              disabled={actionsDisabled}
              onNavigate={(dir) => onNavigateVersion(msg.id, dir)}
            />
          )}
        </div>
      )}
    </div>
  );
});

// Memoized so activating a chat tab (which re-renders the parent InstanceView)
// only re-renders the two tabs whose `visible` flips, not every mounted chat
// of the instance. All other props (chat row, model list, callbacks) keep a
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
  pending = false,
  creationError = null,
  onTitle,
}: ChatProps) {
  // When we mount with an `initialMessage`, the parent has just bootstrapped
  // this chat (either real or synthetic-pending). Render the user's bubble +
  // streaming dots from the very first commit so the synthetic→real swap is
  // visually identical and seamless.
  const [messages, setMessages] = useState<ChatMessage[]>(() =>
    initialMessage
      ? [
          {
            id: `optimistic-${chatId}`,
            chatId,
            role: "user",
            content: initialMessage,
            parentId: null,
            createdAt: new Date(),
          },
        ]
      : [],
  );
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(!!initialMessage);
  // Which branch of the message tree is visible: the id of the path's last
  // message (or any message on it). Seeded from the persisted chat row,
  // advanced locally as turns run, and re-pointed by version navigation.
  // Mirrored into a ref so long-lived closures (drainTurn) read the current
  // value without re-subscribing.
  const [activeLeafId, setActiveLeafId] = useState<string | null>(chat.activeLeafId ?? null);
  const activeLeafRef = useRef<string | null>(chat.activeLeafId ?? null);
  const setActiveLeaf = useCallback((id: string | null) => {
    activeLeafRef.current = id;
    setActiveLeafId(id);
  }, []);
  // The user message currently being edited in place, if any.
  const [editingId, setEditingId] = useState<string | null>(null);
  // The optimistic user bubble of the in-flight turn, replaced by the
  // server's `user_message` frame (which carries the real id + parent).
  const pendingUserIdRef = useRef<string | null>(null);
  const [streamingChunks, setStreamingChunks] = useState<StreamChunk[]>([]);
  // Per-message debug+text chunks captured during streaming. Kept in component
  // state (not persisted server-side) so the user can review tool calls etc.
  // until the chat tab unmounts.
  const [messageChunks, setMessageChunks] = useState<Record<string, StreamChunk[]>>({});
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
  const showDebug = useDebugSetting();
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
  // Latest chat prop, for effects/closures that shouldn't re-run when the
  // parent refreshes the row (only the values are read, lazily).
  const chatRef = useRef(chat);
  chatRef.current = chat;
  // The visible thread: one root-to-tip path through the message tree, plus
  // version info for messages that have been edited. `messages` holds every
  // branch, and this projects the active one.
  const thread = useMemo(() => deriveThread(messages, activeLeafId), [messages, activeLeafId]);
  // Render-derived tip of the visible branch, for long-lived closures.
  const tipIdRef = useRef<string | null>(null);
  tipIdRef.current = thread.tipId;
  // The user message the in-flight turn replies to: the optimistic id at
  // send time, then the server id once the user_message frame lands. Null on
  // resumed turns (whose user message is already the branch tip). Where the
  // committed assistant message attaches.
  const turnUserIdRef = useRef<string | null>(null);
  // Mirror of `streaming` for stable callbacks (edit/navigation guards).
  const streamingRef = useRef(streaming);
  streamingRef.current = streaming;
  // Whether the viewport is within SCROLL_PIN_THRESHOLD_PX of the bottom.
  // Written by the container's onScroll, read inside scrollToBottom's rAF
  // callback, a ref (not state) so streaming scrolls never depend on a
  // re-render to see the latest value.
  const isPinnedRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

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
  // Separate rAF handle for the "settle to bottom" loop used on chat
  // switch / hydration (see scrollToBottomSettled). Kept apart from
  // scrollRafRef so a live streaming scroll and a settle pass don't cancel
  // each other.
  const settleScrollRafRef = useRef<number | null>(null);
  // rAF handle for the typewriter reveal loop (see drainTurn). Component-level
  // so unmount can cancel a drain that's still typing out the tail. Only one
  // turn streams at a time, and commit()/abort always cancel it, so a single
  // shared handle is enough.
  const revealRafRef = useRef<number | null>(null);
  const scrollToBottom = useCallback((force = false) => {
    if (force) scrollForceRef.current = true;
    if (scrollRafRef.current !== null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const forced = scrollForceRef.current;
      scrollForceRef.current = false;
      if (!forced && !isPinnedRef.current) return;
      isPinnedRef.current = true;
      setShowJump(false);
      bottomRef.current?.scrollIntoView();
    });
  }, []);

  // Land reliably at the very bottom when a chat becomes visible (tab switch
  // or first hydration). A single scrollIntoView isn't enough here: the
  // history rows carry `content-visibility: auto` (see index.css), so rows
  // that are off-screen at scroll time report only their placeholder
  // intrinsic height. As the bottom rows realize their real, taller height
  // the true bottom moves down and one jump lands short. So we re-pin to the
  // bottom across successive frames until the scroll height stops growing (or
  // a bounded frame budget is spent, so a still-streaming turn can't loop it
  // forever). Non-forced calls respect the pin so switching to a chat the
  // user had scrolled up in keeps their position.
  const scrollToBottomSettled = useCallback((force = false) => {
    if (!force && !isPinnedRef.current) return;
    if (settleScrollRafRef.current !== null) cancelAnimationFrame(settleScrollRafRef.current);
    isPinnedRef.current = true;
    setShowJump(false);
    let lastHeight = -1;
    let stableFrames = 0;
    let frames = 0;
    const step = () => {
      settleScrollRafRef.current = null;
      const el = scrollContainerRef.current;
      if (!el) return;
      bottomRef.current?.scrollIntoView();
      frames += 1;
      if (el.scrollHeight === lastHeight) {
        stableFrames += 1;
      } else {
        stableFrames = 0;
        lastHeight = el.scrollHeight;
      }
      // Stop once the height has held steady for a few frames (content
      // realized) or the budget (~0.5s at 60fps) is exhausted.
      if (stableFrames >= 3 || frames >= 30) return;
      settleScrollRafRef.current = requestAnimationFrame(step);
    };
    settleScrollRafRef.current = requestAnimationFrame(step);
  }, []);

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const pinned = el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_PIN_THRESHOLD_PX;
    isPinnedRef.current = pinned;
    setShowJump(!pinned);
  }, []);
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
      if (settleScrollRafRef.current !== null) {
        cancelAnimationFrame(settleScrollRafRef.current);
        settleScrollRafRef.current = null;
      }
      if (revealRafRef.current !== null) {
        cancelAnimationFrame(revealRafRef.current);
        revealRafRef.current = null;
      }
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
  }, []);

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

  // Clear stale usage AND message chunks when the user actually
  // switches to a different chat. Without clearing chunks, switching
  // away and back leaves the previous chat's tool calls / debug
  // chunks rendered against the new chat's messages until the next
  // streaming turn replaces them. We deliberately avoid keying this
  // on `pending` or `initialMessage` because both flip during the
  // fresh-chat boot sequence (synthetic → real id transition,
  // pending=true→false), and clearing usage there races with the SSE
  // stream's first few usage events and reliably wipes them in Firefox.
  const lastChatIdRef = useRef(chatId);
  useEffect(() => {
    if (lastChatIdRef.current !== chatId) {
      lastChatIdRef.current = chatId;
      setUsage(null);
      setBreakdown(null);
      setBreakdownError(null);
      setMessageChunks({});
      setStreamingChunks([]);
      setActiveLeaf(chatRef.current.activeLeafId ?? null);
      setEditingId(null);
      pendingUserIdRef.current = null;
      isPinnedRef.current = true;
      setShowJump(false);
    }
  }, [chatId, setActiveLeaf]);

  // Skip the fetch while pending (chat doesn't exist on the server
  // yet, since its ids are synthetic stand-ins) or when mounted with a
  // bootstrap initialMessage (server has no history yet, and fetching
  // would clobber the optimistic user bubble). The AbortController
  // keys to chatId so switching chats mid-fetch never lets a stale
  // response clobber the new chat's state. StrictMode's double-mount
  // is also covered: the first effect's cleanup aborts before the
  // second effect's fetch resolves.
  useEffect(() => {
    if (pending || initialMessage) return;
    const ac = new AbortController();
    void (async () => {
      try {
        const [msgs, events] = await Promise.all([
          listChatMessages(instanceId, chatId, ac.signal),
          // Events are best-effort: an empty list still renders the
          // chat correctly using just chat_messages. But a real
          // failure (DB locked, server bug) is worth surfacing so we
          // don't silently lose the in-flight turn detection below.
          listChatEvents(instanceId, chatId, ac.signal).catch((err: unknown) => {
            if (err instanceof DOMException && err.name === "AbortError") {
              return [] as ChatEvent[];
            }
            console.warn(`[chat] listChatEvents failed (chat=${chatId}):`, err);
            return [] as ChatEvent[];
          }),
        ]);
        if (ac.signal.aborted) return;
        setMessages(msgs);
        // Adopt the server's branch choice when the local leaf isn't among
        // the fetched messages (first hydration, or a leaf minted by another
        // window). An unknown/absent leaf falls back to the newest message
        // inside deriveThread, which is the legacy linear behavior.
        const localLeaf = activeLeafRef.current;
        if (!localLeaf || !msgs.some((m) => m.id === localLeaf)) {
          const serverLeaf = chatRef.current.activeLeafId;
          setActiveLeaf(serverLeaf && msgs.some((m) => m.id === serverLeaf) ? serverLeaf : null);
        }
        if (events.length > 0) {
          const grouped: Record<string, ChatEvent[]> = {};
          for (const ev of events) {
            (grouped[ev.messageId] ??= []).push(ev);
          }
          // Sort each group by seq before reducing so out-of-order
          // arrivals don't mis-order the chunks.
          for (const evs of Object.values(grouped)) {
            evs.sort((a, b) => a.seq - b.seq);
          }
          // Detect in-flight turn: a messageId that has no
          // chat_messages row yet. There can be at most one in flight
          // per chat (server enforces it).
          const messageIds = new Set(msgs.filter((m) => m.role === "assistant").map((m) => m.id));
          let inFlightId: string | null = null;
          let inFlightLastSeq = -1;
          for (const [mid, evs] of Object.entries(grouped)) {
            if (messageIds.has(mid)) continue;
            inFlightId = mid;
            for (const ev of evs) if (ev.seq > inFlightLastSeq) inFlightLastSeq = ev.seq;
          }
          const chunksByMessage: Record<string, StreamChunk[]> = {};
          let inFlightChunks: StreamChunk[] = [];
          for (const [mid, evs] of Object.entries(grouped)) {
            const chunks = chunksFromEvents(evs);
            if (mid === inFlightId) inFlightChunks = chunks;
            else chunksByMessage[mid] = chunks;
          }
          setMessageChunks(chunksByMessage);
          const { payload, compacted } = latestUsageFromEvents(events);
          if (payload) {
            setUsage({
              last: payload.last,
              total: payload.total,
              modelContextWindow: payload.modelContextWindow,
              costUsd: payload.costUsd,
              subscriptionShare: payload.subscriptionShare,
              compacted,
            });
          } else if (compacted) {
            setUsage((prev) => (prev ? { ...prev, compacted: true } : prev));
          }
          if (inFlightId) {
            attachResume(inFlightId, inFlightLastSeq, inFlightChunks);
          }
        }
        // Settle to the bottom once the freshly hydrated history has laid
        // out. Forced, so a first load always lands at the tail, and the
        // settle loop absorbs content-visibility rows realizing their real
        // height. Subsequent streaming scrolls go through scrollToBottom.
        setTimeout(() => scrollToBottomSettled(true), 50);
      } catch (err) {
        // Aborts are routine (chat switch, unmount). Anything else is
        // a real failure to hydrate, so log it so a server-side issue
        // doesn't masquerade as an empty chat.
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (ac.signal.aborted) return;
        console.warn(`[chat] hydration failed (chat=${chatId}):`, err);
      }
    })();
    return () => ac.abort();
    // attachResume is stable (defined as ref-using callback below), and we
    // exclude it from deps to avoid re-running the fetch on every
    // re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, initialMessage, instanceId, chatId]);

  useEffect(() => {
    if (visible) scrollToBottomSettled();
  }, [visible, scrollToBottomSettled]);

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
      if (!streaming) void applyModelChange({ model: newModel });
    },
    [streaming, chatModels, currentEffort, applyModelChange],
  );

  const handleEffortChange = useCallback(
    (next: ChatEffort) => {
      setCurrentEffort(next);
      if (!streaming) void applyModelChange({ effort: next });
    },
    [streaming, applyModelChange],
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
      const toolIndex = new Map<string, number>();
      // Rebuild toolIndex from any pre-seeded chunks so a resume can
      // patch the same tool entry the live stream was about to update.
      for (const [i, c] of chunks.entries()) {
        if (c.kind === "tool") toolIndex.set(c.id, i);
      }
      let accumulated = chunks.reduce((acc, c) => (c.kind === "text" ? acc + c.text : acc), "");
      let serverMessageId: string | null = null;
      // Idempotency guard: ignore events we've already applied. The
      // server suppresses them via afterSeq on resume, but a buggy
      // backend or a duplicated frame shouldn't render twice.
      let lastSeq = -1;
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

      // --- Typewriter reveal state ----------------------------------------
      // Claude streams text in large blocks, and rendering them verbatim makes the
      // message lurch in. Instead we keep `chunks` as the fully-received target
      // and animate a `revealed` cursor toward it a few characters per frame,
      // rendering truncateChunks(chunks, revealed). Codex's token-sized deltas
      // already arrive smaller than the per-frame rate, so they're unaffected
      // beyond being coalesced to one render per frame.
      //
      // Seeded resume chunks are already on screen, so start fully revealed so we
      // only ever type out genuinely new text.
      let revealed = revealableLen(chunks);
      // Set on a normal `done`: the loop runs this once it has typed out the
      // tail, so the last block animates in instead of snapping.
      let pendingCommit: (() => void) | null = null;
      // Resolves when a deferred (typed-out) commit has actually landed.
      // drainTurn awaits this before returning so the turn isn't reported
      // complete (and the composer re-enabled) mid-animation.
      let finishingDrain: Promise<void> | null = null;
      // Defensive: a previous turn cancels its own loop via commit(), but never
      // inherit a stale handle.
      if (revealRafRef.current !== null) {
        cancelAnimationFrame(revealRafRef.current);
        revealRafRef.current = null;
      }

      // Timestamp of the previous rAF tick, so reveal speed is measured in
      // real time (chars/sec) rather than chars/frame, so it is uniform regardless of
      // refresh rate or dropped frames. Reset whenever the loop restarts.
      let prevTs: number | null = null;
      const pumpReveal = () => {
        if (revealRafRef.current !== null) return; // already draining
        const step = (ts: number) => {
          revealRafRef.current = null;
          const target = revealableLen(chunks);
          if (revealed < target) {
            // Clamp dt so a backgrounded tab resuming with a multi-second gap
            // doesn't lurch the whole backlog onto screen in one frame. The
            // catch-up below bleeds it off smoothly over the next few frames.
            const dt = prevTs === null ? 16 : Math.min(64, ts - prevTs);
            prevTs = ts;
            const backlog = target - revealed;
            // Constant cadence, plus a capped catch-up once the buffer is large
            // so the visible text never trails real output unboundedly.
            let cps = REVEAL_CPS;
            if (backlog > REVEAL_LAG_CHARS) {
              cps = Math.min(
                REVEAL_MAX_CPS,
                REVEAL_CPS + (backlog - REVEAL_LAG_CHARS) / REVEAL_CATCHUP_SEC,
              );
            }
            revealed = Math.min(target, revealed + Math.max(1, Math.round((cps * dt) / 1000)));
            setStreamingChunks(truncateChunks(chunks, revealed));
            scrollToBottom();
          }
          if (revealed < target) {
            revealRafRef.current = requestAnimationFrame(step);
          } else {
            prevTs = null; // idle until the next delta restarts the loop
            if (pendingCommit) {
              const fn = pendingCommit;
              pendingCommit = null;
              fn();
            }
          }
        };
        revealRafRef.current = requestAnimationFrame(step);
      };

      // Type out whatever's still buffered, then run `fn` (the commit), and
      // resolve once it has. Commits synchronously if already caught up.
      // otherwise the loop calls it on the frame it reaches the target. A
      // Stop/unmount mid-drain snaps the remainder in and commits now rather
      // than keep typing into a turn the user ended.
      const finishThenCommit = (fn: () => void): Promise<void> => {
        if (!REVEAL_ANIMATION || revealed >= revealableLen(chunks)) {
          fn();
          return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
          const finish = () => {
            ac.signal.removeEventListener("abort", onAbort);
            fn();
            resolve();
          };
          const onAbort = () => {
            if (revealRafRef.current !== null) {
              cancelAnimationFrame(revealRafRef.current);
              revealRafRef.current = null;
            }
            finish();
          };
          pendingCommit = finish;
          ac.signal.addEventListener("abort", onAbort, { once: true });
          pumpReveal();
        });
      };

      const commit = (id: string, content: string) => {
        if (revealRafRef.current !== null) {
          cancelAnimationFrame(revealRafRef.current);
          revealRafRef.current = null;
        }
        pendingCommit = null;
        terminalHandled = true;
        const msg: ChatMessage = {
          id,
          chatId,
          role: "assistant",
          // The assistant message replies to the turn's user message. For a
          // resumed turn (no turnUserIdRef) that message is the visible
          // branch's tip: the leaf advanced onto it at turn start and the
          // tip derivation descends to it even from a stale leaf.
          parentId: turnUserIdRef.current ?? tipIdRef.current,
          content,
          createdAt: new Date(),
        };
        setMessages((prev) => {
          // Skip duplicate commits when a resume races with our
          // own optimistic message (e.g. quick reconnect).
          if (prev.some((m) => m.id === id)) return prev;
          return [...prev, msg];
        });
        setActiveLeaf(id);
        setMessageChunks((prev) => ({ ...prev, [id]: chunks }));
        setStreamingChunks([]);
        scrollToBottom();
      };

      // Append a client-only assistant error bubble at the tip of the
      // visible branch (and advance the leaf so it stays visible).
      const appendErrorBubble = (content: string) => {
        const errMsg: ChatMessage = {
          id: `err-${crypto.randomUUID()}`,
          chatId,
          role: "assistant",
          parentId: activeLeafRef.current,
          content,
          createdAt: new Date(),
        };
        setMessages((prev) => [...prev, errMsg]);
        setActiveLeaf(errMsg.id);
      };

      const onEvent = (ev: ChatTurnEvent) => {
        if (ev.kind === "message_id") {
          serverMessageId = ev.messageId;
          streamingMessageIdRef.current = ev.messageId;
          // Re-key any pre-seeded chunks under the canonical id so a
          // resume that landed before message_id still rendered into
          // the right bubble.
          return;
        }
        if (ev.kind === "user_message") {
          // The persisted user-message row: swap it in for our optimistic
          // bubble so the ids the tree navigates by are the server's.
          const pendingId = pendingUserIdRef.current;
          pendingUserIdRef.current = null;
          const serverMsg = ev.message;
          turnUserIdRef.current = serverMsg.id;
          setMessages((prev) => {
            const idx = pendingId ? prev.findIndex((m) => m.id === pendingId) : -1;
            if (idx >= 0) {
              const next = [...prev];
              next[idx] = serverMsg;
              return next;
            }
            if (prev.some((m) => m.id === serverMsg.id)) return prev;
            return [...prev, serverMsg];
          });
          if (activeLeafRef.current === pendingId || activeLeafRef.current === null) {
            setActiveLeaf(serverMsg.id);
          }
          return;
        }
        if (ev.kind === "done") {
          const id = serverMessageId ?? crypto.randomUUID();
          // Let the typewriter finish the tail before committing, so the last
          // block types in rather than snapping. drainTurn awaits the returned
          // promise so the turn stays "streaming" until it lands.
          finishingDrain = finishThenCommit(() => {
            commit(id, accumulated);
            streamingMessageIdRef.current = null;
          });
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
          if (chunks.length > 0) {
            const id = serverMessageId ?? crypto.randomUUID();
            commit(id, accumulated);
          } else {
            terminalHandled = true;
            setStreamingChunks([]);
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
        if (ev.seq >= 0) lastSeq = ev.seq;
        // Meta events that don't produce chunks but update other UI.
        if (ev.type === "usage") {
          const payload = ev.payload as {
            last: TokenUsage;
            total: TokenUsage;
            modelContextWindow?: number;
            costUsd?: number;
            subscriptionShare?: SubscriptionShare;
          };
          setUsage((prev) => ({
            last: payload.last,
            total: payload.total,
            modelContextWindow: payload.modelContextWindow,
            costUsd: payload.costUsd,
            subscriptionShare: payload.subscriptionShare,
            compacted: prev?.compacted,
          }));
          return;
        }
        if (ev.type === "title") {
          const title = typeof ev.payload === "string" ? ev.payload : String(ev.payload ?? "");
          onTitle?.(title);
          return;
        }
        if (ev.type === "context_compacted") {
          setUsage((prev) => (prev ? { ...prev, compacted: true } : prev));
          return;
        }
        // Chunk-producing events flow through the shared reducer so
        // mount-time replay and live streaming end up with byte-for-
        // byte identical chunks.
        if (
          ev.type === "delta" ||
          ev.type === "thinking" ||
          ev.type === "tool_call_start" ||
          ev.type === "tool_call_input" ||
          ev.type === "tool_call_result" ||
          ev.type === "api_retry" ||
          ev.type === "raw"
        ) {
          if (ev.type === "delta") {
            accumulated += typeof ev.payload === "string" ? ev.payload : String(ev.payload ?? "");
          }
          applyEvent(chunks, toolIndex, ev.type, ev.payload);
          if (!REVEAL_ANIMATION) {
            // Typewriter disabled, so render everything received so far at once.
            setStreamingChunks([...chunks]);
            scrollToBottom();
          } else if (ev.type === "delta" || ev.type === "thinking") {
            // New readable text, so hand off to the typewriter, which renders and
            // scrolls one frame at a time as it catches up to the target.
            pumpReveal();
          } else {
            // Structural change (tool call, retry, raw). Render it now, still
            // projected through `revealed` so it stays hidden behind any text
            // ahead of it that hasn't finished typing yet.
            setStreamingChunks(truncateChunks(chunks, revealed));
            scrollToBottom();
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
        setStreamingChunks(REVEAL_ANIMATION ? truncateChunks(chunks, revealed) : [...chunks]);
      };

      try {
        await runner(onEvent);
      } catch (err) {
        if (ac.signal.aborted) {
          // Local abort (Stop button / unmount). Commit partial.
          if (!terminalHandled && chunks.length > 0) {
            const id = serverMessageId ?? crypto.randomUUID();
            commit(id, accumulated);
          } else if (!terminalHandled) {
            setStreamingChunks([]);
          }
          return;
        }
        appendErrorBubble(`Error: ${err instanceof Error ? err.message : String(err)}`);
        setStreamingChunks([]);
        scrollToBottom();
        return;
      }
      // A normal `done` defers its commit until the typewriter finishes the
      // tail. Wait for it here so the turn isn't reported complete (and the
      // post-runner fallback below isn't tricked into a false "no terminal
      // event") until the message has actually committed.
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
        if (ac.signal.aborted) {
          if (chunks.length > 0) {
            const id = serverMessageId ?? crypto.randomUUID();
            commit(id, accumulated);
          } else {
            setStreamingChunks([]);
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
          setStreamingChunks([]);
          scrollToBottom();
        }
      }
    },
    [chatId, scrollToBottom, onTitle, setActiveLeaf],
  );

  const sendMessage = useCallback(
    async (override?: string, force = false) => {
      const content = (override ?? input).trim();
      if (!content) return;
      // `force` bypasses the streaming guard for the bootstrap re-entry where
      // the optimistic state already has `streaming=true` from the useState
      // initializer.
      if (streaming && !force) return;

      if (override === undefined) setInput("");
      setStreaming(true);
      setStreamingChunks([]);

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
      if (!reuseBootstrap) {
        const optimistic: ChatMessage = {
          id: optimisticId,
          chatId,
          role: "user",
          content,
          parentId: thread.tipId,
          createdAt: new Date(),
        };
        setMessages((prev) => [...prev, optimistic]);
      }
      setActiveLeaf(optimisticId);
      scrollToBottom(true);

      const ac = new AbortController();
      abortRef.current = ac;
      try {
        await drainTurn(ac, null, (onEvent) =>
          runChatTurn({
            apiBase: API_BASE,
            instanceId,
            chatId,
            content,
            onEvent,
            signal: ac.signal,
          }),
        );
      } finally {
        if (abortRef.current === ac) abortRef.current = null;
        setStreaming(false);
      }
    },
    [
      input,
      streaming,
      instanceId,
      chatId,
      messages,
      thread.tipId,
      scrollToBottom,
      setActiveLeaf,
      currentModel,
      currentEffort,
      applyModelChange,
      drainTurn,
    ],
  );

  // Edit a user message: renders a sibling version optimistically (the path
  // switches to the new branch immediately) and streams the recomputed
  // answer through the same drain machinery as a normal send. The server
  // forks the provider session at the point before the edited message.
  const sendEdit = useCallback(
    async (messageId: string, content: string) => {
      const trimmed = content.trim();
      if (!trimmed || streamingRef.current) return;
      const edited = messages.find((m) => m.id === messageId);
      if (!edited) return;

      setEditingId(null);
      setStreaming(true);
      setStreamingChunks([]);

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
      const optimistic: ChatMessage = {
        id: optimisticId,
        chatId,
        role: "user",
        content: trimmed,
        parentId: edited.parentId ?? null,
        createdAt: new Date(),
      };
      setMessages((prev) => [...prev, optimistic]);
      setActiveLeaf(optimisticId);
      scrollToBottom(true);

      const ac = new AbortController();
      abortRef.current = ac;
      try {
        await drainTurn(ac, null, (onEvent) =>
          runChatTurn({
            apiBase: API_BASE,
            instanceId,
            chatId,
            content: trimmed,
            editMessageId: messageId,
            onEvent,
            signal: ac.signal,
          }),
        );
      } finally {
        if (abortRef.current === ac) abortRef.current = null;
        setStreaming(false);
      }
    },
    [
      messages,
      instanceId,
      chatId,
      scrollToBottom,
      setActiveLeaf,
      currentModel,
      currentEffort,
      applyModelChange,
      drainTurn,
    ],
  );

  const handleStartEdit = useCallback((id: string) => {
    if (streamingRef.current) return;
    setEditingId(id);
  }, []);
  const handleCancelEdit = useCallback(() => setEditingId(null), []);
  const handleSubmitEdit = useCallback(
    (id: string, content: string) => {
      void sendEdit(id, content);
    },
    [sendEdit],
  );

  // Switch to a neighboring version of an edited message: activate that
  // sibling's branch (its newest tip) locally for an instant swap, then
  // persist the choice. The server resolves the tip itself and re-points the
  // provider session at the branch, and its answer wins over our local
  // guess (they only differ if another window raced us).
  const handleNavigateVersion = useCallback(
    (messageId: string, dir: 1 | -1) => {
      if (streamingRef.current) return;
      const info = thread.versions.get(messageId);
      if (!info) return;
      const targetId = info.siblingIds[info.index - 1 + dir];
      if (!targetId) return;
      const previousLeaf = activeLeafRef.current;
      setActiveLeaf(tipForSibling(messages, targetId));
      setChatActiveLeaf(instanceId, chatId, targetId)
        .then((updated) => {
          if (updated.activeLeafId) setActiveLeaf(updated.activeLeafId);
        })
        .catch((err: unknown) => {
          // The server refused (e.g. a turn raced us from another window).
          // Snap back so the visible branch matches the session the next
          // turn will actually run in.
          console.warn(`[chat] branch switch failed (chat=${chatId}):`, err);
          setActiveLeaf(previousLeaf);
        });
    },
    [thread, messages, instanceId, chatId, setActiveLeaf],
  );

  // Attach to an in-flight turn discovered during mount-time
  // hydration. Re-uses the same drain machinery as a fresh send so
  // resumed events feed into the same UI state as if the client had
  // been connected throughout. `seedChunks` is whatever the event
  // replay reconstructed for this messageId, and drainTurn picks up the
  // text accumulator and tool index from there.
  const streamingMessageIdRef = useRef<string | null>(null);
  const attachResume = useCallback(
    (messageId: string, afterSeq: number, seedChunks: StreamChunk[]) => {
      setStreamingChunks(seedChunks);
      setStreaming(true);
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
              onEvent,
              signal: ac.signal,
            });
          });
        } finally {
          if (abortRef.current === ac) abortRef.current = null;
          setStreaming(false);
        }
      })();
    },
    [chatId, instanceId, drainTurn],
  );

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
    void sendMessage(initialMessage, true);
  }, [pending, chatId, initialMessage, sendMessage]);

  // VM/chat creation failed in the parent. Surface it through the regular
  // assistant-message path (same rendering as a stream failure) so the chat
  // ends in a coherent state instead of dots-forever.
  const creationErrorFiredRef = useRef<string | null>(null);
  useEffect(() => {
    if (!creationError) return;
    if (creationErrorFiredRef.current === creationError) return;
    creationErrorFiredRef.current = creationError;
    setStreaming(false);
    const errMsg: ChatMessage = {
      id: `creation-error-${crypto.randomUUID()}`,
      chatId,
      role: "assistant",
      parentId: activeLeafRef.current,
      content: `Error: ${creationError}`,
      createdAt: new Date(),
    };
    setMessages((prev) => [...prev, errMsg]);
    setActiveLeaf(errMsg.id);
  }, [creationError, chatId, setActiveLeaf]);

  // Block cross-provider model swaps: the picker only offers models that
  // match the current chat's provider. To switch providers, the user opens
  // a new Chat tab.
  const currentProvider =
    findChatModel(currentModel)?.provider ??
    chatModels.find((m) => m.id === currentModel)?.provider;
  const sameProviderModels = chatModels.filter((m) => m.provider === currentProvider);

  return (
    <div className="relative h-full bg-background">
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto pt-16 flex flex-col gap-4 items-center"
      >
        <div
          className="w-full max-w-3xl px-4 flex flex-col gap-4"
          style={{ paddingBottom: composerHeight + 16 }}
        >
          {thread.path.map((msg, i) => {
            const version = thread.versions.get(msg.id);
            // User rows are keyed by PATH POSITION, not message id: pressing
            // ‹/› swaps in a sibling version at the same position, and an
            // id key would remount the row, re-running the pencil's
            // hover-reveal fade (a visible flicker) and dropping the pager
            // button's focus/hover state on every press. Position keys keep
            // the DOM node alive across the swap. The path never reorders
            // (it only grows or swaps a suffix), so positions are stable.
            // Assistant rows keep id keys so their tool-call cards remount
            // with fresh collapse state when the branch switches.
            return (
              <MessageRow
                key={msg.role === "user" ? `user-pos-${i}` : msg.id}
                msg={msg}
                chunks={messageChunks[msg.id]}
                showDebug={showDebug}
                userFontFamily={userFontFamily}
                agentFontFamily={agentFontFamily}
                versionIndex={version?.index ?? 0}
                versionCount={version?.count ?? 0}
                isEditing={editingId === msg.id}
                actionsDisabled={streaming}
                onStartEdit={handleStartEdit}
                onCancelEdit={handleCancelEdit}
                onSubmitEdit={handleSubmitEdit}
                onNavigateVersion={handleNavigateVersion}
              />
            );
          })}
          {streamingChunks.length > 0 && (
            <div className="flex justify-start">
              <div
                className="w-full pr-12 text-[15px] leading-relaxed text-foreground break-words"
                style={{ fontFamily: agentFontFamily }}
              >
                <StreamView chunks={streamingChunks} showDebug={showDebug} />
                <span className="inline-block w-1 h-4 ml-0.5 bg-muted-foreground animate-pulse align-text-bottom" />
              </div>
            </div>
          )}
          {streaming && streamingChunks.length === 0 && (
            <div className="flex justify-start">
              <span className="flex gap-1 py-2">
                <span
                  className="w-1.5 h-1.5 bg-muted-foreground rounded-full animate-bounce"
                  style={{ animationDelay: "0ms" }}
                />
                <span
                  className="w-1.5 h-1.5 bg-muted-foreground rounded-full animate-bounce"
                  style={{ animationDelay: "150ms" }}
                />
                <span
                  className="w-1.5 h-1.5 bg-muted-foreground rounded-full animate-bounce"
                  style={{ animationDelay: "300ms" }}
                />
              </span>
            </div>
          )}
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
            leftToolbar={
              <ModelEffortPicker
                models={sameProviderModels}
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
