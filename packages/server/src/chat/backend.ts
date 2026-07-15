// The provider-neutral chat-backend contract: the interface both the Claude
// and Codex backends implement, and the event/usage shapes they emit. Nothing
// in here knows about either provider's wire format. That lives in the
// respective backend.
import type { ChatEffort, ContextBreakdown } from "../contracts";

// Token-usage breakdown shared by both providers. We keep the three input
// buckets separate because they're weighted very differently for both billing
// and rate limits:
//   - `inputTokens` is fresh prompt content (full price, full rate-limit weight)
//   - `cachedInputTokens` is served from cache (Anthropic's
//     `cache_read_input_tokens` / codex's `cachedInputTokens`), at 10% of input
//     price, and on modern Anthropic models 0× toward ITPM rate limits
//   - `cacheCreationInputTokens` is written to cache (Anthropic's
//     `cache_creation_input_tokens`), at 1.25× input price (5-min TTL) and 1×
//     toward ITPM. Codex's billing doesn't separate writes from reads, so
//     this stays 0 there.
// `totalTokens` is the sum of all four token buckets (input + cached +
// cacheCreation + output + reasoning).
export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

// Structured events emitted by both backends on top of the plain text stream.
// Each variant gets its own SSE event name and its own UI treatment, so we
// avoid lumping unrelated provider events into a single "debug" bucket.
//
// `raw` is the honest catch-all for genuinely unrecognized provider events.
// Anything we know how to identify (thinking blocks, tool calls, …) is
// emitted as a typed variant instead.
export type ChatEvent =
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_input"; id: string; input: unknown }
  | { type: "tool_call_result"; id: string; output: string; isError?: boolean }
  | { type: "thinking"; text: string }
  | {
      type: "usage";
      // `last` is this turn's usage. `total` is cumulative across the whole
      // session. The UI typically uses last.input+cachedInput as the
      // "context packed in" number and `total` for cost/total tracking.
      last: TokenUsage;
      total: TokenUsage;
      // Window for the active model. Codex sends this. For Claude we look it
      // up from the catalog. Undefined when neither source knows.
      modelContextWindow?: number;
      // API-equivalent dollar cost for this chat (cumulative). Claude
      // reports `total_cost_usd` directly. codex is derived from the
      // catalog pricing × tokens.
      costUsd?: number;
      // Approximate subscription consumption derived from cumulative
      // tokens × catalog rate-plan budgets. Optional: omitted when we
      // can't resolve the plan or pricing. Populated by the turn service
      // before forwarding, not by the backends themselves.
      subscriptionShare?: import("./subscription-share").SubscriptionShare;
    }
  | { type: "context_compacted" }
  // The CLI's `system/api_retry` envelope, surfaced as a typed event so the
  // chat UI can show "connection trouble" inline instead of leaving the
  // user staring at silent thinking dots while the SDK churns through its
  // backoff. `errorStatus` is the HTTP status when the upstream did reply
  // (e.g. 529), or null for a transport-level failure (DNS, TCP reset,
  // timeout), which is what we saw in the wild and is the noisier case.
  | {
      type: "api_retry";
      attempt: number;
      maxRetries: number;
      retryDelayMs: number;
      errorStatus: number | null;
      error: string | null;
    }
  | { type: "raw"; source: "claude" | "codex"; payload: unknown };

export interface ChatBackend {
  sendMessage(opts: {
    vmId: string;
    chatId: string;
    message: string;
    model: string;
    effort: ChatEffort;
    sessionId?: string;
    signal?: AbortSignal;
    onDelta: (text: string) => void;
    onEvent?: (event: ChatEvent) => void;
  }): Promise<{ content: string; sessionId?: string }>;

  // Snapshot the CLI's view of context composition. Anthropic only. codex
  // exposes no equivalent (`thread/tokenUsage` is the closest, and it
  // doesn't split by category). Returns `{ available: false, reason }` when
  // the probe isn't applicable (codex backend, missing sessionId).
  probeContext(opts: {
    vmId: string;
    model: string;
    sessionId?: string;
  }): Promise<ContextBreakdown>;

  // Mint a short chat title from the chat's first user message, running the
  // provider's own CLI inside the given VM (so it uses the CLI's auth + token
  // refresh, since the host holds no API key). Best-effort: returns null on any
  // failure and the caller falls back to a truncation of the first message.
  generateTitle(vmId: string, firstMessage: string): Promise<string | null>;
}

export function emptyUsage(): TokenUsage {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };
}
