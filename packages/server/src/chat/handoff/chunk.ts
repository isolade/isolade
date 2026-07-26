import {
  DEFAULT_ESTIMATE_CONSTANTS,
  estimateTokens,
  type HandoffEstimateConstants,
} from "./estimate";
import type { HandoffContent, HandoffItem } from "./types";

// Target-side chunking is the fallback when the source cannot produce a smaller
// handoff: providers do not divide one oversized incoming handoff into multiple
// requests, and auto-compaction only helps history the provider has already
// accepted. The pure splitter here divides the portable sequence at
// conversation-turn boundaries, keeps each tool call with its result where
// possible, bounds each chunk below the target's direct limit, and splits a
// single oversized item into labeled parts. The rolling-summary orchestration
// that consumes these chunks (one auxiliary target request per chunk) lives in
// the switch lifecycle, because it needs live target requests.

function itemTokens(item: HandoffItem, constants: HandoffEstimateConstants): number {
  return estimateTokens(JSON.stringify(item), constants);
}

function itemsTokens(items: HandoffItem[], constants: HandoffEstimateConstants): number {
  let total = 0;
  for (const item of items) total += itemTokens(item, constants);
  return total;
}

// Group the flat item sequence into turns. A `user` item begins a new turn.
// Any leading items before the first user (a summary, or assistant/tool items)
// form the first group so a compact summary always travels with the first
// chunk.
function groupIntoTurns(items: HandoffItem[]): HandoffItem[][] {
  const groups: HandoffItem[][] = [];
  let current: HandoffItem[] = [];
  for (const item of items) {
    if (item.kind === "user" && current.length > 0) {
      groups.push(current);
      current = [];
    }
    current.push(item);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

// Split a turn into units, gluing a tool_call to its immediately-following
// tool_result (same id) so a split never separates them.
function splitTurnIntoUnits(turn: HandoffItem[]): HandoffItem[][] {
  const units: HandoffItem[][] = [];
  for (let i = 0; i < turn.length; i++) {
    const item = turn[i]!;
    const next = turn[i + 1];
    if (item.kind === "tool_call" && next?.kind === "tool_result" && next.id === item.id) {
      units.push([item, next]);
      i++;
      continue;
    }
    units.push([item]);
  }
  return units;
}

// Split a string into parts whose estimated token size fits `budget`, splitting
// on character boundaries so multibyte sequences are never cut.
function splitTextByTokens(
  text: string,
  budget: number,
  constants: HandoffEstimateConstants,
): string[] {
  if (estimateTokens(text, constants) <= budget) return [text];
  const byteBudget = Math.max(1, budget * constants.bytesPerToken);
  const parts: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const ch of text) {
    const chBytes = Buffer.byteLength(ch, "utf8");
    if (currentBytes + chBytes > byteBudget && current.length > 0) {
      parts.push(current);
      current = "";
      currentBytes = 0;
    }
    current += ch;
    currentBytes += chBytes;
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

function label(kind: string, index: number, count: number): string {
  return `[Isolade handoff: ${kind} continued, part ${index} of ${count}]`;
}

// Split a single item that alone exceeds the budget into labeled parts, each
// fitting the budget. Reserves headroom for the label. A tool_call is kept
// whole (its input is not text-splittable without changing meaning); the rare
// oversized call is left as-is and documented.
function splitOversizedItem(
  item: HandoffItem,
  budget: number,
  constants: HandoffEstimateConstants,
): HandoffItem[] {
  // Leave headroom for the label and JSON framing overhead.
  const textBudget = Math.max(1, Math.floor(budget * 0.85));
  switch (item.kind) {
    case "summary":
    case "assistant":
    case "user": {
      const parts = splitTextByTokens(item.text, textBudget, constants);
      if (parts.length <= 1) return [item];
      return parts.map((part, i) => {
        const text = `${label(item.kind, i + 1, parts.length)}\n${part}`;
        if (item.kind === "user") {
          // Attachments ride with the first part only.
          return i === 0 && item.attachments
            ? { kind: "user", text, attachments: item.attachments }
            : { kind: "user", text };
        }
        return { kind: item.kind, text } as HandoffItem;
      });
    }
    case "tool_result": {
      const out: HandoffItem[] = [];
      // Split each text content block; non-text blocks (file/unsupported) stay
      // as their own result item.
      const textBlocks: string[] = [];
      const otherBlocks: HandoffContent[] = [];
      for (const content of item.content) {
        if (content.type === "text") textBlocks.push(content.text);
        else otherBlocks.push(content);
      }
      const joined = textBlocks.join("\n");
      const parts = splitTextByTokens(joined, textBudget, constants);
      parts.forEach((part, i) => {
        const text =
          parts.length > 1 ? `${label("tool result", i + 1, parts.length)}\n${part}` : part;
        out.push({
          kind: "tool_result",
          id: item.id,
          content: [{ type: "text", text }],
          isError: item.isError,
        });
      });
      for (const other of otherBlocks) {
        out.push({ kind: "tool_result", id: item.id, content: [other], isError: item.isError });
      }
      return out.length > 0 ? out : [item];
    }
    case "tool_call":
      return [item];
  }
}

export interface ChunkOptions {
  // Comfortably below the target's direct limit (the caller derives this).
  chunkBudgetTokens: number;
  constants?: HandoffEstimateConstants;
}

// Split a portable sequence into chunks, each bounded below the budget. Prefers
// turn boundaries, keeps tool call/result pairs together, and splits a single
// oversized item into labeled parts.
export function splitHandoffIntoChunks(
  items: HandoffItem[],
  options: ChunkOptions,
): HandoffItem[][] {
  const constants = options.constants ?? DEFAULT_ESTIMATE_CONSTANTS;
  const budget = options.chunkBudgetTokens;
  const chunks: HandoffItem[][] = [];
  let current: HandoffItem[] = [];
  let currentTokens = 0;
  const flush = () => {
    if (current.length > 0) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
  };
  const pushUnit = (unit: HandoffItem[]) => {
    const tokens = itemsTokens(unit, constants);
    if (currentTokens + tokens > budget) flush();
    current.push(...unit);
    currentTokens += tokens;
  };

  for (const turn of groupIntoTurns(items)) {
    const turnTokens = itemsTokens(turn, constants);
    if (turnTokens <= budget) {
      // Whole turn fits: place it, starting a new chunk if it wouldn't fit
      // alongside the current one (a turn-boundary split).
      if (currentTokens + turnTokens > budget) flush();
      current.push(...turn);
      currentTokens += turnTokens;
      continue;
    }
    // Turn too big: flush, then pack its units, splitting any single oversized
    // unit's items into labeled parts.
    flush();
    for (const unit of splitTurnIntoUnits(turn)) {
      if (itemsTokens(unit, constants) <= budget) {
        pushUnit(unit);
        continue;
      }
      flush();
      const expanded = unit.flatMap((item) => splitOversizedItem(item, budget, constants));
      for (const item of expanded) pushUnit([item]);
    }
  }
  flush();
  return chunks;
}
