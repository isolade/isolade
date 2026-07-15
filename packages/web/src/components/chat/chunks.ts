// The chat turn's pure data model: the renderable chunk stream an assistant
// turn reduces to, the event->chunk reducer shared by live streaming and
// mount-time replay, the typewriter-reveal projection over it, and the
// usage-state rehydration helpers. No React in here. Chat.tsx owns the
// stateful machinery, this module owns the shapes and folds it runs on.
import type { ChatEvent, Chat as ChatRow } from "../../lib/contracts";

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface SubscriptionShare {
  plan: { id: string; label: string };
  fiveHourPct: number | null;
  sevenDayPct: number | null;
  fiveHourCurrentPct: number | null;
  sevenDayCurrentPct: number | null;
}

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
export type ToolChunk = {
  kind: "tool";
  id: string;
  name: string;
  input?: unknown;
  output?: string;
  isError?: boolean;
  status: "running" | "done";
};
export type StreamChunk =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | ToolChunk
  // Consecutive `api_retry` events from the CLI coalesce into a single
  // chunk so a 10-retry burst doesn't stack 10 banners. Reset whenever a
  // non-retry event lands, so a successful recovery turns into one
  // historical banner followed by the real response.
  | {
      kind: "api_retry";
      attempt: number;
      maxRetries: number;
      retryDelayMs: number;
      errorStatus: number | null;
      error: string | null;
    }
  | {
      kind: "raw";
      source: "claude" | "codex";
      label: string;
      payload: unknown;
    };

// Reduce one persisted SSE event into a chunk stream, mutating in place.
// Shared between live streaming (where the live reducer wraps it with state
// updates + scroll calls) and mount-time replay (which just folds the array).
// Per-id tool index passed in so callers can keep state across events.
export function applyEvent(
  chunks: StreamChunk[],
  toolIndex: Map<string, number>,
  type: string,
  payload: unknown,
): void {
  switch (type) {
    case "delta": {
      const text = typeof payload === "string" ? payload : String(payload ?? "");
      const last = chunks[chunks.length - 1];
      if (last?.kind === "text") last.text += text;
      else chunks.push({ kind: "text", text });
      return;
    }
    case "thinking": {
      const p = payload as { text?: string } | null;
      chunks.push({ kind: "thinking", text: p?.text ?? "" });
      return;
    }
    case "tool_call_start": {
      const p = payload as { id?: string; name?: string };
      if (!p?.id) return;
      const idx = toolIndex.get(p.id);
      if (idx !== undefined) {
        const cur = chunks[idx];
        if (cur?.kind === "tool")
          chunks[idx] = { ...cur, name: p.name ?? cur.name, status: "running" };
      } else {
        toolIndex.set(p.id, chunks.length);
        chunks.push({
          kind: "tool",
          id: p.id,
          name: p.name ?? "tool",
          status: "running",
        });
      }
      return;
    }
    case "tool_call_input": {
      const p = payload as { id?: string; input?: unknown };
      if (!p?.id) return;
      const idx = toolIndex.get(p.id);
      if (idx === undefined) return;
      const cur = chunks[idx];
      if (cur?.kind === "tool") chunks[idx] = { ...cur, input: p.input };
      return;
    }
    case "tool_call_result": {
      const p = payload as { id?: string; output?: string; isError?: boolean };
      if (!p?.id) return;
      const idx = toolIndex.get(p.id);
      if (idx === undefined) return;
      const cur = chunks[idx];
      if (cur?.kind === "tool") {
        chunks[idx] = {
          ...cur,
          output: p.output,
          isError: p.isError,
          status: "done",
        };
      }
      return;
    }
    case "raw": {
      const p = payload as { source?: "claude" | "codex"; payload?: unknown };
      const source = p?.source ?? "claude";
      chunks.push({
        kind: "raw",
        source,
        label: rawLabel(source, p?.payload),
        payload: p?.payload,
      });
      return;
    }
    case "api_retry": {
      const p = payload as {
        attempt?: number;
        maxRetries?: number;
        retryDelayMs?: number;
        errorStatus?: number | null;
        error?: string | null;
      };
      const last = chunks[chunks.length - 1];
      const next = {
        kind: "api_retry" as const,
        attempt: p?.attempt ?? 0,
        maxRetries: p?.maxRetries ?? 0,
        retryDelayMs: p?.retryDelayMs ?? 0,
        errorStatus: p?.errorStatus ?? null,
        error: p?.error ?? null,
      };
      if (last?.kind === "api_retry") chunks[chunks.length - 1] = next;
      else chunks.push(next);
      return;
    }
    // usage / context_compacted / title / message_id don't produce chunks.
    // They update the chat-level usage panel or the parent's title.
    // turn_started is a DB-only marker (seq=-1) used purely for
    // in-flight detection during hydration. Resume replay filters it
    // out, but mount-time event hydration via listChatEvents still
    // sees it, so we no-op it here.
    default:
      return;
  }
}

// Total number of "readable" characters across the chunk stream: the text
// and reasoning the typewriter reveal animates. Structural chunks (tools,
// retries, raw) carry no reveal cost, and they're gated only by the text that
// precedes them.
export function revealableLen(chunks: StreamChunk[]): number {
  let n = 0;
  for (const c of chunks) {
    if (c.kind === "text" || c.kind === "thinking") n += c.text.length;
  }
  return n;
}

// Project the target chunk stream down to the first `budget` readable
// characters, in order. Text/thinking chunks are sliced at the boundary.
// Structural chunks ride along only once the text before them is fully
// revealed, so tool calls never appear ahead of the prose that introduced
// them. This is what the typewriter renders mid-reveal. Once `budget`
// reaches revealableLen() it returns the full stream unchanged.
export function truncateChunks(chunks: StreamChunk[], budget: number): StreamChunk[] {
  const out: StreamChunk[] = [];
  for (const c of chunks) {
    if (c.kind === "text" || c.kind === "thinking") {
      if (budget >= c.text.length) {
        out.push(c);
        budget -= c.text.length;
      } else {
        if (budget > 0) out.push({ ...c, text: c.text.slice(0, budget) });
        return out;
      }
    } else {
      out.push(c);
    }
  }
  return out;
}

// Typewriter reveal cadence (see pumpReveal in drainTurn). The animation
// drains the received-but-unshown text at a CONSTANT characters-per-second so
// it reads as even typing, not the burst-then-stall of a backlog-proportional
// rate. REVEAL_CPS is the speed you see almost all the time, and the catch-up only
// engages once more than REVEAL_LAG_CHARS is buffered (a big Claude block
// landed, or generation outran the animation), ramping up to clear the excess
// over ~REVEAL_CATCHUP_SEC, capped at REVEAL_MAX_CPS so it never looks like a
// paste. Tune REVEAL_CPS for feel. Raise REVEAL_MAX_CPS / lower the lag budget
// to track real-time output more tightly at the cost of a less even cadence.
// Master switch for the typewriter reveal. Temporarily false to restore the
// previous behaviour where streamed text renders immediately as it arrives.
// Flip back to true to re-enable the animation. The machinery below stays in
// place either way.
export const REVEAL_ANIMATION: boolean = true;
export const REVEAL_CPS = 320;
export const REVEAL_LAG_CHARS = 200;
export const REVEAL_CATCHUP_SEC = 0.3;
export const REVEAL_MAX_CPS = 700;

// Replay a chronological list of events for a single assistant message
// into its final StreamChunk[]. Used by the mount-time replay path.
export function chunksFromEvents(events: ChatEvent[]): StreamChunk[] {
  const chunks: StreamChunk[] = [];
  const toolIndex = new Map<string, number>();
  for (const ev of events) {
    let payload: unknown;
    try {
      payload = JSON.parse(ev.payload);
    } catch (err) {
      // Server-side invariant: chat_events.payload is always
      // JSON.stringify-d. A parse failure here indicates a corrupt
      // row, so log it so the cause is debuggable from console.
      console.warn(`[chat] event payload not JSON (seq=${ev.seq} type=${ev.type}):`, err);
      payload = ev.payload;
    }
    applyEvent(chunks, toolIndex, ev.type, payload);
  }
  return chunks;
}

// Pick the most recent usage event across all messages. That's what the
// live stream would have left in UsageState. The chat row already carries
// totals/cost/window for Tier-1 hydration, and the event log is the authority
// for `subscriptionShare` (server-computed, not stored on the row).
// Returns nulls for chats that have never streamed.
export function latestUsageFromEvents(events: ChatEvent[]): {
  payload: {
    last: TokenUsage;
    total: TokenUsage;
    modelContextWindow?: number;
    costUsd?: number;
    subscriptionShare?: SubscriptionShare;
  } | null;
  compacted: boolean;
} {
  let latest: ChatEvent | undefined;
  let compacted = false;
  for (const ev of events) {
    if (ev.type === "usage") {
      // createdAt is a Date thanks to the dateLikeSchema in shared.
      const ts = new Date(ev.createdAt).getTime();
      const cur = latest ? new Date(latest.createdAt).getTime() : -Infinity;
      if (ts >= cur) latest = ev;
    } else if (ev.type === "context_compacted") {
      compacted = true;
    }
  }
  if (!latest) return { payload: null, compacted };
  try {
    return { payload: JSON.parse(latest.payload), compacted };
  } catch (err) {
    console.warn(`[chat] usage event payload not JSON (seq=${latest.seq}):`, err);
    return { payload: null, compacted };
  }
}

// Best-effort label for a raw provider event. We don't need to be exhaustive
// here, since the goal is just to make the collapsed card more informative than
// "unknown event".
function rawLabel(source: "claude" | "codex", payload: unknown): string {
  if (payload && typeof payload === "object") {
    const o = payload as Record<string, unknown>;
    if (typeof o.method === "string") return o.method;
    if (typeof o.type === "string") {
      if (o.type === "stream_event" && o.event && typeof o.event === "object") {
        const inner = o.event as Record<string, unknown>;
        if (typeof inner.type === "string") return inner.type;
      }
      return o.type;
    }
  }
  return source === "claude" ? "claude event" : "codex event";
}

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
