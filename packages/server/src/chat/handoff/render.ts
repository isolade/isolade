import { renderHandoffEnvelope } from "./envelope";
import type { PortableHandoff } from "./types";

// The pieces of the first real target prompt. The visible Isolade row stores
// only `userMessage` and its attachment metadata; this assembled string is what
// the target native transcript stores.
export interface FirstTargetPromptParts {
  // Isolade's system prompt for the target (core + profile prelude). It is sent
  // as system-level text rather than inside this message, so it is NOT part of
  // the rendered string — it is carried here only because it is unavoidable
  // overhead on the same request and the estimate has to account for it.
  systemPrompt: string;
  handoff: PortableHandoff;
  // The attachments preamble for the CURRENT user message (cites each file's
  // absolute VM path), or null when the message has none.
  attachmentsPreamble: string | null;
  // The current user message's own text (may be empty for attachments-only).
  userMessage: string;
}

// Assemble the first target user message in the required order:
//   1. handoff envelope, 2. current attachments, 3. current user message.
// The environment no longer appears here — it moved to the system prompt — so
// the target reads "here is prior context, now answer this", with the
// environment already in front of it. Parts are joined with blank lines,
// matching the ordinary turn assembly.
export function renderFirstTargetPrompt(parts: FirstTargetPromptParts): string {
  const segments: string[] = [];
  segments.push(renderHandoffEnvelope(parts.handoff));
  if (parts.attachmentsPreamble) segments.push(parts.attachmentsPreamble);
  if (parts.userMessage.length > 0) segments.push(parts.userMessage);
  return segments.join("\n\n");
}
