// Presentational blocks for the assistant turn's chunk stream: tool-call
// cards, thinking callouts, retry banners, raw-event debug boxes, and the
// StreamView that lays a chunk list out. Pure display. All state that
// matters lives in Chat.tsx. These only own their local open/closed toggles.

import {
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
import { summarizeChatToolInput } from "@/lib/contracts";
import { cn } from "@/lib/utils";
import StreamingMarkdown from "../StreamingMarkdown";
import type { StreamChunk, ToolChunk } from "./chunks";

type ThoughtChunk = Extract<StreamChunk, { kind: "thought" }>;

// Visual presentation per tool: icon + present/past verb. Verb-based naming
// reads more naturally than the raw tool name ("Reading file.ts" vs "Read:
// file.ts"). Unknown tools get a generic wrench + the tool name as-is.
type ToolPresentation = { icon: LucideIcon; present: string; past: string };
const TOOL_PRESENTATIONS: Record<string, ToolPresentation> = {
  Bash: { icon: Terminal, present: "Running", past: "Ran" },
  Read: { icon: FileText, present: "Reading", past: "Read" },
  Write: { icon: FilePen, present: "Writing", past: "Wrote" },
  Edit: { icon: FilePen, present: "Editing", past: "Edited" },
  MultiEdit: { icon: FilePen, present: "Editing", past: "Edited" },
  NotebookEdit: { icon: FilePen, present: "Editing", past: "Edited" },
  Grep: { icon: Search, present: "Searching", past: "Searched" },
  Glob: { icon: Search, present: "Finding files", past: "Found files" },
  WebFetch: { icon: Globe, present: "Fetching", past: "Fetched" },
  WebSearch: {
    icon: Globe,
    present: "Searching the web",
    past: "Searched the web",
  },
  Task: { icon: Bot, present: "Delegating", past: "Delegated" },
  Agent: { icon: Bot, present: "Delegating", past: "Delegated" },
  TodoWrite: {
    icon: ListChecks,
    present: "Updating todos",
    past: "Updated todos",
  },
  // Codex item types
  exec_command: { icon: Terminal, present: "Running", past: "Ran" },
  file_change: { icon: FilePen, present: "Editing", past: "Edited" },
};
function presentationFor(name: string): ToolPresentation {
  return (
    TOOL_PRESENTATIONS[name] ?? {
      icon: Wrench,
      present: `Calling ${name}`,
      past: `Called ${name}`,
    }
  );
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

function useAnimatedInteger(target: number | undefined): number | undefined {
  const [displayed, setDisplayed] = useState(target === undefined ? undefined : 0);
  const displayedRef = useRef(displayed ?? 0);
  useEffect(() => {
    if (target === undefined) {
      displayedRef.current = 0;
      setDisplayed(undefined);
      return;
    }
    if (globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      displayedRef.current = target;
      setDisplayed(target);
      return;
    }
    const from = displayedRef.current;
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

const ThoughtBlock = memo(function ThoughtBlock({ chunk }: { chunk: ThoughtChunk }) {
  const active = chunk.status === "thinking";
  const [open, setOpen] = useState(chunk.provider === "claude");
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
        <span className="relative flex size-4 shrink-0 items-center justify-center">
          {active && (
            <span className="absolute inset-0 rounded-full bg-foreground/10 animate-ping motion-reduce:animate-none" />
          )}
          <Sparkles
            className={cn(
              "relative size-3.5 text-muted-foreground transition-colors",
              active && "thinking-spark text-foreground/80",
            )}
          />
        </span>
        <span
          className={cn("shrink-0 font-medium", active ? "text-shimmer" : "text-muted-foreground")}
        >
          {label}
        </span>
        {tokens !== undefined && (
          <span className="shrink-0 tabular-nums text-muted-foreground/80">
            · {tokens.toLocaleString()} tokens
          </span>
        )}
        {preview && !open && (
          <span className="min-w-0 truncate text-muted-foreground/80">· {preview}</span>
        )}
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
        className={cn(
          "grid transition-[grid-template-rows] duration-200 ease-out",
          open && canExpand ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="overflow-hidden">
          <div className="ml-2 mt-1 border-l border-border/70 pl-4 text-sm text-muted-foreground">
            <StreamingMarkdown content={displayText} streaming={active} />
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
  const { icon: Icon, present, past } = presentationFor(chunk.name);
  const isRunning = chunk.status === "running";
  const verb = chunk.isError ? "Failed" : isRunning ? present : past;
  useEffect(() => {
    if (open && chunk.detailsAvailable) onRequestDetails?.(chunk.id);
  }, [chunk, onRequestDetails, open]);
  return (
    <div data-tool-id={chunk.id} className="my-1.5 font-sans">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="group w-full flex items-center gap-2 text-left text-sm py-0.5 rounded transition-colors"
      >
        <Icon
          className={cn(
            "h-3.5 w-3.5 flex-shrink-0 transition-colors",
            chunk.isError
              ? "text-destructive"
              : isRunning
                ? "text-foreground/80"
                : "text-muted-foreground/80",
          )}
        />
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
          {verb}
        </span>
        {summary && (
          <span
            className={cn(
              "font-mono text-xs truncate min-w-0 flex-1",
              isRunning ? "text-foreground/70" : "text-muted-foreground/80",
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

// Memoized so a re-render of Chat (e.g. a tab switch flipping `visible`, or a
// streaming delta on a *different* message) doesn't reconcile every past
// turn's tool/thinking/markdown blocks. History chunk arrays keep a stable
// identity across renders (they're only replaced on chat switch), so the memo
// holds for the whole message list; the live streaming view still updates
// because its `chunks` array is rebuilt each frame.
export const StreamView = memo(function StreamView({
  chunks,
  showDebug,
  streaming = false,
  onRequestToolDetails,
}: {
  chunks: StreamChunk[];
  showDebug: boolean;
  streaming?: boolean;
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
            />
          );
        }
        if (chunk.kind === "tool") {
          return <ToolCallBlock key={i} chunk={chunk} onRequestDetails={onRequestToolDetails} />;
        }
        if (chunk.kind === "api_retry") return <RetryBlock key={i} chunk={chunk} />;
        if (chunk.kind === "thought") return <ThoughtBlock key={chunk.id} chunk={chunk} />;
        if (!showDebug) return null;
        if (chunk.kind === "thinking") return <ThinkingBlock key={i} text={chunk.text} />;
        return (
          <RawEventBox key={i} source={chunk.source} label={chunk.label} payload={chunk.payload} />
        );
      })}
    </>
  );
});
