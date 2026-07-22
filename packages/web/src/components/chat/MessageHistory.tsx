import { ChevronLeft, ChevronRight, Paperclip, Pencil } from "lucide-react";
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
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import type { TranscriptMessage, Upload } from "@/lib/contracts";
import { RENDER_METRICS_ENABLED, recordRenderMetric } from "@/lib/render-metrics";
import { useAttachments } from "@/lib/use-attachments";
import { cn } from "@/lib/utils";
import StreamingMarkdown from "../StreamingMarkdown";
import { AttachmentStrip } from "./AttachmentStrip";
import { StreamView } from "./blocks";
import type { StreamChunk } from "./chunks";
import { MessageUploads } from "./MessageUploads";

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

function UserMessageEditor({
  initial,
  initialUploads,
  instanceId,
  fontFamily,
  onCancel,
  onSubmit,
}: {
  initial: string;
  initialUploads: Upload[];
  instanceId: string;
  fontFamily: string;
  onCancel: () => void;
  onSubmit: (content: string, uploads: Upload[]) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [submitting, setSubmitting] = useState(false);
  const attachments = useAttachments(instanceId, initialUploads);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
  }, []);
  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    const maxHeight = Math.min(window.innerHeight * 0.5, 480);
    element.style.height = "0px";
    element.style.height = `${Math.min(element.scrollHeight, maxHeight)}px`;
  }, [draft]);

  const canSubmit =
    draft.trim().length > 0 || attachments.items.some((item) => item.status !== "error");
  const submit = async () => {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    const uploads = await attachments.resolveUploads();
    if (!draft.trim() && uploads.length === 0) {
      setSubmitting(false);
      return;
    }
    onSubmit(draft, uploads);
  };
  return (
    <div className="w-full rounded-2xl border border-input bg-secondary px-4 py-2.5">
      <textarea
        ref={textareaRef}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          } else if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void submit();
          }
        }}
        onPaste={(event) => {
          const files = Array.from(event.clipboardData.items)
            .filter((item) => item.kind === "file")
            .map((item) => item.getAsFile())
            .filter((file): file is File => file !== null);
          if (files.length === 0) return;
          event.preventDefault();
          attachments.add(files);
        }}
        rows={1}
        className="w-full resize-none bg-transparent text-sm leading-relaxed text-secondary-foreground outline-none"
        style={{ fontFamily }}
      />
      {attachments.items.length > 0 && (
        <div className="mt-2">
          <AttachmentStrip items={attachments.items} onRemove={attachments.remove} />
        </div>
      )}
      <div className="mt-2 flex items-center justify-between gap-2">
        <div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => {
              attachments.add(Array.from(event.target.files ?? []));
              event.target.value = "";
            }}
          />
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Add attachment"
            onClick={() => fileInputRef.current?.click()}
          >
            <Paperclip className="size-4" />
          </Button>
        </div>
        <div className="flex gap-2">
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
            disabled={!canSubmit || submitting}
            onClick={() => void submit()}
          >
            Send
          </Button>
        </div>
      </div>
    </div>
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
        data-disabled-at-rest={index >= count ? "true" : "false"}
        disabled={actionsDisabled || index >= count}
        onClick={() => onNavigate(1)}
        className="flex h-6 w-6 items-center justify-center rounded transition-colors hover:text-foreground disabled:opacity-40 disabled:hover:text-muted-foreground"
      >
        <ChevronRight className="h-4.5 w-4.5" />
      </button>
    </div>
  );
}

function WaitingDots() {
  return (
    <span className="flex gap-1 py-2" aria-label="Waiting for response">
      {[0, 150, 300].map((delay) => (
        <span
          key={delay}
          className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </span>
  );
}

export const MessageRow = memo(function MessageRow({
  message,
  instanceId,
  chunks,
  showDebug,
  userFontFamily,
  agentFontFamily,
  isEditing,
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
  showDebug: boolean;
  userFontFamily: string;
  agentFontFamily: string;
  isEditing: boolean;
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
    <div
      data-message-id={message.id}
      data-message-row
      role="listitem"
      className={cn("flex", message.role === "user" ? "justify-end" : "justify-start")}
      style={{ contentVisibility: "auto", containIntrinsicSize: "auto 96px" }}
    >
      {message.role === "user" ? (
        <div
          className={cn(
            "group flex flex-col items-end gap-1",
            isEditing ? "w-full" : "max-w-[80%]",
          )}
        >
          {isEditing ? (
            <UserMessageEditor
              initial={message.content}
              initialUploads={message.uploads ?? []}
              instanceId={instanceId}
              fontFamily={userFontFamily}
              onCancel={onCancelEdit}
              onSubmit={(content, uploads) => onSubmitEdit(message.id, content, uploads)}
            />
          ) : (
            <>
              {message.content && (
                <div
                  className="whitespace-pre-wrap break-words rounded-2xl bg-secondary px-4 py-2.5 text-sm text-secondary-foreground"
                  style={{ fontFamily: userFontFamily }}
                >
                  {message.content}
                </div>
              )}
              {message.uploads && message.uploads.length > 0 && (
                <MessageUploads instanceId={instanceId} uploads={message.uploads} />
              )}
              <div className="flex h-6 items-center" data-chat-action>
                <button
                  type="button"
                  aria-label="Edit message"
                  data-disabled-at-rest="false"
                  disabled={actionsDisabled}
                  onClick={() => onStartEdit(message.id)}
                  className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 disabled:pointer-events-none disabled:opacity-0"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                {version && (
                  <VersionPager
                    index={version.index}
                    count={version.count}
                    actionsDisabled={actionsDisabled}
                    onNavigate={(direction) => onNavigateVersion(message.id, direction)}
                  />
                )}
              </div>
            </>
          )}
        </div>
      ) : (
        <div
          className="w-full break-words pr-12 text-[15px] leading-relaxed text-foreground"
          style={{ fontFamily: agentFontFamily }}
        >
          {streaming && (!chunks || chunks.length === 0) ? (
            <WaitingDots />
          ) : chunks && chunks.length > 0 ? (
            <>
              <StreamView
                chunks={chunks}
                showDebug={showDebug}
                streaming={streaming}
                onRequestToolDetails={requestToolDetails}
              />
              {streaming && chunks.at(-1)?.kind === "text" && (
                <span className="ml-0.5 inline-block h-4 w-1 animate-pulse bg-muted-foreground align-text-bottom" />
              )}
            </>
          ) : (
            <StreamingMarkdown content={message.content} />
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
      )}
    </div>
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
          showDebug={shared.showDebug}
          userFontFamily={shared.userFontFamily}
          agentFontFamily={shared.agentFontFamily}
          isEditing={shared.editingId === message.id}
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
    const prependAnchorRef = useRef<{ element: HTMLElement; top: number } | null>(null);
    const resizeAnchorRef = useRef<{ element: HTMLElement; top: number } | null>(null);
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
    const sessionElements = useMemo(
      () =>
        sessionRows.map((row) => (
          <MessageRow
            key={row.renderKey}
            message={row.message}
            instanceId={instanceId}
            chunks={row.chunks}
            showDebug={showDebug}
            userFontFamily={userFontFamily}
            agentFontFamily={agentFontFamily}
            isEditing={editingId === row.message.id}
            actionsDisabled={actionsDisabled}
            onStartEdit={onStartEdit}
            onCancelEdit={onCancelEdit}
            onSubmitEdit={onSubmitEdit}
            onNavigateVersion={onNavigateVersion}
            onRequestToolDetails={onRequestToolDetails}
          />
        )),
      [
        actionsDisabled,
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
      ],
    );
    const liveElement = live ? (
      <MessageRow
        key={live.renderKey}
        message={live.message}
        instanceId={instanceId}
        chunks={live.chunks}
        streaming={live.streaming}
        showDebug={showDebug}
        userFontFamily={userFontFamily}
        agentFontFamily={agentFontFamily}
        isEditing={false}
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
      const element = findFirstVisibleRow(scrollElement, listElement);
      if (!element) return;
      prependAnchorRef.current = { element, top: element.getBoundingClientRect().top };
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
      const element = findFirstVisibleRow(scrollElement, listElement, 120);
      resizeAnchorRef.current = element
        ? { element, top: element.getBoundingClientRect().top }
        : null;
    }, [scrollElementRef]);

    const restoreRetainedAnchor = useCallback(() => {
      const anchor = resizeAnchorRef.current;
      const scrollElement = scrollElementRef.current;
      if (!scrollElement || !anchor?.element.isConnected) return;
      scrollElement.style.overflowAnchor = "none";
      const delta = anchor.element.getBoundingClientRect().top - anchor.top;
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
      if (scrollElement && anchor.element.isConnected) {
        scrollElement.scrollTop += anchor.element.getBoundingClientRect().top - anchor.top;
      }
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
        if (!prependAnchorRef.current && anchor?.element.isConnected) {
          const delta = anchor.element.getBoundingClientRect().top - anchor.top;
          if (Math.abs(delta) > 0.5) scrollElement.scrollTop += delta;
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
