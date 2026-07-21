import { z } from "zod";
import { chatMessageSchema, chatSchema, transcriptMessageSchema } from "./domain";

export const tokenUsageSchema = z.object({
  inputTokens: z.number(),
  cachedInputTokens: z.number(),
  cacheCreationInputTokens: z.number(),
  outputTokens: z.number(),
  reasoningOutputTokens: z.number(),
  totalTokens: z.number(),
});

export const chatRenderChunkSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string() }),
  z.object({ kind: z.literal("thinking"), text: z.string() }),
  z.object({
    kind: z.literal("tool"),
    id: z.string(),
    name: z.string(),
    // Stable bounded label for the collapsed card. Kept separately because a
    // large input may be serialized into a truncated preview string.
    summary: z.string().optional(),
    input: z.unknown().optional(),
    output: z.string().optional(),
    // Bounded chat pages may carry previews in `input` / `output` instead of
    // the full provider payload. The full compact render remains available
    // from the focused render endpoint on first expansion.
    detailsAvailable: z.boolean().optional(),
    isError: z.boolean().optional(),
    status: z.enum(["running", "done"]),
  }),
  z.object({
    kind: z.literal("api_retry"),
    attempt: z.number(),
    maxRetries: z.number(),
    retryDelayMs: z.number(),
    errorStatus: z.number().nullable(),
    error: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("raw"),
    source: z.enum(["claude", "codex"]),
    label: z.string(),
    payload: z.unknown(),
  }),
]);

export type TokenUsage = z.infer<typeof tokenUsageSchema>;
export type ChatRenderChunk = z.infer<typeof chatRenderChunkSchema>;
export type ToolRenderChunk = Extract<ChatRenderChunk, { kind: "tool" }>;

export const chatRenderBatchSchema = z.object({
  chunksByMessage: z.record(z.string(), z.array(chatRenderChunkSchema)),
});
export type ChatRenderBatch = z.infer<typeof chatRenderBatchSchema>;

export const inFlightChatRenderSchema = z
  .object({
    messageId: z.string(),
    lastSeq: z.number().int(),
    chunks: z.array(chatRenderChunkSchema),
  })
  .nullable();
export type InFlightChatRender = z.infer<typeof inFlightChatRenderSchema>;

// One coherent, bounded history read. The initial tail includes `inFlight`,
// while older pages set it to null. Structural chunks are already folded so a
// cold chat never needs a second normal-mode render request.
export const chatViewPageSchema = z.object({
  messages: z.array(transcriptMessageSchema),
  hasMore: z.boolean(),
  chunksByMessage: z.record(z.string(), z.array(chatRenderChunkSchema)),
  inFlight: inFlightChatRenderSchema,
});
export type ChatViewPage = z.infer<typeof chatViewPageSchema>;

export const chatBranchSwitchSchema = chatSchema.extend({
  transcript: chatViewPageSchema,
});
export type ChatBranchSwitch = z.infer<typeof chatBranchSwitchSchema>;

// First frame on the resume stream. A running turn carries its current
// compact render and sequence. A terminal turn also carries the canonical
// committed message so pure-text turns do not depend on a deliberately-empty
// structural render projection.
export const chatResumeSnapshotSchema = z.object({
  messageId: z.string(),
  lastSeq: z.number().int(),
  chunks: z.array(chatRenderChunkSchema),
  metaEvents: z
    .array(
      z.object({
        seq: z.number().int(),
        type: z.enum(["usage", "title", "context_compacted"]),
        payload: z.unknown(),
      }),
    )
    .default([]),
  status: z.enum(["running", "done", "error"]),
  message: chatMessageSchema.nullable(),
  error: z.string().optional(),
});
export type ChatResumeSnapshot = z.infer<typeof chatResumeSnapshotSchema>;

export const TOOL_INPUT_PREVIEW_CHARS = 1_024;
export const TOOL_OUTPUT_PREVIEW_CHARS = 2_048;
export const TOOL_SUMMARY_PREVIEW_CHARS = 512;

export function summarizeChatToolInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const value = input as Record<string, unknown>;
  let summary = "";
  if (typeof value.file_path === "string") summary = value.file_path;
  else if (typeof value.path === "string") summary = value.path;
  else if (typeof value.url === "string") summary = value.url;
  else if (typeof value.query === "string") summary = value.query;
  else if (typeof value.pattern === "string") summary = value.pattern;
  else if (typeof value.description === "string") summary = value.description;
  else if (Array.isArray(value.command)) summary = value.command.map(String).join(" ");
  else if (typeof value.command === "string") summary = value.command.split("\n")[0] ?? "";
  if (summary.length <= TOOL_SUMMARY_PREVIEW_CHARS) return summary;
  return `${summary.slice(0, TOOL_SUMMARY_PREVIEW_CHARS)}\u2026`;
}

function previewUnknown(value: unknown, maxChars: number): { value: unknown; truncated: boolean } {
  if (value === undefined) return { value, truncated: false };
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? String(value);
  } catch {
    serialized = String(value);
  }
  if (serialized.length <= maxChars) return { value, truncated: false };
  return { value: `${serialized.slice(0, maxChars)}\u2026`, truncated: true };
}

/**
 * Bound provider-controlled tool payloads while retaining enough information
 * for collapsed cards. Text remains canonical because it is the message body
 * itself. Full tool details stay in the persisted projection and focused
 * render endpoint.
 */
export function boundChatRenderChunks(chunks: ChatRenderChunk[]): ChatRenderChunk[] {
  return chunks.map((chunk) => {
    if (chunk.kind !== "tool") return chunk;
    const input = previewUnknown(chunk.input, TOOL_INPUT_PREVIEW_CHARS);
    const output =
      chunk.output !== undefined && chunk.output.length > TOOL_OUTPUT_PREVIEW_CHARS
        ? {
            value: `${chunk.output.slice(0, TOOL_OUTPUT_PREVIEW_CHARS)}\u2026`,
            truncated: true,
          }
        : { value: chunk.output, truncated: false };
    const detailsAvailable = chunk.detailsAvailable === true || input.truncated || output.truncated;
    return {
      ...chunk,
      summary: chunk.summary ?? summarizeChatToolInput(chunk.input),
      input: input.value,
      output: output.value,
      ...(detailsAvailable ? { detailsAvailable: true } : {}),
    };
  });
}

/**
 * Fold a single decoded provider event into the compact display model.
 *
 * The live client and server-side history compactor intentionally share this
 * reducer. That keeps historical rows byte-for-byte equivalent to a turn that
 * is still streaming while avoiding delivery of thousands of token deltas on
 * every chat open.
 */
export function applyChatRenderEvent(
  chunks: ChatRenderChunk[],
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
      const p = payload as { id?: string; name?: string } | null;
      if (!p?.id) return;
      const index = toolIndex.get(p.id);
      if (index !== undefined) {
        const current = chunks[index];
        if (current?.kind === "tool") {
          chunks[index] = { ...current, name: p.name ?? current.name, status: "running" };
        }
      } else {
        toolIndex.set(p.id, chunks.length);
        chunks.push({ kind: "tool", id: p.id, name: p.name ?? "tool", status: "running" });
      }
      return;
    }
    case "tool_call_input": {
      const p = payload as {
        id?: string;
        input?: unknown;
        summary?: string;
        detailsAvailable?: boolean;
      } | null;
      if (!p?.id) return;
      const index = toolIndex.get(p.id);
      const current = index === undefined ? undefined : chunks[index];
      if (index !== undefined && current?.kind === "tool") {
        chunks[index] = {
          ...current,
          input: p.input,
          summary: p.summary ?? summarizeChatToolInput(p.input),
          ...(p.detailsAvailable ? { detailsAvailable: true } : {}),
        };
      }
      return;
    }
    case "tool_call_result": {
      const p = payload as {
        id?: string;
        output?: string;
        isError?: boolean;
        detailsAvailable?: boolean;
      } | null;
      if (!p?.id) return;
      const index = toolIndex.get(p.id);
      const current = index === undefined ? undefined : chunks[index];
      if (index !== undefined && current?.kind === "tool") {
        chunks[index] = {
          ...current,
          output: p.output,
          isError: p.isError,
          status: "done",
          ...(p.detailsAvailable ? { detailsAvailable: true } : {}),
        };
      }
      return;
    }
    case "api_retry": {
      const p = payload as {
        attempt?: number;
        maxRetries?: number;
        retryDelayMs?: number;
        errorStatus?: number | null;
        error?: string | null;
      } | null;
      const next = {
        kind: "api_retry" as const,
        attempt: p?.attempt ?? 0,
        maxRetries: p?.maxRetries ?? 0,
        retryDelayMs: p?.retryDelayMs ?? 0,
        errorStatus: p?.errorStatus ?? null,
        error: p?.error ?? null,
      };
      const last = chunks[chunks.length - 1];
      if (last?.kind === "api_retry") chunks[chunks.length - 1] = next;
      else chunks.push(next);
      return;
    }
    case "raw": {
      const p = payload as { source?: "claude" | "codex"; payload?: unknown } | null;
      const source = p?.source ?? "claude";
      chunks.push({
        kind: "raw",
        source,
        label: rawEventLabel(source, p?.payload),
        payload: p?.payload,
      });
      return;
    }
    default:
      return;
  }
}

export function compactChatRenderEvents(
  events: Iterable<{ type: string; payload: string }>,
): ChatRenderChunk[] {
  const chunks: ChatRenderChunk[] = [];
  const toolIndex = new Map<string, number>();
  for (const event of events) {
    let payload: unknown = event.payload;
    try {
      payload = JSON.parse(event.payload);
    } catch {
      // Corrupt legacy rows remain inspectable as their original text.
    }
    applyChatRenderEvent(chunks, toolIndex, event.type, payload);
  }
  return chunks;
}

function rawEventLabel(source: "claude" | "codex", payload: unknown): string {
  if (payload && typeof payload === "object") {
    const value = payload as Record<string, unknown>;
    if (typeof value.method === "string") return value.method;
    if (typeof value.type === "string") {
      if (value.type === "stream_event" && value.event && typeof value.event === "object") {
        const nested = value.event as Record<string, unknown>;
        if (typeof nested.type === "string") return nested.type;
      }
      return value.type;
    }
  }
  return source === "claude" ? "claude event" : "codex event";
}
