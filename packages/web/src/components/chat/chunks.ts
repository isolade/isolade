// The chat turn's pure data model: the renderable chunk stream an assistant
// turn reduces to, the event->chunk reducer shared by live streaming and
// server-side history compaction, and usage-state rehydration helpers. No
// React in here. Chat.tsx owns the stateful machinery.
import {
  applyChatRenderEvent,
  type ChatRenderChunk,
  type Chat as ChatRow,
  type SubscriptionShare,
  summarizeChatToolInput,
  TOOL_INPUT_PREVIEW_CHARS,
  TOOL_OUTPUT_PREVIEW_CHARS,
  type TokenUsage,
  type ToolRenderChunk,
} from "../../lib/contracts";

export type { SubscriptionShare, TokenUsage };

export interface UsageState {
  last: TokenUsage;
  total: TokenUsage;
  modelContextWindow?: number;
  costUsd?: number;
  subscriptionShare?: SubscriptionShare;
  compacted?: boolean;
}

// One renderable piece of an assistant turn. Each variant has its own UI:
// - text: streamed Markdown body
// - thinking: extended-thinking block, italic body text in a subtle callout
// - tool: a single tool call (start + input + result merged by id), shown as
//   a collapsible card with a one-line summary
// - raw: any other provider event (unknown shapes) shown as a collapsible
//   labelled box with full JSON payload (debug only)
export type ToolChunk = ToolRenderChunk;
export type StreamChunk = ChatRenderChunk;

// Reduce one persisted SSE event into a chunk stream, mutating in place.
// Shared between live streaming (where the live reducer wraps it with state
// updates + scroll calls) and mount-time replay (which just folds the array).
// Per-id tool index passed in so callers can keep state across events.
export const applyEvent = applyChatRenderEvent;

/** Merge a focused full-detail response into a live reducer without replacing
 * text or tool state that may have advanced while the request was in flight. */
export interface ToolDetailsMergeResult {
  matched: boolean;
  changed: boolean;
  complete: boolean;
}

export function mergeToolDetails(
  current: StreamChunk[],
  fetched: readonly StreamChunk[],
  toolId: string,
): ToolDetailsMergeResult {
  const index = current.findIndex((chunk) => chunk.kind === "tool" && chunk.id === toolId);
  const chunk = current[index];
  const full = fetched.find(
    (candidate): candidate is ToolChunk => candidate.kind === "tool" && candidate.id === toolId,
  );
  if (index < 0 || chunk?.kind !== "tool" || !full) {
    return { matched: false, changed: false, complete: false };
  }
  const inputIsPreview =
    typeof chunk.input === "string" &&
    chunk.input.length === TOOL_INPUT_PREVIEW_CHARS + 1 &&
    chunk.input.endsWith("…");
  const outputIsPreview =
    typeof chunk.output === "string" &&
    chunk.output.length === TOOL_OUTPUT_PREVIEW_CHARS + 1 &&
    chunk.output.endsWith("…");
  const input =
    (chunk.input === undefined || inputIsPreview) && full.input !== undefined
      ? full.input
      : chunk.input;
  const output =
    (chunk.output === undefined || outputIsPreview) && full.output !== undefined
      ? full.output
      : chunk.output;
  const summary = full.summary ?? chunk.summary ?? summarizeChatToolInput(full.input);
  const detailsAvailable =
    (typeof input === "string" &&
      input.length === TOOL_INPUT_PREVIEW_CHARS + 1 &&
      input.endsWith("…")) ||
    (typeof output === "string" &&
      output.length === TOOL_OUTPUT_PREVIEW_CHARS + 1 &&
      output.endsWith("…"));
  const changed =
    summary !== chunk.summary ||
    input !== chunk.input ||
    output !== chunk.output ||
    detailsAvailable !== chunk.detailsAvailable;
  if (!changed) return { matched: true, changed: false, complete: !detailsAvailable };
  current[index] = {
    ...chunk,
    summary,
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    detailsAvailable,
  };
  return { matched: true, changed: true, complete: !detailsAvailable };
}

// Atomically replace a live reducer from a server snapshot, then apply events
// that arrived while the snapshot request was in flight. Used when debug is
// enabled mid-turn so earlier reasoning/raw frames appear without reconnecting
// or losing newer deltas.
export function replaceChunksFromSnapshot(
  chunks: StreamChunk[],
  toolIndex: Map<string, number>,
  snapshot: StreamChunk[],
  snapshotLastSeq: number,
  bufferedEvents: Iterable<{ seq: number; type: string; payload: unknown }>,
): void {
  chunks.splice(0, chunks.length, ...snapshot);
  toolIndex.clear();
  for (const [index, chunk] of chunks.entries()) {
    if (chunk.kind === "tool") toolIndex.set(chunk.id, index);
  }
  for (const event of bufferedEvents) {
    if (event.seq <= snapshotLastSeq) continue;
    applyEvent(chunks, toolIndex, event.type, event.payload);
  }
}

/** Number of readable UTF-16 code units in a live chunk stream. Structural
 * chunks have no reveal cost and appear after the readable content before
 * them has become visible. */
export function revealableLength(chunks: readonly StreamChunk[]): number {
  let length = 0;
  for (const chunk of chunks) {
    if (chunk.kind === "text" || chunk.kind === "thinking") length += chunk.text.length;
  }
  return length;
}

function safeSliceEnd(text: string, requested: number): number {
  const end = Math.min(text.length, requested);
  if (end <= 0 || end >= text.length) return end;
  const previous = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  const splitsSurrogatePair =
    previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
  return splitsSurrogatePair ? end - 1 : end;
}

/** Project a live stream down to a readable-character budget. The returned
 * array is always a new snapshot because the reducer mutates its target array
 * in place, while memoized React children depend on a new array identity. */
export function revealChunks(chunks: readonly StreamChunk[], budget: number): StreamChunk[] {
  const revealed: StreamChunk[] = [];
  let remaining = Math.max(0, budget);
  for (const chunk of chunks) {
    if (chunk.kind !== "text" && chunk.kind !== "thinking") {
      revealed.push(chunk);
      continue;
    }
    if (remaining >= chunk.text.length) {
      revealed.push(chunk);
      remaining -= chunk.text.length;
      continue;
    }
    const end = safeSliceEnd(chunk.text, remaining);
    if (end > 0) revealed.push({ ...chunk, text: chunk.text.slice(0, end) });
    return revealed;
  }
  return revealed;
}

// Visible live output advances at a steady cadence. A bounded catch-up rate
// prevents large provider deltas from leaving the rendered response far behind.
export const REVEAL_CHARACTERS_PER_SECOND = 320;
export const REVEAL_LAG_CHARACTERS = 200;
export const REVEAL_CATCHUP_SECONDS = 0.3;
export const REVEAL_MAX_CHARACTERS_PER_SECOND = 700;

// Rebuild a UsageState snapshot from the persisted chat row. Returns null
// when the chat has never streamed (cumulative totals are null). In that
// case the composer panel renders unchanged until the first SSE `usage`.
export function usageSeedFromChat(chat: ChatRow): UsageState | null {
  if (chat.inputTokens == null) return null;
  const total = {
    inputTokens: chat.inputTokens,
    cachedInputTokens: chat.cachedInputTokens ?? 0,
    cacheCreationInputTokens: chat.cacheCreationInputTokens ?? 0,
    outputTokens: chat.outputTokens ?? 0,
    reasoningOutputTokens: chat.reasoningOutputTokens ?? 0,
    totalTokens:
      (chat.inputTokens ?? 0) +
      (chat.cachedInputTokens ?? 0) +
      (chat.cacheCreationInputTokens ?? 0) +
      (chat.outputTokens ?? 0) +
      (chat.reasoningOutputTokens ?? 0),
  };
  // Per-turn breakdown falls back to the cumulative one for chats that
  // predate the last_* columns: better to overstate "last turn" with the
  // running totals than to render zeros.
  const last = {
    inputTokens: chat.lastInputTokens ?? total.inputTokens,
    cachedInputTokens: chat.lastCachedInputTokens ?? total.cachedInputTokens,
    cacheCreationInputTokens: chat.lastCacheCreationInputTokens ?? total.cacheCreationInputTokens,
    outputTokens: chat.lastOutputTokens ?? total.outputTokens,
    reasoningOutputTokens: chat.lastReasoningOutputTokens ?? total.reasoningOutputTokens,
    totalTokens: 0,
  };
  last.totalTokens =
    last.inputTokens +
    last.cachedInputTokens +
    last.cacheCreationInputTokens +
    last.outputTokens +
    last.reasoningOutputTokens;
  return {
    last,
    total,
    modelContextWindow: chat.modelContextWindow ?? undefined,
    costUsd: chat.costUsd ?? undefined,
    subscriptionShare: chat.subscriptionShare,
    compacted: chat.compacted ?? undefined,
  };
}
