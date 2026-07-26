import { renderHandoffEnvelope } from "./envelope";
import type { PortableHandoff } from "./types";

// The pieces of the first real target prompt. The visible Isolade row stores
// only `userMessage` and its attachment metadata; this assembled string is what
// the target native transcript stores.
export interface FirstTargetPromptParts {
  // The normal Isolade environment prelude for a fresh session, already wrapped
  // by the caller exactly as an ordinary first turn wraps it. Null when the
  // instance has no profile prelude.
  prelude: string | null;
  handoff: PortableHandoff;
  // The attachments preamble for the CURRENT user message (cites each file's
  // absolute VM path), or null when the message has none.
  attachmentsPreamble: string | null;
  // The current user message's own text (may be empty for attachments-only).
  userMessage: string;
}

// Assemble the first target prompt in the required order:
//   1. environment prelude, 2. handoff envelope, 3. current attachments,
//   4. current user message.
// The handoff envelope sits between the prelude and the current turn so the
// target reads "here is the environment, here is prior context, now answer
// this". Parts are joined with blank lines, matching the ordinary turn
// assembly.
export function renderFirstTargetPrompt(parts: FirstTargetPromptParts): string {
  const segments: string[] = [];
  if (parts.prelude) segments.push(`<prelude>\n${parts.prelude}\n</prelude>`);
  segments.push(renderHandoffEnvelope(parts.handoff));
  if (parts.attachmentsPreamble) segments.push(parts.attachmentsPreamble);
  if (parts.userMessage.length > 0) segments.push(parts.userMessage);
  return segments.join("\n\n");
}
