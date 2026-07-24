import { splitHandoffIntoChunks } from "./chunk";
import {
  DEFAULT_ESTIMATE_CONSTANTS,
  estimateTokens,
  type HandoffEstimateConstants,
} from "./estimate";
import type { HandoffItem } from "./types";

// When a conversation is too large to hand to the target verbatim, it is
// reduced to a compact summary rather than dumped raw (which the target would
// reject). The reduction rolls a running summary through bounded chunks: each
// step feeds the summary-so-far plus the next slice of conversation to a model
// and asks for an updated summary. The final summary is a single handoff item,
// so an arbitrarily large chat becomes a small, self-contained handoff.
//
// This module is pure: the model call is an injected `summarize` callback, so
// the rolling logic is unit-testable and the caller owns which provider/session
// actually runs the summarization turns.

// Cap on the final summary so the handoff stays small regardless of how large
// the source conversation was. A few thousand tokens is plenty to carry goals,
// decisions, key code, and open work.
export const SUMMARY_TOKEN_TARGET = 3000;

// Render one handoff item as readable prose for a summarization prompt. Models
// summarize prose better than the JSON envelope, and this keeps tool payloads
// bounded so a single item can't blow the chunk budget on its own.
const TOOL_TEXT_PREVIEW = 4000;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [truncated]`;
}

export function renderItemsForSummary(items: HandoffItem[]): string {
  const lines: string[] = [];
  for (const item of items) {
    switch (item.kind) {
      case "summary":
        lines.push(`[Summary of earlier conversation]\n${item.text}`);
        break;
      case "user": {
        const attachments =
          item.attachments && item.attachments.length > 0
            ? ` [attached: ${item.attachments.map((a) => a.filename).join(", ")}]`
            : "";
        lines.push(`User: ${item.text}${attachments}`);
        break;
      }
      case "assistant":
        lines.push(`Assistant: ${item.text}`);
        break;
      case "tool_call":
        lines.push(
          `Assistant called tool ${item.name}(${truncate(
            typeof item.input === "string" ? item.input : JSON.stringify(item.input ?? {}),
            TOOL_TEXT_PREVIEW,
          )})${item.interrupted ? " [interrupted]" : ""}`,
        );
        break;
      case "tool_result": {
        const text = item.content
          .map((c) => (c.type === "text" ? c.text : `[${c.type}]`))
          .join("\n");
        lines.push(
          `Tool result${item.isError ? " (error)" : ""}: ${truncate(text, TOOL_TEXT_PREVIEW)}`,
        );
        break;
      }
    }
  }
  return lines.join("\n\n");
}

// A concise, factual summary in this shape carries a conversation across a
// switch. Shared by both reduction paths so the target sees a consistent form.
const SUMMARY_GUIDANCE = [
  "Preserve, concisely and factually:",
  "- the user's overall goal and the current task,",
  "- decisions made and the current approach,",
  "- important file paths, identifiers, commands, and code snippets,",
  "- the state of the work and any open TODOs or unresolved problems.",
  "",
  "Drop chit-chat and superseded detail. Do not invent anything. Output ONLY the",
  "summary, with no preamble, sign-off, or commentary.",
].join("\n");

// The instruction sent as a single turn on a FORK of the source session, which
// already holds the whole conversation in context. No transcript is re-fed:
// the model summarizes the context it is already carrying, so this is one
// cache-advantaged pass rather than re-reading the conversation as fresh input.
export function handoffSummaryInstruction(): string {
  return [
    "Summarize our entire conversation so far into a compact handoff so a",
    "different AI assistant can seamlessly continue this work.",
    "",
    SUMMARY_GUIDANCE,
  ].join("\n");
}

// Hard-cap a summary's size so the handoff can never itself be oversized,
// regardless of how talkative the model was. Pure (no model call).
export function capSummaryText(
  text: string,
  summaryTokenTarget = SUMMARY_TOKEN_TARGET,
  constants = DEFAULT_ESTIMATE_CONSTANTS,
): string {
  if (estimateTokens(text, constants) <= summaryTokenTarget) return text;
  const byteBudget = summaryTokenTarget * constants.bytesPerToken;
  return `${text.slice(0, byteBudget)}\n\n[Summary truncated to fit the target model.]`;
}

function rollingSummaryPrompt(runningSummary: string, chunkText: string): string {
  const priorSection = runningSummary
    ? `Summary so far:\n${runningSummary}\n\n`
    : "There is no summary yet; this is the first part.\n\n";
  return [
    "You are compressing an earlier coding conversation so it can be handed to a",
    "different AI assistant that will continue the work. Merge the summary so far",
    "with the next part of the conversation into a single updated summary.",
    "",
    "Preserve, concisely and factually:",
    "- the user's overall goal and the current task,",
    "- decisions made and the current approach,",
    "- important file paths, identifiers, commands, and code snippets,",
    "- the state of the work and any open TODOs or unresolved problems.",
    "",
    "Drop chit-chat and superseded detail. Do not invent anything. Output ONLY the",
    "updated summary, with no preamble, sign-off, or commentary.",
    "",
    priorSection + `Next part of the conversation:\n${chunkText}`,
  ].join("\n");
}

function compressPrompt(summary: string, maxWords: number): string {
  return [
    `Compress the following handoff summary to at most about ${maxWords} words,`,
    "keeping the user's goal, current task, key file paths/code, and open TODOs.",
    "Output ONLY the compressed summary.",
    "",
    summary,
  ].join("\n");
}

export interface ReduceOptions {
  // Runs one bounded summarization completion and returns its text. The caller
  // decides which provider/model/session runs it.
  summarize: (prompt: string, signal?: AbortSignal) => Promise<string>;
  // Token budget for each summarization input chunk, sized to the summarizer
  // model's window with room for the running summary and the response.
  chunkBudgetTokens: number;
  // Target size for the final summary item (defaults to SUMMARY_TOKEN_TARGET).
  summaryTokenTarget?: number;
  constants?: HandoffEstimateConstants;
  signal?: AbortSignal;
  // Fired before each summarization step so the UI can show progress.
  onProgress?: (step: number, total: number) => void;
}

// Reduce an item sequence to a single compact summary item by rolling a running
// summary through bounded chunks. Returns the reduced handoff items (one
// summary item), which the caller renders in place of the raw transcript.
export async function reduceHandoffItems(
  items: HandoffItem[],
  opts: ReduceOptions,
): Promise<HandoffItem[]> {
  const constants = opts.constants ?? DEFAULT_ESTIMATE_CONSTANTS;
  const summaryTarget = opts.summaryTokenTarget ?? SUMMARY_TOKEN_TARGET;
  const chunks = splitHandoffIntoChunks(items, {
    chunkBudgetTokens: opts.chunkBudgetTokens,
    constants,
  });

  let summary = "";
  for (let i = 0; i < chunks.length; i++) {
    if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError");
    opts.onProgress?.(i + 1, chunks.length);
    const chunkText = renderItemsForSummary(chunks[i]!);
    summary = (await opts.summarize(rollingSummaryPrompt(summary, chunkText), opts.signal)).trim();
  }

  // Guarantee the final summary is compact. If a talkative model overshot the
  // target, run one compression pass; if it is still over (or the pass failed),
  // hard-truncate so the handoff can never itself be oversized.
  if (estimateTokens(summary, constants) > summaryTarget) {
    if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError");
    try {
      const maxWords = Math.max(200, Math.floor(summaryTarget * 0.6));
      const compressed = (
        await opts.summarize(compressPrompt(summary, maxWords), opts.signal)
      ).trim();
      if (compressed) summary = compressed;
    } catch (error) {
      console.warn("[handoff] summary compression pass failed; truncating instead:", error);
    }
  }
  summary = capSummaryText(summary, summaryTarget, constants);

  return summary ? [{ kind: "summary", text: summary }] : [];
}
