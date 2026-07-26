import type { ChatProvider } from "../../contracts";
import {
  type HandoffContent,
  type HandoffItem,
  itemHasContent,
  makeHandoff,
  type PortableHandoff,
} from "./types";

// A parsed line from a Claude Code JSONL transcript. Deliberately permissive
// (version tolerant): only the fields the reconstruction needs are typed, and
// unknown fields are ignored. The extractor that produces these lines runs
// inside the guest VM; this module is the pure host-side interpreter, so it is
// unit-testable against recorded fixtures.
export interface ClaudeTranscriptEntry {
  uuid?: string;
  parentUuid?: string | null;
  type?: string;
  // Compact summaries are user-type entries flagged with this. The newest one
  // on the active chain supersedes everything it summarizes.
  isCompactSummary?: boolean;
  // Bookkeeping entries (teleport notices, hook records) that are not
  // conversation-bearing.
  isMeta?: boolean;
  // Subagent transcripts. Never part of the main logical chat.
  isSidechain?: boolean;
  // Present on system compact-boundary markers.
  compactMetadata?: unknown;
  message?: {
    role?: string;
    content?: unknown;
  };
  [key: string]: unknown;
}

// The exact prefix Claude prepends to a compact summary, and the transcript-path
// suggestion it appends. Both are provider-specific resume instructions that
// must not reach the target as user intent, so they are stripped, leaving the
// generated summary body. See getCompactUserSummaryMessage in Claude Code.
const SUMMARY_PREFIX =
  "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.";
const TRANSCRIPT_SUGGESTION_MARKER = "If you need specific details from before compaction";
const CONTINUE_MARKER = "Continue the conversation from where it left off";
const RECENT_PRESERVED_MARKER = "Recent messages are preserved verbatim.";

// Remove Claude's continuation wrapper from a compact summary, returning just
// the summary body. Tolerant of the wrapper's optional trailing paragraphs
// (transcript-path suggestion, continue-without-asking instruction).
export function stripClaudeSummaryWrapper(raw: string): string {
  let text = raw.trim();
  if (text.startsWith(SUMMARY_PREFIX)) {
    text = text.slice(SUMMARY_PREFIX.length).trimStart();
  }
  for (const marker of [TRANSCRIPT_SUGGESTION_MARKER, CONTINUE_MARKER, RECENT_PRESERVED_MARKER]) {
    const at = text.indexOf(marker);
    if (at !== -1) text = text.slice(0, at);
  }
  return text.trim();
}

// Reconstruct the active conversation chain using parentUuid links rather than
// physical line order (branches and forks interleave lines on disk). Walks from
// the leaf (the source anchor when given, otherwise the last conversation
// entry) up to the root, then reverses to root-first order. Cycle-guarded.
//
// The leaf fallback deliberately prefers the last user/assistant entry, not the
// last physical line: a real transcript ends with bookkeeping entries
// (ai-title, last-prompt, queue-operation) that have no parentUuid, and picking
// one of those as the leaf would yield a one-entry chain. The switch always
// passes an explicit anchor; the fallback is only for a missing/damaged anchor.
export function reconstructClaudeChain(
  entries: ClaudeTranscriptEntry[],
  anchorUuid?: string,
): ClaudeTranscriptEntry[] {
  const byUuid = new Map<string, ClaudeTranscriptEntry>();
  for (const entry of entries) {
    if (typeof entry.uuid === "string") byUuid.set(entry.uuid, entry);
  }
  let leaf: ClaudeTranscriptEntry | undefined;
  if (anchorUuid && byUuid.has(anchorUuid)) {
    leaf = byUuid.get(anchorUuid);
  } else {
    // Last conversation-bearing entry with a uuid, falling back to the last
    // entry with a uuid if the transcript has no conversation entries at all.
    for (let i = entries.length - 1; i >= 0 && !leaf; i--) {
      if (typeof entries[i]!.uuid === "string" && isConversationBearing(entries[i]!)) {
        leaf = entries[i];
      }
    }
    for (let i = entries.length - 1; i >= 0 && !leaf; i--) {
      if (typeof entries[i]!.uuid === "string") leaf = entries[i];
    }
  }
  if (!leaf) return [];
  const chain: ClaudeTranscriptEntry[] = [];
  const seen = new Set<string>();
  let current: ClaudeTranscriptEntry | undefined = leaf;
  while (current) {
    const uuid = current.uuid;
    if (typeof uuid === "string") {
      if (seen.has(uuid)) break; // corrupt cycle: stop with a partial chain
      seen.add(uuid);
    }
    chain.push(current);
    const parent: string | null | undefined = current.parentUuid;
    current = typeof parent === "string" ? byUuid.get(parent) : undefined;
  }
  return chain.reverse();
}

// The newest compact summary on the chain (closest to the tip). Later summaries
// supersede earlier ones and everything they summarize, so only this one is
// transferred. Returns its index in the chain, or -1 when there is none.
export function newestCompactSummaryIndex(chain: ClaudeTranscriptEntry[]): number {
  let index = -1;
  for (let i = 0; i < chain.length; i++) {
    if (chain[i]!.isCompactSummary === true) index = i;
  }
  return index;
}

// A hook for Claude's persisted content replacements: large tool results are
// stored on disk as pointers rather than inline, so the effective continuation
// context differs from the literal transcript bytes. The guest extractor is
// responsible for resolving those pointers before handing entries here; this
// pass is where any additional host-side reconciliation would live. Kept as an
// explicit identity step so the pipeline shape matches DESIGN.md and the
// behavior is easy to extend without restructuring.
function applyContentReplacements(entries: ClaudeTranscriptEntry[]): ClaudeTranscriptEntry[] {
  return entries;
}

function isConversationBearing(entry: ClaudeTranscriptEntry): boolean {
  if (entry.isMeta === true) return false;
  if (entry.isSidechain === true) return false;
  if (entry.compactMetadata !== undefined) return false;
  if (entry.type === "system") return false;
  return entry.type === "user" || entry.type === "assistant";
}

// The Isolade environment prelude is injected into the FIRST user message sent
// to the native session (wrapped in <prelude>…</prelude> by ChatTurnService)
// but is never stored in the Isolade message row. It appears in the Claude
// native transcript, so the Claude source path must strip it: the design
// excludes the old prelude because the target receives the current prelude
// separately, and leaving it in would present stale environment framing as
// user intent. Removes one leading prelude block (and the blank line after it).
export function stripIsoladePrelude(text: string): string {
  return text.replace(/^\s*<prelude>[\s\S]*?<\/prelude>\s*/, "");
}

// Extract the plain text of a content field that is either a string or an array
// of blocks with `text` on the text ones.
function blocksText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("");
}

// Map a tool_result block's content into portable content. Text transfers
// faithfully; anything non-text (image/binary) is marked unsupported so it
// requires the same explicit consent as any other lossy transfer (the guest
// extractor materializes files by path where it can, before entries reach here).
function toolResultContent(content: unknown): HandoffContent[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  const out: HandoffContent[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const type = (block as { type?: string }).type;
    if (type === "text") {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string") out.push({ type: "text", text });
    } else {
      out.push({
        type: "unsupported",
        reason: `non-text tool result block (${type ?? "unknown"})`,
      });
    }
  }
  return out;
}

// Convert one entry's message into ordered handoff items. Assistant text is
// interleaved with tool_use calls; thinking/redacted_thinking blocks and their
// signatures are dropped. A user entry yields a user item for its text and a
// tool_result item for each tool_result block.
function entryToItems(entry: ClaudeTranscriptEntry): HandoffItem[] {
  const role = entry.message?.role;
  const content = entry.message?.content;
  const items: HandoffItem[] = [];
  if (role === "assistant") {
    let textBuffer = "";
    const flush = () => {
      if (textBuffer.trim().length > 0) items.push({ kind: "assistant", text: textBuffer });
      textBuffer = "";
    };
    const blocks = Array.isArray(content) ? content : [];
    for (const raw of blocks) {
      if (!raw || typeof raw !== "object") continue;
      const block = raw as {
        type?: string;
        text?: unknown;
        id?: unknown;
        name?: unknown;
        input?: unknown;
      };
      switch (block.type) {
        case "text":
          if (typeof block.text === "string") textBuffer += block.text;
          break;
        case "tool_use":
          flush();
          items.push({
            kind: "tool_call",
            id: typeof block.id === "string" ? block.id : "",
            name: typeof block.name === "string" ? block.name : "tool",
            input: block.input,
          });
          break;
        // thinking / redacted_thinking and any signatures are never transferred.
        default:
          break;
      }
    }
    flush();
    if (items.length === 0 && typeof content === "string" && content.trim().length > 0) {
      items.push({ kind: "assistant", text: content });
    }
    return items;
  }
  if (role === "user") {
    const blocks = Array.isArray(content) ? content : [];
    const toolResults = blocks.filter(
      (b) => b && typeof b === "object" && (b as { type?: string }).type === "tool_result",
    );
    if (toolResults.length > 0) {
      for (const raw of toolResults) {
        const block = raw as { tool_use_id?: unknown; content?: unknown; is_error?: unknown };
        items.push({
          kind: "tool_result",
          id: typeof block.tool_use_id === "string" ? block.tool_use_id : "",
          content: toolResultContent(block.content),
          isError: block.is_error === true,
        });
      }
      return items;
    }
    const text = stripIsoladePrelude(blocksText(content));
    if (text.trim().length > 0) items.push({ kind: "user", text });
    return items;
  }
  return items;
}

export interface ClaudeHandoffOptions {
  // The source anchor (transcript uuid of the active tip). Selects the leaf of
  // the chain to reconstruct.
  anchorUuid?: string;
  // Recorded on the resulting handoff; defaults to "anthropic".
  source?: ChatProvider;
}

// Build a portable handoff from Claude JSONL entries: reconstruct the active
// chain, prefer the newest native compact summary (plus everything after it),
// strip the summary wrapper, and normalize the remaining conversation while
// excluding thinking, signatures, metadata, and compact-boundary records.
export function claudeEntriesToHandoff(
  entries: ClaudeTranscriptEntry[],
  options: ClaudeHandoffOptions = {},
): PortableHandoff {
  const source = options.source ?? "anthropic";
  const chain = applyContentReplacements(reconstructClaudeChain(entries, options.anchorUuid));
  const summaryAt = newestCompactSummaryIndex(chain);

  const items: HandoffItem[] = [];
  let startIndex = 0;
  if (summaryAt !== -1) {
    const summaryText = stripClaudeSummaryWrapper(blocksText(chain[summaryAt]!.message?.content));
    if (summaryText.length > 0) items.push({ kind: "summary", text: summaryText });
    // Everything the summary covers is superseded; continue after it.
    startIndex = summaryAt + 1;
  }
  for (let i = startIndex; i < chain.length; i++) {
    const entry = chain[i]!;
    if (entry.isCompactSummary === true) continue; // any older summary is superseded
    if (!isConversationBearing(entry)) continue;
    items.push(...entryToItems(entry));
  }
  return makeHandoff(source, items.filter(itemHasContent));
}
