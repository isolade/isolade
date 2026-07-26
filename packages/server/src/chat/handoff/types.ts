import type { ChatProvider } from "../../contracts";

// The provider-neutral handoff: a versioned sequence of semantic items derived
// from the source transcript and injected into the first target turn. This is
// the one shape both directions (Claude→Codex, Codex→Claude) produce and the
// target consumes. Provider-specific reasoning and protocol data never appear
// here (see the excluded-content list in DESIGN.md).

// A piece of a tool result. Text is the common case. Image/binary results are
// materialized as files in the VM and referenced by guest path. A result that
// cannot be represented faithfully is marked `unsupported`, which requires the
// same explicit user consent as any other lossy transfer.
export type HandoffContent =
  | { type: "text"; text: string }
  | { type: "file"; guestPath: string; mediaType?: string }
  | { type: "structured"; value: unknown }
  | { type: "unsupported"; reason: string };

// A file that accompanied a user message and was visible to the source model.
// The bytes already live at `guestPath` inside the VM, so the target cites the
// path rather than re-uploading.
export interface HandoffAttachment {
  filename: string;
  mediaType: string;
  guestPath: string;
}

export type HandoffItem =
  | { kind: "summary"; text: string }
  | { kind: "user"; text: string; attachments?: HandoffAttachment[] }
  | { kind: "assistant"; text: string }
  // `interrupted` marks a tool call the source never completed. It is recorded
  // for context but never injected as a live outstanding target tool call.
  | { kind: "tool_call"; id: string; name: string; input: unknown; interrupted?: boolean }
  | { kind: "tool_result"; id: string; content: HandoffContent[]; isError: boolean };

// The current version of the envelope encoding. Bumped when the item shape or
// framing changes in a way a target reader must distinguish.
export const HANDOFF_ENVELOPE_VERSION = 1 as const;

// A complete portable handoff: the item sequence plus the source provider it
// was derived from (for telemetry and the target framing).
export interface PortableHandoff {
  version: number;
  source: ChatProvider;
  items: HandoffItem[];
}

export function makeHandoff(source: ChatProvider, items: HandoffItem[]): PortableHandoff {
  return { version: HANDOFF_ENVELOPE_VERSION, source, items };
}

// Whether an item carries any content worth transferring. An empty assistant
// turn or a tool call that was interrupted with no input is dropped rather than
// injected as noise.
export function itemHasContent(item: HandoffItem): boolean {
  switch (item.kind) {
    case "summary":
    case "assistant":
      return item.text.trim().length > 0;
    case "user":
      return item.text.trim().length > 0 || (item.attachments?.length ?? 0) > 0;
    case "tool_call":
      return true;
    case "tool_result":
      return item.content.length > 0;
  }
}
