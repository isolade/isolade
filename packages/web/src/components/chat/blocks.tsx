// Presentational blocks for the assistant turn's chunk stream: tool-call
// cards, thinking callouts, retry banners, raw-event debug boxes, and the
// StreamView that lays a chunk list out. Pure display. All state that
// matters lives in Chat.tsx. These only own their local open/closed toggles.

import {
  ArrowLeftRight,
  Bot,
  ChevronDown,
  FilePen,
  FileText,
  Globe,
  ListChecks,
  type LucideIcon,
  Search,
  Sparkles,
  Terminal,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import type { Upload } from "@/lib/contracts";
import { findChatModel, summarizeChatToolInput } from "@/lib/contracts";
import { cn } from "@/lib/utils";
import StreamingMarkdown from "../StreamingMarkdown";
import type { StreamChunk, ToolChunk } from "./chunks";
import { UserMessage } from "./UserMessage";

type ThoughtChunk = Extract<StreamChunk, { kind: "thought" }>;
const NO_USER_MESSAGE_CAPABILITIES = {};

// Visual presentation per tool: an icon, and a noun for the few tools whose own
// name reads like an internal identifier. No verb: a call renders as its icon
// plus the call's argument (a page icon next to "src/app.ts"), which says what
// happened without spending a word on it and leaves the full width to the
// argument. The `noun` only surfaces on calls that have no argument to show
// (see labelFor).
type ToolPresentation = { icon: LucideIcon; noun?: string };
const TOOL_PRESENTATIONS: Record<string, ToolPresentation> = {
  Bash: { icon: Terminal },
  Read: { icon: FileText },
  Write: { icon: FilePen },
  Edit: { icon: FilePen },
  MultiEdit: { icon: FilePen },
  NotebookEdit: { icon: FilePen },
  Grep: { icon: Search },
  Glob: { icon: Search },
  WebFetch: { icon: Globe },
  WebSearch: { icon: Globe },
  Task: { icon: Bot },
  Agent: { icon: Bot },
  TodoWrite: { icon: ListChecks, noun: "Todos" },
  // Codex names its calls itself (codexToolName in codex-backend.ts humanizes
  // the thread item type), so its shell and web search need their own entries
  // even though Claude's Bash and WebSearch are the same tools. Its "Edit" and
  // "Read" happen to land on Claude's keys above. Anything else Codex sends
  // falls through to the wrench with its name, which is what we want for the
  // long tail (McpToolCall, ImageGeneration, …).
  Shell: { icon: Terminal },
  "Web Search": { icon: Globe },
  FileChange: { icon: FilePen, noun: "File change" },
  Plan: { icon: ListChecks, noun: "Plan" },
};

// The words on a tool row, if any. Usually none, because the icon says what
// kind of call it is and the shimmer says whether it is still going. Three
// cases still need saying out loud:
//   - failures, where the icon's red tint on its own is too quiet to catch;
//   - tools we have no icon for, where the name is the only clue what ran;
//   - calls with no argument to show, which would otherwise leave a bare icon
//     sitting on an empty line.
function labelFor(name: string, isError: boolean, summary: string): string | undefined {
  const known = TOOL_PRESENTATIONS[name];
  if (isError) return known ? "Failed" : `${name} failed`;
  if (!known) return name;
  return summary ? undefined : (known.noun ?? name);
}

const ThinkingBlock = memo(function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  // Claude streams reasoning as natural language. Codex sends a full JSON
  // payload. Detect the latter so we render it as monospace block instead
  // of italic serif body text, which would be unreadable for JSON.
  const trimmed = text.trimStart();
  const isJson = trimmed.startsWith("{") || trimmed.startsWith("[");
  return (
    <div className="my-2 border-l-2 border-border pl-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <span>Thinking</span>
      </button>
      {open &&
        (isJson ? (
          <pre className="mt-1 font-mono text-xs text-muted-foreground whitespace-pre-wrap break-words leading-relaxed overflow-x-auto">
            {text}
          </pre>
        ) : (
          <p className="mt-1 italic text-muted-foreground whitespace-pre-wrap leading-relaxed">
            {text}
          </p>
        ))}
    </div>
  );
});

// Count a figure up toward `target`. Mounting does not animate: a block that
// arrives with tokens already spent (opening a chat that has been working while
// you were looking at another one) paints that figure straight away, rather
// than racing up to it from zero as if the thinking were starting now. Only
// growth this block sees happen counts up.
function useAnimatedInteger(target: number | undefined): number | undefined {
  const [displayed, setDisplayed] = useState(target);
  const displayedRef = useRef(target ?? 0);
  useEffect(() => {
    if (target === undefined) {
      displayedRef.current = 0;
      setDisplayed(undefined);
      return;
    }
    const from = displayedRef.current;
    if (from === target) {
      setDisplayed(target);
      return;
    }
    if (globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      displayedRef.current = target;
      setDisplayed(target);
      return;
    }
    const startedAt = performance.now();
    const duration = Math.min(700, Math.max(260, Math.abs(target - from) * 0.8));
    let frame = 0;
    const tick = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - (1 - progress) ** 3;
      const next = Math.round(from + (target - from) * eased);
      displayedRef.current = next;
      setDisplayed(next);
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target]);
  return displayed;
}

function thoughtPreview(text: string): string {
  const lines = text
    .replace(/<!--.*?-->/gs, "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  return (lines.at(-1) ?? "")
    .replace(/^#{1,6}\s+/, "")
    .replace(/^\*\*(.+)\*\*$/, "$1")
    .replace(/^__(.+)__$/, "$1");
}

function thoughtDisplayText(chunk: ThoughtChunk): string {
  if (chunk.provider !== "codex") return chunk.text;
  return chunk.text.replace(/\*\*(.*?)\*\*/gs, "$1").replace(/__(.*?)__/gs, "$1");
}

const ThoughtBlock = memo(function ThoughtBlock({
  chunk,
  cacheKey,
}: {
  chunk: ThoughtChunk;
  cacheKey?: string;
}) {
  const active = chunk.status === "thinking";
  // Collapsed until asked for, whichever provider it came from. Reasoning is
  // the agent's own bookkeeping, not part of its answer, and expanded by
  // default it pushes the answer off screen. The row still says the turn is
  // thinking, how many tokens it spent, and what it is on right now.
  const [open, setOpen] = useState(false);
  const tokens = useAnimatedInteger(chunk.tokens);
  const displayText = thoughtDisplayText(chunk);
  const preview = thoughtPreview(displayText);
  const canExpand = displayText.trim().length > 0;
  const label = active ? "Thinking" : "Thought";
  return (
    <div
      data-thinking-provider={chunk.provider}
      data-thinking-status={chunk.status}
      className="my-2 font-sans"
    >
      <button
        type="button"
        disabled={!canExpand}
        aria-expanded={canExpand ? open : undefined}
        onClick={() => canExpand && setOpen((value) => !value)}
        className="group flex max-w-full items-center gap-2 rounded-md py-0.5 text-left text-[13px] disabled:cursor-default"
      >
        <Sparkles
          className={cn(
            "size-3.5 shrink-0",
            active ? "text-foreground/80" : "text-muted-foreground",
          )}
        />
        {/* One run of text, so its separators are spaced like the separators
            everywhere else in the app: a space's worth of air on each side (see
            ComposerStatus). Sitting directly in the row instead, each dot took
            the row's icon-sized gap on its left and only a space on its right,
            which read as a dot belonging to the figure after it rather than
            standing between the two. */}
        <span className="flex min-w-0 items-center gap-1">
          <span
            className={cn(
              "shrink-0 font-medium",
              active ? "text-shimmer" : "text-muted-foreground",
            )}
          >
            {label}
          </span>
          {tokens !== undefined && (
            <>
              <span className="shrink-0 text-muted-foreground/80">·</span>
              <span className="shrink-0 tabular-nums text-muted-foreground/80">
                {tokens.toLocaleString()} tokens
              </span>
            </>
          )}
          {preview && !open && (
            <>
              <span className="shrink-0 text-muted-foreground/80">·</span>
              <span className="min-w-0 truncate text-muted-foreground/80">{preview}</span>
            </>
          )}
        </span>
        {canExpand && (
          <ChevronDown
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground/60 transition-transform duration-200 group-hover:text-muted-foreground",
              open && "rotate-180",
            )}
          />
        )}
      </button>
      <div
        data-thinking-body={open && canExpand ? "open" : "closed"}
        className={cn(
          "grid transition-[grid-template-rows] duration-200 ease-out",
          open && canExpand ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="overflow-hidden">
          <div className="ml-2 mt-1 border-l border-border/70 pl-4 text-sm text-muted-foreground">
            <StreamingMarkdown content={displayText} streaming={active} cacheKey={cacheKey} />
          </div>
        </div>
      </div>
    </div>
  );
});

const RawEventBox = memo(function RawEventBox({
  source,
  label,
  payload,
}: {
  source: "claude" | "codex";
  label: string;
  payload: unknown;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-1.5 rounded border border-dashed border-border/70 font-mono text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-2 py-1 text-left text-muted-foreground hover:text-foreground"
      >
        <span className="uppercase tracking-wider text-[10px] text-muted-foreground/70">
          {source}
        </span>
        <span className="text-foreground/80 truncate">{label}</span>
      </button>
      {open && (
        <pre className="px-2 pb-2 overflow-x-auto whitespace-pre-wrap break-words text-foreground/70">
          {JSON.stringify(payload, null, 2)}
        </pre>
      )}
    </div>
  );
});

const ToolCallBlock = memo(function ToolCallBlock({
  chunk,
  onRequestDetails,
}: {
  chunk: ToolChunk;
  onRequestDetails?: (toolId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const summary = chunk.summary ?? summarizeChatToolInput(chunk.input);
  const Icon = TOOL_PRESENTATIONS[chunk.name]?.icon ?? Wrench;
  const isRunning = chunk.status === "running";
  const label = labelFor(chunk.name, chunk.isError === true, summary);
  // The row leaves the tool and its state to the icon and the shimmer, neither
  // of which a screen reader can see, so spell them out for it.
  const spokenLabel = [
    chunk.name,
    chunk.isError ? "failed" : isRunning ? "running" : "done",
    summary,
  ]
    .filter(Boolean)
    .join(" · ");
  useEffect(() => {
    if (open && chunk.detailsAvailable) onRequestDetails?.(chunk.id);
  }, [chunk, onRequestDetails, open]);
  return (
    <div data-tool-id={chunk.id} className="my-1.5 font-sans">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={spokenLabel}
        className="group w-full flex items-center gap-2 text-left text-sm py-0.5 rounded"
      >
        <Icon
          className={cn(
            "h-3.5 w-3.5 flex-shrink-0",
            chunk.isError
              ? "text-destructive"
              : isRunning
                ? "text-foreground/80"
                : "text-muted-foreground/80",
          )}
        />
        {label && (
          <span
            className={cn(
              "text-[13px] flex-shrink-0",
              chunk.isError
                ? "text-destructive font-medium"
                : isRunning
                  ? "text-shimmer font-medium"
                  : "text-muted-foreground",
            )}
          >
            {label}
          </span>
        )}
        {summary && (
          // The shimmer used to live on the verb. With the verb gone the
          // argument carries it, so an in-flight call still reads as active.
          <span
            className={cn(
              "font-mono text-xs truncate min-w-0 flex-1",
              isRunning ? "text-shimmer" : "text-muted-foreground/80",
            )}
          >
            {summary}
          </span>
        )}
      </button>
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-200 ease-out",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="overflow-hidden">
          <div className="pl-[1.375rem] pr-1 pt-1.5 pb-1 space-y-1.5 font-mono text-xs">
            {chunk.input !== undefined && (
              <ToolPayload
                label="Input"
                body={
                  typeof chunk.input === "string"
                    ? chunk.input
                    : JSON.stringify(chunk.input, null, 2)
                }
              />
            )}
            {chunk.output !== undefined && (
              <ToolPayload
                label={chunk.isError ? "Error" : "Output"}
                body={chunk.output}
                tone={chunk.isError ? "error" : undefined}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
});

function ToolPayload({ label, body, tone }: { label: string; body: string; tone?: "error" }) {
  return (
    <div>
      <div className="text-muted-foreground/60 mb-0.5 text-[10px] uppercase tracking-wider">
        {label}
      </div>
      <pre
        className={cn(
          "whitespace-pre-wrap break-words rounded-md border border-border/50 bg-muted/40 px-2.5 py-1.5 max-h-80 overflow-x-auto overflow-y-auto leading-relaxed",
          tone === "error" ? "text-destructive" : "text-foreground/85",
        )}
      >
        {body}
      </pre>
    </div>
  );
}

// Inline banner for the CLI's api_retry backoff. Visible without debug
// mode so the user sees "connection trouble" instead of silent thinking
// dots. The most common failure mode in practice is a transport-level
// error (DNS/TCP reset) where the SDK emits up to 10 retries spanning
// minutes before either recovering or giving up with exit code 1.
const RetryBlock = memo(function RetryBlock({
  chunk,
}: {
  chunk: Extract<StreamChunk, { kind: "api_retry" }>;
}) {
  const reason = chunk.errorStatus
    ? `HTTP ${chunk.errorStatus}`
    : chunk.error && chunk.error !== "unknown"
      ? chunk.error
      : "connection problem";
  const exhausted = chunk.maxRetries > 0 && chunk.attempt >= chunk.maxRetries;
  return (
    <div className="my-1.5 flex items-center gap-2 rounded border border-amber-500/40 bg-amber-500/5 px-2 py-1 text-xs text-amber-700 dark:text-amber-300">
      <TriangleAlert className="h-3.5 w-3.5 flex-shrink-0" />
      <span className="font-medium">{exhausted ? "Final retry" : "Retrying"}</span>
      <span className="text-muted-foreground">
        {reason}
        {chunk.maxRetries > 0 && ` · attempt ${chunk.attempt}/${chunk.maxRetries}`}
        {!exhausted &&
          chunk.retryDelayMs > 0 &&
          ` · next in ${Math.round(chunk.retryDelayMs / 1000)}s`}
      </span>
    </div>
  );
});

const InterruptionMarker = memo(function InterruptionMarker({ id }: { id: string }) {
  return (
    <div
      data-agent-interrupted={id}
      className="-mr-12 my-4 flex items-center gap-2 text-xs text-muted-foreground"
    >
      <span className="h-px flex-1 bg-border" />
      <span>Agent interrupted</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
});

// Prefer the catalog model name (e.g. "Opus 4.8"), falling back to the id.
function modelLabel(modelId: string): string {
  return findChatModel(modelId)?.name ?? modelId;
}

export type ProviderSwitchChunk = Extract<StreamChunk, { kind: "provider_switch" }>;

// The provider-switch marker for a turn, if any. It leads the target turn's
// chunks; the caller renders it above that turn's user message.
export function providerSwitchOf(
  chunks: StreamChunk[] | undefined,
): ProviderSwitchChunk | undefined {
  return chunks?.find((c): c is ProviderSwitchChunk => c.kind === "provider_switch");
}

// The divider marking where a chat switched providers, rendered above the user
// message that triggered the switch (that message and everything after it ran
// on the new model). Persisted like any other chunk, so it survives a reload.
export const ProviderSwitchDivider = memo(function ProviderSwitchDivider({
  chunk,
}: {
  chunk: ProviderSwitchChunk;
}) {
  const label = chunk.fromModel
    ? `Switched from ${modelLabel(chunk.fromModel)} to ${modelLabel(chunk.toModel)}`
    : `Switched to ${modelLabel(chunk.toModel)}`;
  return (
    <div
      className="my-2 flex items-center gap-2 text-xs text-muted-foreground"
      data-testid="provider-switch-divider"
    >
      <span className="h-px flex-1 bg-border" />
      <ArrowLeftRight className="h-3.5 w-3.5 flex-shrink-0" />
      <span className="font-medium">{label}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
});

// Memoized so a re-render of Chat (e.g. a tab switch flipping `visible`, or a
// streaming delta on a *different* message) doesn't reconcile every past
// turn's tool/thinking/markdown blocks. History chunk arrays keep a stable
// identity across renders (they're only replaced on chat switch), so the memo
// holds for the whole message list; the live streaming view still updates
// because its `chunks` array is rebuilt each frame.
export const StreamView = memo(function StreamView({
  chunks,
  cacheScope,
  showDebug,
  streaming = false,
  instanceId,
  userFontFamily,
  editingUserMessageId,
  actionsDisabled,
  onStartUserMessageEdit,
  onCancelUserMessageEdit,
  onSubmitUserMessageEdit,
  onRequestToolDetails,
}: {
  chunks: StreamChunk[];
  /**
   * Stable identity for the message these chunks belong to. Each piece keys its
   * parser off it, so the parse outlives the row's mount. Absent for a turn
   * that has not committed yet, which has no id to key by.
   */
  cacheScope?: string;
  showDebug: boolean;
  streaming?: boolean;
  instanceId: string;
  userFontFamily: string;
  editingUserMessageId?: string | null;
  actionsDisabled?: boolean;
  onStartUserMessageEdit?: (id: string) => void;
  onCancelUserMessageEdit?: () => void;
  onSubmitUserMessageEdit?: (id: string, content: string, uploads: Upload[]) => void;
  onRequestToolDetails?: (toolId: string) => void;
}) {
  return (
    <>
      {chunks.map((chunk, i) => {
        if (chunk.kind === "text") {
          return (
            <StreamingMarkdown
              key={i}
              content={chunk.text}
              streaming={streaming && i === chunks.length - 1}
              cacheKey={cacheScope === undefined ? undefined : `${cacheScope}:text:${i}`}
            />
          );
        }
        if (chunk.kind === "tool") {
          return <ToolCallBlock key={i} chunk={chunk} onRequestDetails={onRequestToolDetails} />;
        }
        if (chunk.kind === "user_message") {
          return (
            <UserMessage
              key={chunk.id}
              message={chunk}
              capabilities={chunk.capabilities ?? NO_USER_MESSAGE_CAPABILITIES}
              instanceId={instanceId}
              fontFamily={userFontFamily}
              inline
              editing={editingUserMessageId === chunk.id}
              actionsDisabled={actionsDisabled}
              onStartEdit={onStartUserMessageEdit}
              onCancelEdit={onCancelUserMessageEdit}
              onSubmitEdit={onSubmitUserMessageEdit}
            />
          );
        }
        if (chunk.kind === "interruption") {
          return <InterruptionMarker key={chunk.id} id={chunk.id} />;
        }
        if (chunk.kind === "api_retry") return <RetryBlock key={i} chunk={chunk} />;
        if (chunk.kind === "thought") {
          return (
            <ThoughtBlock
              key={chunk.id}
              chunk={chunk}
              cacheKey={cacheScope === undefined ? undefined : `${cacheScope}:thought:${chunk.id}`}
            />
          );
        }
        // The provider-switch divider renders above the triggering user message
        // (see MessageRow.switchAbove), not inside the assistant bubble.
        if (chunk.kind === "provider_switch") return null;
        if (!showDebug) return null;
        if (chunk.kind === "thinking") return <ThinkingBlock key={i} text={chunk.text} />;
        return (
          <RawEventBox key={i} source={chunk.source} label={chunk.label} payload={chunk.payload} />
        );
      })}
    </>
  );
});
