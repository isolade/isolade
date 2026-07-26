import type { FirstTargetPromptParts } from "./render";
import { renderFirstTargetPrompt } from "./render";

// Conservative capacity estimation for the complete first target request. This
// deliberately uses a byte-ratio estimate rather than staging an exact target
// session or fabricating provider transcript files (see DESIGN.md). The
// constants are policy defaults, tuned from rejected requests and observed
// first-turn usage, not provider guarantees.
export interface HandoffEstimateConstants {
  // utf8 bytes per token. The estimate is ceil(bytes / bytesPerToken).
  bytesPerToken: number;
  // Reserve for provider instructions and tool schemas (not user-controlled
  // prompt content).
  baselineReserveTokens: number;
  // Reserve for the model's response.
  outputReserveTokens: number;
  // Guard against estimate error, subtracted from the window for the hard limit.
  safetyMarginTokens: number;
  // Direct bucket ceiling as a fraction of the preferred compaction limit.
  directFraction: number;
  // Preferred compaction limit as a fraction of the context window, used only
  // when the target's own auto-compaction limit is unknown.
  autoCompactFraction: number;
}

export const DEFAULT_ESTIMATE_CONSTANTS: HandoffEstimateConstants = {
  bytesPerToken: 3,
  baselineReserveTokens: 20_000,
  outputReserveTokens: 32_000,
  safetyMarginTokens: 8_000,
  directFraction: 0.85,
  autoCompactFraction: 0.9,
};

// The target's context capacity. `contextWindow` comes from the static catalog
// for Claude and from Codex model metadata or its latest usage event for Codex.
// `autoCompactLimit` is the target's own auto-compaction point when known.
export interface TargetCapacity {
  contextWindow: number;
  autoCompactLimit?: number;
}

export type HandoffBucket = "direct" | "compaction-preferred" | "oversized";

export interface HandoffLimits {
  contextWindow: number;
  preferredCompactionLimit: number;
  directLimit: number;
  hardLimit: number;
}

export interface HandoffEstimate extends HandoffLimits {
  estimatedInputTokens: number;
  estimatedTotalTokens: number;
  bucket: HandoffBucket;
  // The current user message alone (with its attachment preamble, ignoring all
  // history) already exceeds the hard limit, so reducing history cannot make
  // the request valid. The caller rejects the send rather than summarizing a
  // new user instruction.
  userMessageExceedsHardLimit: boolean;
}

export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export function estimateTokens(text: string, constants = DEFAULT_ESTIMATE_CONSTANTS): number {
  return Math.ceil(utf8ByteLength(text) / constants.bytesPerToken);
}

// Derive the three limit points from the target capacity. The preferred
// compaction limit prefers the target's own auto-compaction point and falls
// back to a fraction of the window. The hard limit is the window less a safety
// margin (the baseline/output reserves are already inside estimated totals).
export function resolveLimits(
  capacity: TargetCapacity,
  constants = DEFAULT_ESTIMATE_CONSTANTS,
): HandoffLimits {
  const contextWindow = capacity.contextWindow;
  const preferredCompactionLimit =
    capacity.autoCompactLimit ?? Math.floor(contextWindow * constants.autoCompactFraction);
  const directLimit = Math.floor(preferredCompactionLimit * constants.directFraction);
  const hardLimit = contextWindow - constants.safetyMarginTokens;
  return { contextWindow, preferredCompactionLimit, directLimit, hardLimit };
}

function classify(estimatedTotalTokens: number, limits: HandoffLimits): HandoffBucket {
  if (estimatedTotalTokens < limits.directLimit) return "direct";
  if (estimatedTotalTokens < limits.hardLimit) return "compaction-preferred";
  return "oversized";
}

// Estimate the complete first target request from its assembled parts. Measures
// the full prompt (prelude + envelope + handoff + attachments + current
// message) for the bucket, and the current turn alone for the
// unfixable-by-reduction rejection.
export function estimateFirstTargetRequest(
  parts: FirstTargetPromptParts,
  capacity: TargetCapacity,
  constants = DEFAULT_ESTIMATE_CONSTANTS,
): HandoffEstimate {
  const limits = resolveLimits(capacity, constants);

  const fullPrompt = renderFirstTargetPrompt(parts);
  const estimatedInputTokens = estimateTokens(fullPrompt, constants);
  const estimatedTotalTokens =
    constants.baselineReserveTokens + estimatedInputTokens + constants.outputReserveTokens;

  // The current turn with no history: prelude + attachments + user message.
  const currentTurnText = renderFirstTargetPrompt({
    prelude: parts.prelude,
    handoff: { version: parts.handoff.version, source: parts.handoff.source, items: [] },
    attachmentsPreamble: parts.attachmentsPreamble,
    userMessage: parts.userMessage,
  });
  const currentTurnTotal =
    constants.baselineReserveTokens +
    estimateTokens(currentTurnText, constants) +
    constants.outputReserveTokens;

  return {
    ...limits,
    estimatedInputTokens,
    estimatedTotalTokens,
    bucket: classify(estimatedTotalTokens, limits),
    userMessageExceedsHardLimit: currentTurnTotal >= limits.hardLimit,
  };
}

// The action for a switch given the candidate size and each side's
// availability, exactly as the availability matrix in DESIGN.md prescribes.
export type HandoffAction =
  | "transfer-direct"
  | "transfer-raw"
  | "source-reduce"
  | "target-chunk"
  | "keep-pending";

// Source/target availability means one more model request can complete on that
// side. It is independent of local transcript availability, and is classified
// from a returned error rather than a separate probe.
export function decideHandoffAction(opts: {
  bucket: HandoffBucket;
  sourceAvailable: boolean;
  targetAvailable: boolean;
}): HandoffAction {
  // Any candidate, target unavailable: keep the pending switch and retry later.
  if (!opts.targetAvailable) return "keep-pending";
  switch (opts.bucket) {
    case "direct":
      // Direct transfers unchanged whether or not the source is reachable (the
      // local transcript is enough).
      return "transfer-direct";
    case "compaction-preferred":
      // Reduce at the source when it can, otherwise transfer raw and let the
      // target compact later.
      return opts.sourceAvailable ? "source-reduce" : "transfer-raw";
    case "oversized":
      // Reduce at the source when it can, otherwise fall back to target-side
      // chunking.
      return opts.sourceAvailable ? "source-reduce" : "target-chunk";
  }
}
