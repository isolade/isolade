import type { ChatProvider, ChatRenderChunk } from "../../contracts";
import {
  type HandoffAttachment,
  type HandoffContent,
  type HandoffItem,
  itemHasContent,
  makeHandoff,
  type PortableHandoff,
} from "./types";

// A message on the active branch, in root-to-tip order. `content` is the
// stored body (the user's own text, or the assistant's final text). Only the
// fields the normalizer needs are required, so a caller can pass rows straight
// from ChatManager.
export interface IsoladeBranchMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

export interface IsoladeBranchInput {
  // The provider the branch ran under, recorded on the handoff for framing.
  source: ChatProvider;
  // Active branch, root first. (ChatManager.pathToRoot yields tip-first, so the
  // caller reverses it.)
  messages: IsoladeBranchMessage[];
  // Full (non-bounded, non-debug) render chunks per assistant message id, as
  // returned by ChatManager.getMessageRenderChunks(chatId, ids, false, false).
  // A pure-text turn has an empty list, so its `content` is used directly.
  renderChunksByMessageId: Record<string, ChatRenderChunk[]>;
  // Attachments visible to the source model, per user message id.
  attachmentsByMessageId?: Record<string, HandoffAttachment[]>;
}

// Build a portable handoff from the Isolade message and event stores. This is
// the durable, provider-neutral source that survives any number of Codex
// compactions (the Codex→Claude primary path) and the raw fallback when a
// Claude native transcript is missing or damaged. It carries no summary item:
// summaries are produced separately by source-side compaction/summarization and
// prepended by the caller.
//
// Thinking and raw provider-debug chunks are excluded here defensively even
// though the caller is expected to pass the non-debug projection. Tool calls
// keep their inputs and are paired with their results by id; an unfinished tool
// call is marked interrupted and its (absent) result is omitted.
export function isoladeBranchToHandoff(input: IsoladeBranchInput): PortableHandoff {
  const items: HandoffItem[] = [];
  for (const message of input.messages) {
    if (message.role === "user") {
      const attachments = input.attachmentsByMessageId?.[message.id];
      const item: HandoffItem = { kind: "user", text: message.content };
      if (attachments && attachments.length > 0) item.attachments = attachments;
      items.push(item);
      continue;
    }
    // Assistant turn: prefer the structured render chunks (they capture text
    // interleaved with tool calls). Fall back to the stored final text when the
    // turn was pure text (no chunks persisted).
    const chunks = input.renderChunksByMessageId[message.id] ?? [];
    if (chunks.length === 0) {
      items.push({ kind: "assistant", text: message.content });
      continue;
    }
    items.push(...assistantChunksToItems(chunks));
  }
  return makeHandoff(input.source, items.filter(itemHasContent));
}

// Flatten one assistant turn's render chunks into ordered handoff items,
// preserving the interleaving of visible text and tool calls.
function assistantChunksToItems(chunks: ChatRenderChunk[]): HandoffItem[] {
  const items: HandoffItem[] = [];
  let textBuffer = "";
  const flushText = () => {
    if (textBuffer.trim().length > 0) items.push({ kind: "assistant", text: textBuffer });
    textBuffer = "";
  };
  for (const chunk of chunks) {
    switch (chunk.kind) {
      case "text":
        textBuffer += chunk.text;
        break;
      case "tool": {
        flushText();
        const interrupted = chunk.status !== "done";
        const call: HandoffItem = {
          kind: "tool_call",
          id: chunk.id,
          name: chunk.name,
          input: chunk.input,
        };
        if (interrupted) call.interrupted = true;
        items.push(call);
        // A tool call with no output is either still running or was interrupted
        // before returning. Record the call for context but never inject a live
        // outstanding result.
        if (chunk.output !== undefined) {
          const content: HandoffContent[] = [{ type: "text", text: chunk.output }];
          items.push({
            kind: "tool_result",
            id: chunk.id,
            content,
            isError: chunk.isError === true,
          });
        }
        break;
      }
      // Thinking, api_retry, and raw provider-debug chunks never cross to
      // another provider.
      case "thinking":
      case "api_retry":
      case "raw":
        break;
    }
  }
  flushText();
  return items;
}
