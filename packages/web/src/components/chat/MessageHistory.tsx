import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  forwardRef,
  memo,
  type RefObject,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import type { TranscriptMessage, Upload } from "@/lib/contracts";
import { RENDER_METRICS_ENABLED, recordRenderMetric } from "@/lib/render-metrics";
import { cn } from "@/lib/utils";
import StreamingMarkdown from "../StreamingMarkdown";
import {
  MarkdownImageScope,
  type ProviderSwitchChunk,
  ProviderSwitchDivider,
  providerSwitchOf,
  StreamView,
} from "./blocks";
import type { StreamChunk } from "./chunks";
import { UserMessage } from "./UserMessage";

const EDITABLE_USER_MESSAGE = { edit: true } as const;

/** Where the reader is: a message, and its top edge relative to the viewport. */
interface ReadingAnchor {
  messageId: string;
  top: number;
}

function anchorFor(row: HTMLElement | null): ReadingAnchor | null {
  const messageId = row?.getAttribute("data-message-id");
  return messageId ? { messageId, top: row!.getBoundingClientRect().top } : null;
}

/**
 * How far the anchored message has moved since it was captured, or null when it
 * cannot be located. Today that means it is not mounted, which only happens if
 * it left the transcript. Once the transcript is windowed this is where an
 * offset computed from the height cache belongs.
 */
function anchorDrift(list: HTMLElement | null, anchor: ReadingAnchor): number | null {
  const row = list?.querySelector<HTMLElement>(
    `[data-message-id="${CSS.escape(anchor.messageId)}"]`,
  );
  if (!row) return null;
  return row.getBoundingClientRect().top - anchor.top;
}

export interface MessageHistoryPage {
  key: string;
  messages: TranscriptMessage[];
  chunksByMessage: Record<string, StreamChunk[]>;
}

export interface LiveAssistantRow {
  renderKey: string;
  message: TranscriptMessage;
  chunks: StreamChunk[];
  streaming: boolean;
}

export interface SessionMessageRow {
  renderKey: string;
  message: TranscriptMessage;
  chunks?: StreamChunk[];
}

export interface MessageHistoryHandle {
  capturePrependAnchor: () => void;
  captureRetainedAnchor: () => void;
  restoreRetainedAnchor: () => void;
}

function findFirstVisibleRow(
  scrollElement: HTMLElement,
  listElement: HTMLElement,
  preferredOffset = 2,
): HTMLElement | null {
  const viewport = scrollElement.getBoundingClientRect();
  const x = viewport.left + Math.min(Math.max(viewport.width / 2, 1), viewport.width - 1);
  const offsets = [preferredOffset, 96, 144, 64, 32, 12, 2];
  for (const offset of new Set(offsets)) {
    const y = Math.min(viewport.bottom - 1, viewport.top + offset);
    const hit = document.elementFromPoint(x, y);
    const row = hit?.closest<HTMLElement>("[data-message-row]");
    if (row && listElement.contains(row)) return row;
  }

  const page = [...listElement.querySelectorAll<HTMLElement>("[data-history-page]")].find(
    (candidate) => candidate.getBoundingClientRect().bottom > viewport.top + preferredOffset,
  );
  const candidates = page
    ? page.querySelectorAll<HTMLElement>("[data-message-row]")
    : listElement.querySelectorAll<HTMLElement>(":scope > [data-message-row]");
  return (
    [...candidates].find(
      (row) => row.getBoundingClientRect().bottom > viewport.top + preferredOffset,
    ) ?? null
  );
}

function VersionPager({
  index,
  count,
  actionsDisabled,
  onNavigate,
}: {
  index: number;
  count: number;
  actionsDisabled: boolean;
  onNavigate: (direction: 1 | -1) => void;
}) {
  return (
    <div className="flex items-center gap-0.5 text-xs text-muted-foreground" data-chat-action>
      <button
        type="button"
        aria-label="Previous version"
        data-disabled-at-rest={index <= 1 ? "true" : "false"}
        disabled={actionsDisabled || index <= 1}
        onClick={() => onNavigate(-1)}
        className="flex h-6 w-6 items-center justify-center rounded hover:text-foreground disabled:opacity-40 disabled:hover:text-muted-foreground"
      >
        <ChevronLeft className="h-4.5 w-4.5" />
      </button>
      <span className="tabular-nums">
        {index}/{count}
      </span>
      <button
        type="button"
        aria-label="Next version"
        data-disabled-at-rest={index >= count ? "true" : "false"}
        disabled={actionsDisabled || index >= count}
        onClick={() => onNavigate(1)}
        className="flex h-6 w-6 items-center justify-center rounded hover:text-foreground disabled:opacity-40 disabled:hover:text-muted-foreground"
      >
        <ChevronRight className="h-4.5 w-4.5" />
      </button>
    </div>
  );
}

function WaitingDots({ label }: { label?: string }) {
  const dots = (
    <span className="flex gap-1" aria-label={label ?? "Waiting for response"}>
      {[0, 150, 300].map((delay) => (
        <span
          key={delay}
          className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </span>
  );
  if (!label) return <span className="flex py-2">{dots}</span>;
  return (
    <span className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
      {dots}
      <span>{label}</span>
    </span>
  );
}

export const MessageRow = memo(function MessageRow({
  message,
  instanceId,
  chunks,
  switchAbove,
  waitingLabel,
  showDebug,
  userFontFamily,
  agentFontFamily,
  isEditing,
  editingUserMessageId = null,
  streaming = false,
  historical = false,
  actionsDisabled = false,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  onNavigateVersion,
  onRequestToolDetails,
}: {
  message: TranscriptMessage;
  instanceId: string;
  chunks: StreamChunk[] | undefined;
  // When this row is the user message that triggered a provider switch, the
  // divider to render above it (that message ran on the new model).
  switchAbove?: ProviderSwitchChunk;
  // Label shown next to the waiting dots while an assistant row is streaming
  // with no output yet (e.g. "Transferring context…" during a switch).
  waitingLabel?: string;
  showDebug: boolean;
  userFontFamily: string;
  agentFontFamily: string;
  isEditing: boolean;
  editingUserMessageId?: string | null;
  streaming?: boolean;
  historical?: boolean;
  actionsDisabled?: boolean;
  onStartEdit: (id: string) => void;
  onCancelEdit: () => void;
  onSubmitEdit: (id: string, content: string, uploads: Upload[]) => void;
  onNavigateVersion: (id: string, direction: 1 | -1) => void;
  onRequestToolDetails: (messageId: string, toolId: string) => void;
}) {
  if (RENDER_METRICS_ENABLED && historical) recordRenderMetric("historicalRowRenders");
  const requestToolDetails = useCallback(
    (toolId: string) => onRequestToolDetails(message.id, toolId),
    [message.id, onRequestToolDetails],
  );
  const version = message.version;
  return (
    <>
      {switchAbove && <ProviderSwitchDivider chunk={switchAbove} />}
      <div
        data-message-id={message.id}
        data-message-row
        role="listitem"
        className={cn("flex", message.role === "user" ? "justify-end" : "justify-start")}
        style={{ contentVisibility: "auto", containIntrinsicSize: "auto 96px" }}
      >
        {message.role === "user" ? (
          <UserMessage
            message={message}
            capabilities={EDITABLE_USER_MESSAGE}
            instanceId={instanceId}
            fontFamily={userFontFamily}
            editing={isEditing}
            actionsDisabled={actionsDisabled}
            onStartEdit={onStartEdit}
            onCancelEdit={onCancelEdit}
            onSubmitEdit={onSubmitEdit}
            footer={
              version ? (
                <VersionPager
                  index={version.index}
                  count={version.count}
                  actionsDisabled={actionsDisabled}
                  onNavigate={(direction) => onNavigateVersion(message.id, direction)}
                />
              ) : undefined
            }
          />
        ) : (
          <MarkdownImageScope chunks={chunks} instanceId={instanceId}>
            <div
              className="w-full break-words pr-12 text-[15px] leading-relaxed text-foreground"
              style={{ fontFamily: agentFontFamily }}
            >
              {streaming && (!chunks || chunks.length === 0) ? (
                <WaitingDots label={waitingLabel} />
              ) : chunks && chunks.length > 0 ? (
                <>
                  <StreamView
                    chunks={chunks}
                    cacheScope={streaming ? undefined : message.id}
                    showDebug={showDebug}
                    streaming={streaming}
                    instanceId={instanceId}
                    userFontFamily={userFontFamily}
                    editingUserMessageId={editingUserMessageId}
                    actionsDisabled={actionsDisabled}
                    onStartUserMessageEdit={onStartEdit}
                    onCancelUserMessageEdit={onCancelEdit}
                    onSubmitUserMessageEdit={onSubmitEdit}
                    onRequestToolDetails={requestToolDetails}
                  />
                  {streaming && chunks.at(-1)?.kind === "text" && (
                    <span className="ml-0.5 inline-block h-4 w-1 animate-pulse bg-muted-foreground align-text-bottom" />
                  )}
                </>
              ) : (
                <StreamingMarkdown content={message.content} cacheKey={`${message.id}:content`} />
              )}
              {version && (
                <VersionPager
                  index={version.index}
                  count={version.count}
                  actionsDisabled={actionsDisabled}
                  onNavigate={(direction) => onNavigateVersion(message.id, direction)}
                />
              )}
            </div>
          </MarkdownImageScope>
        )}
      </div>
    </>
  );
});

interface SharedRowProps {
  instanceId: string;
  showDebug: boolean;
  userFontFamily: string;
  agentFontFamily: string;
  editingId: string | null;
  actionsDisabled: boolean;
  onStartEdit: (id: string) => void;
  onCancelEdit: () => void;
  onSubmitEdit: (id: string, content: string, uploads: Upload[]) => void;
  onNavigateVersion: (id: string, direction: 1 | -1) => void;
  onRequestToolDetails: (messageId: string, toolId: string) => void;
}

const HistoryPage = memo(function HistoryPage({
  page,
  ...shared
}: { page: MessageHistoryPage } & SharedRowProps) {
  if (RENDER_METRICS_ENABLED) recordRenderMetric("historyMappings");
  // A provider-switch marker leads its (target) assistant turn; surface it as a
  // divider above that turn's user message, keyed by the assistant's parentId.
  const switchByUserId = new Map<string, ProviderSwitchChunk>();
  for (const message of page.messages) {
    if (message.role !== "assistant" || !message.parentId) continue;
    const marker = providerSwitchOf(page.chunksByMessage[message.id]);
    if (marker) switchByUserId.set(message.parentId, marker);
  }
  return (
    <div
      data-history-page={page.key}
      className="flex flex-col gap-4"
      style={{
        contentVisibility: "auto",
        containIntrinsicSize: `auto ${Math.max(96, page.messages.length * 112)}px`,
      }}
    >
      {page.messages.map((message) => (
        <MessageRow
          key={message.id}
          message={message}
          instanceId={shared.instanceId}
          historical
          actionsDisabled={shared.actionsDisabled}
          chunks={page.chunksByMessage[message.id]}
          switchAbove={switchByUserId.get(message.id)}
          showDebug={shared.showDebug}
          userFontFamily={shared.userFontFamily}
          agentFontFamily={shared.agentFontFamily}
          isEditing={shared.editingId === message.id}
          editingUserMessageId={shared.editingId}
          onStartEdit={shared.onStartEdit}
          onCancelEdit={shared.onCancelEdit}
          onSubmitEdit={shared.onSubmitEdit}
          onNavigateVersion={shared.onNavigateVersion}
          onRequestToolDetails={shared.onRequestToolDetails}
        />
      ))}
    </div>
  );
});

interface MessageHistoryProps extends SharedRowProps {
  pages: MessageHistoryPage[];
  sessionRows: SessionMessageRow[];
  live: LiveAssistantRow | null;
  // An optimistic provider-switch divider to show above a session user message
  // (keyed by its id) the instant a switch-triggering message is submitted,
  // before the target turn commits its persisted marker.
  activeSwitch?: { userId: string; chunk: ProviderSwitchChunk } | null;
  scrollElementRef: RefObject<HTMLDivElement | null>;
  visible: boolean;
  hasOlder: boolean;
  actionsDisabled: boolean;
  onLoadOlder: () => void;
  onLayoutChange: () => void;
}

export const MessageHistory = memo(
  forwardRef<MessageHistoryHandle, MessageHistoryProps>(function MessageHistory(
    {
      pages,
      sessionRows,
      live,
      activeSwitch,
      instanceId,
      scrollElementRef,
      showDebug,
      userFontFamily,
      agentFontFamily,
      editingId,
      visible,
      hasOlder,
      actionsDisabled,
      onStartEdit,
      onCancelEdit,
      onSubmitEdit,
      onNavigateVersion,
      onRequestToolDetails,
      onLoadOlder,
      onLayoutChange,
    },
    forwardedRef,
  ) {
    const listRef = useRef<HTMLDivElement>(null);
    const sentinelRef = useRef<HTMLDivElement>(null);
    const restoreAnchorRafRef = useRef<number | null>(null);
    // An anchor is a message and where its top sits relative to the viewport,
    // not a live element. Holding the element only works while every message is
    // mounted, which is exactly what windowing the transcript gives up: the
    // message the reader is anchored to is frequently outside the rendered
    // range. Resolving by id keeps the same behaviour today and leaves a single
    // seam to answer from a height cache instead of the DOM later.
    const prependAnchorRef = useRef<ReadingAnchor | null>(null);
    const resizeAnchorRef = useRef<ReadingAnchor | null>(null);
    const rememberAnchorRafRef = useRef<number | null>(null);

    const shared = useMemo<SharedRowProps>(
      () => ({
        instanceId,
        showDebug,
        userFontFamily,
        agentFontFamily,
        editingId,
        // Historical pages remain referentially stable across turn lifecycle
        // changes. A layout effect below updates their native button state
        // without remapping every retained row.
        actionsDisabled: false,
        onStartEdit,
        onCancelEdit,
        onSubmitEdit,
        onNavigateVersion,
        onRequestToolDetails,
      }),
      [
        agentFontFamily,
        editingId,
        instanceId,
        onCancelEdit,
        onNavigateVersion,
        onRequestToolDetails,
        onStartEdit,
        onSubmitEdit,
        showDebug,
        userFontFamily,
      ],
    );

    useLayoutEffect(() => {
      const list = listRef.current;
      if (!list) return;
      for (const button of list.querySelectorAll<HTMLButtonElement>(
        "[data-history-page] [data-chat-action] button",
      )) {
        button.disabled = actionsDisabled || button.dataset.disabledAtRest === "true";
      }
    }, [actionsDisabled, pages]);

    const pageElements = useMemo(
      () => pages.map((page) => <HistoryPage key={page.key} page={page} {...shared} />),
      [pages, shared],
    );
    const sessionElements = useMemo(() => {
      const switchByUserId = new Map<string, ProviderSwitchChunk>();
      for (const row of sessionRows) {
        if (row.message.role !== "assistant" || !row.message.parentId) continue;
        const marker = providerSwitchOf(row.chunks);
        if (marker) switchByUserId.set(row.message.parentId, marker);
      }
      // The optimistic divider (shown before the turn commits its persisted
      // marker) wins for its user message so it appears the instant the message
      // is submitted.
      if (activeSwitch) switchByUserId.set(activeSwitch.userId, activeSwitch.chunk);
      return sessionRows.map((row) => (
        <MessageRow
          key={row.renderKey}
          message={row.message}
          instanceId={instanceId}
          chunks={row.chunks}
          switchAbove={switchByUserId.get(row.message.id)}
          showDebug={showDebug}
          userFontFamily={userFontFamily}
          agentFontFamily={agentFontFamily}
          isEditing={editingId === row.message.id}
          editingUserMessageId={editingId}
          actionsDisabled={actionsDisabled}
          onStartEdit={onStartEdit}
          onCancelEdit={onCancelEdit}
          onSubmitEdit={onSubmitEdit}
          onNavigateVersion={onNavigateVersion}
          onRequestToolDetails={onRequestToolDetails}
        />
      ));
    }, [
      actionsDisabled,
      activeSwitch,
      agentFontFamily,
      editingId,
      instanceId,
      onCancelEdit,
      onNavigateVersion,
      onRequestToolDetails,
      onStartEdit,
      onSubmitEdit,
      sessionRows,
      showDebug,
      userFontFamily,
    ]);
    const liveElement = live ? (
      <MessageRow
        key={live.renderKey}
        message={live.message}
        instanceId={instanceId}
        chunks={live.chunks}
        streaming={live.streaming}
        // While a switch is activating, the source conversation is being
        // summarized/transferred before the target replies, so the wait can be
        // a few seconds. Say so instead of showing bare dots.
        waitingLabel={activeSwitch ? "Transferring context…" : undefined}
        showDebug={showDebug}
        userFontFamily={userFontFamily}
        agentFontFamily={agentFontFamily}
        isEditing={false}
        editingUserMessageId={editingId}
        actionsDisabled={actionsDisabled}
        onStartEdit={onStartEdit}
        onCancelEdit={onCancelEdit}
        onSubmitEdit={onSubmitEdit}
        onNavigateVersion={onNavigateVersion}
        onRequestToolDetails={onRequestToolDetails}
      />
    ) : null;
    // Keep one flat keyed sibling array so the live row can move into the
    // session group on commit without remounting. Appending a delta allocates
    // only this shallow array and does not remap established session rows.
    const tailElements = liveElement ? [...sessionElements, liveElement] : sessionElements;

    const capturePrependAnchor = useCallback(() => {
      const scrollElement = scrollElementRef.current;
      const listElement = listRef.current;
      if (!scrollElement || !listElement) return;
      const anchor = anchorFor(findFirstVisibleRow(scrollElement, listElement));
      if (!anchor) return;
      prependAnchorRef.current = anchor;
      scrollElement.style.overflowAnchor = "none";
    }, [scrollElementRef]);

    const captureRetainedAnchor = useCallback(() => {
      const scrollElement = scrollElementRef.current;
      const listElement = listRef.current;
      if (!scrollElement || !listElement) return;
      const distanceFromBottom =
        scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight;
      if (distanceFromBottom <= 80) {
        resizeAnchorRef.current = null;
        return;
      }
      resizeAnchorRef.current = anchorFor(findFirstVisibleRow(scrollElement, listElement, 120));
    }, [scrollElementRef]);

    const restoreRetainedAnchor = useCallback(() => {
      const anchor = resizeAnchorRef.current;
      const scrollElement = scrollElementRef.current;
      if (!scrollElement || !anchor) return;
      const delta = anchorDrift(listRef.current, anchor);
      if (delta === null) return;
      scrollElement.style.overflowAnchor = "none";
      if (Math.abs(delta) > 0.5) scrollElement.scrollTop += delta;
      if (restoreAnchorRafRef.current !== null) cancelAnimationFrame(restoreAnchorRafRef.current);
      restoreAnchorRafRef.current = requestAnimationFrame(() => {
        restoreAnchorRafRef.current = null;
        scrollElement.style.overflowAnchor = "";
      });
    }, [scrollElementRef]);

    useImperativeHandle(
      forwardedRef,
      () => ({ capturePrependAnchor, captureRetainedAnchor, restoreRetainedAnchor }),
      [capturePrependAnchor, captureRetainedAnchor, restoreRetainedAnchor],
    );

    useLayoutEffect(() => {
      const anchor = prependAnchorRef.current;
      if (!anchor) return;
      prependAnchorRef.current = null;
      const scrollElement = scrollElementRef.current;
      const delta = anchorDrift(listRef.current, anchor);
      if (scrollElement && delta !== null) scrollElement.scrollTop += delta;
      if (restoreAnchorRafRef.current !== null) cancelAnimationFrame(restoreAnchorRafRef.current);
      restoreAnchorRafRef.current = requestAnimationFrame(() => {
        restoreAnchorRafRef.current = null;
        if (scrollElement) scrollElement.style.overflowAnchor = "";
      });
    }, [pages, scrollElementRef]);

    useEffect(
      () => () => {
        if (restoreAnchorRafRef.current !== null) cancelAnimationFrame(restoreAnchorRafRef.current);
        if (rememberAnchorRafRef.current !== null)
          cancelAnimationFrame(rememberAnchorRafRef.current);
        const scrollElement = scrollElementRef.current;
        if (scrollElement) scrollElement.style.overflowAnchor = "";
      },
      [scrollElementRef],
    );

    useEffect(() => {
      const scrollElement = scrollElementRef.current;
      const listElement = listRef.current;
      if (!scrollElement || !listElement || !visible) return;

      const rememberVisibleAnchor = () => {
        rememberAnchorRafRef.current = null;
        if (prependAnchorRef.current) return;
        captureRetainedAnchor();
      };
      const scheduleRemember = () => {
        if (rememberAnchorRafRef.current !== null) return;
        rememberAnchorRafRef.current = requestAnimationFrame(rememberVisibleAnchor);
      };

      rememberVisibleAnchor();
      scrollElement.addEventListener("scroll", scheduleRemember, { passive: true });
      const observer = new ResizeObserver(() => {
        const anchor = resizeAnchorRef.current;
        if (!prependAnchorRef.current && anchor) {
          const delta = anchorDrift(listRef.current, anchor);
          if (delta !== null && Math.abs(delta) > 0.5) scrollElement.scrollTop += delta;
        }
        rememberVisibleAnchor();
      });
      observer.observe(scrollElement);
      return () => {
        observer.disconnect();
        scrollElement.removeEventListener("scroll", scheduleRemember);
        if (rememberAnchorRafRef.current !== null) {
          cancelAnimationFrame(rememberAnchorRafRef.current);
          rememberAnchorRafRef.current = null;
        }
      };
    }, [captureRetainedAnchor, scrollElementRef, visible]);

    useEffect(() => {
      const root = scrollElementRef.current;
      const target = sentinelRef.current;
      if (!root || !target || !visible || !hasOlder) return;
      const observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) onLoadOlder();
        },
        { root, rootMargin: "600px 0px 0px" },
      );
      observer.observe(target);
      return () => observer.disconnect();
    }, [hasOlder, onLoadOlder, scrollElementRef, visible]);

    useEffect(() => {
      const list = listRef.current;
      if (!list) return;
      // ResizeObserver supplies entries as its first callback argument. Keep
      // that browser callback shape away from consumers such as
      // scrollToBottom(force), where the entries array would be truthy and
      // accidentally turn an ordinary pinned scroll into a forced one.
      const observer = new ResizeObserver(() => onLayoutChange());
      observer.observe(list);
      return () => observer.disconnect();
    }, [onLayoutChange]);

    return (
      <div
        ref={listRef}
        role="list"
        aria-label="Chat messages"
        aria-busy={actionsDisabled}
        data-actions-disabled={actionsDisabled ? "true" : "false"}
        className="flex flex-col gap-4 data-[actions-disabled=true]:[&_[data-chat-action]]:pointer-events-none data-[actions-disabled=true]:[&_[data-chat-action]]:opacity-50"
        onClickCapture={(event) => {
          if (!actionsDisabled) return;
          const target = event.target as HTMLElement;
          if (!target.closest("[data-chat-action]")) return;
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <div ref={sentinelRef} aria-hidden className="h-px" />
        {pageElements}
        {tailElements}
      </div>
    );
  }),
);
