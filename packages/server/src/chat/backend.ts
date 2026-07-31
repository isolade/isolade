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

// What one model consumed and cost over a single turn. A turn can involve more
// than one: a sub-agent may run on a different model than the main loop, and its
// work is the user's spend just the same.
export interface ModelBilling {
  model: string;
  usage: TokenUsage;
  // How many of `usage.cacheCreationInputTokens` were written with a one-hour
  // TTL rather than the default five minutes. A subset, not a bucket of its own,
  // because the provider reports it that way: the two are billed at different
  // rates (see CACHE_WRITE_1H_INPUT_MULTIPLIER) but are the same tokens.
  cacheWrite1hTokens: number;
  // Whether the provider billed this at its fast-mode rates, which are a
  // multiple of list (2× on Opus 5, 6× on Opus 4.6). Recorded per turn because
  // the mode can be toggled between them.
  fast: boolean;
  // Server-side searches the provider ran and bills per request rather than per
  // token, so they explain spend that no token bucket accounts for. Zero where a
  // provider doesn't offer them or doesn't report them.
  webSearchRequests: number;
  // The provider's own figure where it gives one (Claude reports dollars
  // directly), otherwise catalog pricing × the tokens above (codex).
  costUsd: number;
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
  | { type: "thinking_start"; id: string; provider: "claude" | "codex" }
  | { type: "thinking_delta"; id: string; provider: "claude" | "codex"; text: string }
  | {
      type: "thinking_tokens";
      id: string;
      provider: "claude" | "codex";
      tokens?: number;
      tokensDelta?: number;
    }
  | {
      type: "thinking_done";
      id: string;
      provider: "claude" | "codex";
      text?: string;
      tokens?: number;
    }
  // Legacy debug-only reasoning payload retained for old persisted turns.
  | { type: "thinking"; text: string }
  // The live gauge, emitted as often as the provider will tell us anything.
  | {
      type: "usage";
      // `last` is this turn's usage. `total` is cumulative across the whole
      // session. The UI uses last.input+cachedInput as the "context packed in"
      // number and `total` for the session totals.
      last: TokenUsage;
      total: TokenUsage;
      // Window for the active model. Codex sends this. For Claude we look it
      // up from the catalog. Undefined when neither source knows.
      modelContextWindow?: number;
      // What the turn IN PROGRESS has run up so far. Provisional: each report
      // replaces the last rather than adding to it, and it is never recorded,
      // because a turn's real bill arrives on `onBilling` when it settles.
      // Codex can price its running token count as the turn goes; Claude says
      // nothing about money until the turn is over, and leaves this unset.
      // Consumed by the turn service, which folds it into `costUsd` below and
      // drops it: it never reaches the client on its own.
      turnCostUsd?: number;
      // What the chat has cost so far, including any turn in progress. The
      // figure the composer shows, and the only money field that reaches the
      // client. Filled in by the turn service, which is the only party that
      // knows the settled total, since a backend sees just its own session.
      costUsd?: number;
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

// Provider-session facts a backend learns while a turn runs, reported through
// `onMeta` as soon as they're known (not just on success) so the turn service
// can stamp them onto the assistant message row even when the turn is later
// aborted. Together they pinpoint "the conversation right after this turn"
// for a future fork:
//   - sessionId: Claude session id / codex thread id the turn ran in. Changes
//     mid-chat on a fork (Claude mints a new session id, codex a new thread).
//   - anchorId: the turn's end position inside that session. Claude: the
//     transcript uuid of the turn's last assistant message (consumed by
//     `--resume-session-at`). Codex: the turn id (consumed by thread/fork's
//     lastTurnId).
export interface TurnMeta {
  sessionId?: string;
  anchorId?: string;
}

// Provider position immediately before a user input became part of the
// conversation. Claude can fork from this position to edit an in-turn input.
// Codex deliberately leaves it empty because its public protocol only forks
// at whole-turn boundaries.
export interface UserMessageReceipt {
  sessionId?: string;
  priorAnchorId?: string;
}

// A file attached to the outgoing user message. The bytes already live at
// `guestPath` inside the VM, so the turn service cites the path and the agent
// loads the file with its normal tools. `guestPath` is absolute so it resolves
// unambiguously across a multi-repo workspace.
export interface UploadAttachment {
  id: string;
  filename: string;
  mediaType: string;
  guestPath: string;
}

export interface ChatBackend {
  sendMessage(opts: {
    vmId: string;
    chatId: string;
    message: string;
    model: string;
    effort: ChatEffort;
    sessionId?: string;
    // Stable id generated by the Isolade client. Providers echo it once the
    // input is durably part of their conversation.
    userMessageId?: string;
    // Fork the resumed session instead of continuing its tail: replay
    // `sessionId` only up to and including `anchorId`, mint a new
    // session/thread from that prefix, and run the turn there. The original
    // session stays intact, so its branch remains continuable. Requires
    // `sessionId`. This is how an edited message recomputes "from that
    // point". (Editing before any anchored turn just omits `sessionId`,
    // which is a fresh session and needs no fork.)
    fork?: { anchorId: string };
    // Run this turn in the provider's fast mode: quicker, at a premium rate.
    // Off unless the chat opted in. Claude applies it to the live process, codex
    // ignores it for now.
    fast?: boolean;
    signal?: AbortSignal;
    onDelta: (text: string) => void;
    onEvent?: (event: ChatEvent) => void;
    // Fired whenever a TurnMeta field becomes known, possibly several times
    // per turn (later values supersede earlier ones). See TurnMeta.
    onMeta?: (meta: TurnMeta) => void;
    // Fired once, when a turn has settled and the provider can say what it
    // billed. Separate from `onEvent` on purpose: this is accounting, and
    // `ChatEvent` is the stream that gets published and replayed. Keeping it off
    // that union means a bill cannot end up in a chat's event log by accident.
    onBilling?: (models: ModelBilling[]) => void;
    onUserMessageAcknowledged?: (receipt?: UserMessageReceipt) => void;
  }): Promise<{ content: string; sessionId?: string }>;

  // Inject an already-queued input into the active turn. "next" waits for the
  // current tool call. Claude also supports "now", which interrupts its
  // current operation. Codex's "now" is implemented by the queue coordinator
  // as interrupt followed by a new turn.
  steer?(opts: {
    vmId: string;
    chatId: string;
    message: string;
    userMessageId: string;
    priority: "next" | "now";
    onUserMessageAcknowledged?: (receipt?: UserMessageReceipt) => void;
  }): Promise<void>;

  // Retract a provider-owned "next" input while it is still pending. Claude
  // exposes an atomic UUID-based cancellation control. Codex does not.
  // `false` means the provider already dequeued the input, so it must be
  // treated as delivered rather than retried or silently removed.
  cancelSteer?(opts: { vmId: string; chatId: string; userMessageId: string }): Promise<boolean>;

  // Rare recovery probe used only after delivery became ambiguous. Returning
  // false means the stable id is absent and a retry is safe.
  hasUserMessage?(opts: {
    vmId: string;
    chatId: string;
    sessionId?: string;
    userMessageId: string;
  }): Promise<boolean>;

  // Snapshot the CLI's view of context composition. Anthropic only. codex
  // exposes no equivalent (`thread/tokenUsage` is the closest, and it
  // doesn't split by category). Returns `{ available: false, reason }` when
  // the probe isn't applicable (codex backend, missing sessionId).
  probeContext(opts: {
    vmId: string;
    chatId: string;
    model: string;
    effort: ChatEffort;
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

// How many tokens a usage actually accounts for, summed from the disjoint
// buckets rather than read off `totalTokens`, so a provider that omits or
// redefines that field cannot make real usage look like none.
export function usageTokenCount(usage: TokenUsage): number {
  return (
    usage.inputTokens +
    usage.cachedInputTokens +
    usage.cacheCreationInputTokens +
    usage.outputTokens +
    usage.reasoningOutputTokens
  );
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningOutputTokens: a.reasoningOutputTokens + b.reasoningOutputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

// `a` minus `b`, floored at zero per bucket. Used to turn a provider's running
// tally into what the latest turn added. The floor is a guard against a provider
// restating a counter downwards, which would otherwise credit tokens back.
export function subtractUsage(a: TokenUsage, b: TokenUsage | undefined): TokenUsage {
  if (!b) return { ...a };
  const bucket = (x: number, y: number) => Math.max(0, x - y);
  return {
    inputTokens: bucket(a.inputTokens, b.inputTokens),
    cachedInputTokens: bucket(a.cachedInputTokens, b.cachedInputTokens),
    cacheCreationInputTokens: bucket(a.cacheCreationInputTokens, b.cacheCreationInputTokens),
    outputTokens: bucket(a.outputTokens, b.outputTokens),
    reasoningOutputTokens: bucket(a.reasoningOutputTokens, b.reasoningOutputTokens),
    totalTokens: bucket(a.totalTokens, b.totalTokens),
  };
}
