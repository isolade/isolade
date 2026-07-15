import { describe, expect, it } from "bun:test";
import {
  applyEvent,
  revealableLen,
  type StreamChunk,
  truncateChunks,
} from "../src/components/chat/chunks";

// Fold a list of (type, payload) events through the reducer the way both the
// live stream and mount-time replay do.
function fold(events: Array<[string, unknown]>): StreamChunk[] {
  const chunks: StreamChunk[] = [];
  const toolIndex = new Map<string, number>();
  for (const [type, payload] of events) applyEvent(chunks, toolIndex, type, payload);
  return chunks;
}

describe("applyEvent", () => {
  it("coalesces consecutive deltas into one text chunk", () => {
    const chunks = fold([
      ["delta", "Hello, "],
      ["delta", "world"],
    ]);
    expect(chunks).toEqual([{ kind: "text", text: "Hello, world" }]);
  });

  it("merges a tool call's start/input/result into one chunk by id", () => {
    const chunks = fold([
      ["tool_call_start", { id: "t1", name: "Bash" }],
      ["delta", "running…"],
      ["tool_call_input", { id: "t1", input: { command: "ls" } }],
      ["tool_call_result", { id: "t1", output: "file.txt", isError: false }],
    ]);
    expect(chunks).toEqual([
      {
        kind: "tool",
        id: "t1",
        name: "Bash",
        input: { command: "ls" },
        output: "file.txt",
        isError: false,
        status: "done",
      },
      { kind: "text", text: "running…" },
    ]);
  });

  it("drops results for unknown tool ids instead of crashing", () => {
    const chunks = fold([["tool_call_result", { id: "ghost", output: "x" }]]);
    expect(chunks).toEqual([]);
  });

  it("coalesces consecutive api_retry events into the latest one", () => {
    const chunks = fold([
      [
        "api_retry",
        {
          attempt: 1,
          maxRetries: 10,
          retryDelayMs: 500,
          errorStatus: null,
          error: "unknown",
        },
      ],
      [
        "api_retry",
        {
          attempt: 2,
          maxRetries: 10,
          retryDelayMs: 1000,
          errorStatus: 529,
          error: null,
        },
      ],
    ]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      kind: "api_retry",
      attempt: 2,
      errorStatus: 529,
    });
  });

  it("ignores non-chunk events (usage, title, turn_started)", () => {
    const chunks = fold([
      ["usage", { last: {}, total: {} }],
      ["turn_started", null],
      ["title", "A title"],
    ]);
    expect(chunks).toEqual([]);
  });
});

describe("truncateChunks / revealableLen", () => {
  const chunks: StreamChunk[] = [
    { kind: "text", text: "abcde" },
    { kind: "tool", id: "t", name: "Read", status: "done" },
    { kind: "thinking", text: "hmm" },
    { kind: "text", text: "xyz" },
  ];

  it("counts only readable (text + thinking) characters", () => {
    expect(revealableLen(chunks)).toBe(11);
  });

  it("slices the text chunk at the budget boundary", () => {
    expect(truncateChunks(chunks, 3)).toEqual([{ kind: "text", text: "abc" }]);
  });

  it("holds structural chunks behind the text that precedes them", () => {
    // Budget covers the first text exactly, so the tool card after it rides
    // along, but the thinking block (0 revealed chars) stops the projection.
    const out = truncateChunks(chunks, 5);
    expect(out).toEqual([
      { kind: "text", text: "abcde" },
      { kind: "tool", id: "t", name: "Read", status: "done" },
    ]);
  });

  it("returns the full stream once the budget covers everything", () => {
    expect(truncateChunks(chunks, revealableLen(chunks))).toEqual(chunks);
  });
});
