// Presentational blocks for the assistant turn's chunk stream: tool-call
// cards, thinking callouts, retry banners, raw-event debug boxes, and the
// StreamView that lays a chunk list out. Pure display. All state that
// matters lives in Chat.tsx. These only own their local open/closed toggles.

import {
  Bot,
  FilePen,
  FileText,
  Globe,
  ListChecks,
  type LucideIcon,
  Search,
  Terminal,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import { memo, useState } from "react";
import { cn } from "@/lib/utils";
import Markdown from "../Markdown";
import type { StreamChunk, ToolChunk } from "./chunks";

// Short one-line preview of a tool's input shown next to the tool name in the
// collapsed header. Handles common Claude built-ins (Bash, Read, Edit, …) and
// Codex item shapes (command arrays) generically.
function summarizeToolInput(name: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  if (name === "Bash" && typeof o.command === "string") {
    return o.command.split("\n")[0] ?? "";
  }
  if (typeof o.file_path === "string") return o.file_path;
  if (typeof o.path === "string") return o.path;
  if (typeof o.url === "string") return o.url;
  if (typeof o.query === "string") return o.query;
  if (typeof o.pattern === "string") return o.pattern;
  if (typeof o.description === "string") return o.description;
  if (Array.isArray(o.command)) return (o.command as unknown[]).map(String).join(" ");
  if (typeof o.command === "string") return o.command;
  return "";
}

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

function ThinkingBlock({ text }: { text: string }) {
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
}

function RawEventBox({
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
}

function ToolCallBlock({ chunk }: { chunk: ToolChunk }) {
  const [open, setOpen] = useState(false);
  const summary = summarizeToolInput(chunk.name, chunk.input);
  const { icon: Icon, present, past } = presentationFor(chunk.name);
  const isRunning = chunk.status === "running";
  const verb = chunk.isError ? "Failed" : isRunning ? present : past;
  return (
    <div className="my-1.5 font-sans">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
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
}

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
function RetryBlock({ chunk }: { chunk: Extract<StreamChunk, { kind: "api_retry" }> }) {
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
}

// Memoized so a re-render of Chat (e.g. a tab switch flipping `visible`, or a
// streaming delta on a *different* message) doesn't reconcile every past
// turn's tool/thinking/markdown blocks. History chunk arrays keep a stable
// identity across renders (they're only replaced on chat switch), so the memo
// holds for the whole message list; the live streaming view still updates
// because its `chunks` array is rebuilt each frame.
export const StreamView = memo(function StreamView({
  chunks,
  showDebug,
}: {
  chunks: StreamChunk[];
  showDebug: boolean;
}) {
  return (
    <>
      {chunks.map((chunk, i) => {
        if (chunk.kind === "text") return <Markdown key={i} content={chunk.text} />;
        if (chunk.kind === "tool") return <ToolCallBlock key={i} chunk={chunk} />;
        if (chunk.kind === "api_retry") return <RetryBlock key={i} chunk={chunk} />;
        if (!showDebug) return null;
        if (chunk.kind === "thinking") return <ThinkingBlock key={i} text={chunk.text} />;
        return (
          <RawEventBox key={i} source={chunk.source} label={chunk.label} payload={chunk.payload} />
        );
      })}
    </>
  );
});
