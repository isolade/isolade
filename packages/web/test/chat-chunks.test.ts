import { describe, expect, it } from "bun:test";
import {
  applyEvent,
  mergeToolDetails,
  replaceChunksFromSnapshot,
  revealableLength,
  revealChunks,
  type StreamChunk,
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
        summary: "ls",
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

  it("assembles provider thinking progress into one visible thought", () => {
    const chunks = fold([
      ["thinking_start", { id: "reasoning-1", provider: "codex" }],
      ["thinking_delta", { id: "reasoning-1", provider: "codex", text: "**Checking" }],
      ["thinking_delta", { id: "reasoning-1", provider: "codex", text: " tests**" }],
      ["thinking_done", { id: "reasoning-1", provider: "codex", text: "**Checking tests**" }],
    ]);
    expect(chunks).toEqual([
      {
        kind: "thought",
        id: "reasoning-1",
        provider: "codex",
        text: "**Checking tests**",
        status: "done",
      },
    ]);
  });

  it("tracks Claude's total thinking-token estimate", () => {
    const chunks = fold([
      ["thinking_start", { id: "claude-thinking-0", provider: "claude" }],
      [
        "thinking_tokens",
        { id: "claude-thinking-0", provider: "claude", tokens: 768, tokensDelta: 372 },
      ],
      [
        "thinking_done",
        {
          id: "claude-thinking-0",
          provider: "claude",
          text: "A useful summary",
          tokens: 768,
        },
      ],
    ]);
    expect(chunks).toEqual([
      {
        kind: "thought",
        id: "claude-thinking-0",
        provider: "claude",
        text: "A useful summary",
        tokens: 768,
        status: "done",
      },
    ]);
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

describe("replaceChunksFromSnapshot", () => {
  it("restores earlier debug chunks and replays only events newer than the snapshot", () => {
    const chunks: StreamChunk[] = [{ kind: "text", text: "stale" }];
    const toolIndex = new Map<string, number>();

    replaceChunksFromSnapshot(
      chunks,
      toolIndex,
      [
        { kind: "thinking", text: "earlier reasoning" },
        { kind: "text", text: "answer" },
      ],
      4,
      [
        { seq: 4, type: "delta", payload: "duplicate" },
        { seq: 5, type: "delta", payload: " continued" },
        { seq: 6, type: "tool_call_start", payload: { id: "tool-1", name: "Read" } },
      ],
    );

    expect(chunks).toEqual([
      { kind: "thinking", text: "earlier reasoning" },
      { kind: "text", text: "answer continued" },
      { kind: "tool", id: "tool-1", name: "Read", status: "running" },
    ]);
    expect(toolIndex.get("tool-1")).toBe(2);
  });
});

describe("live reveal projection", () => {
  it("reveals readable chunks in order and gates later structural chunks", () => {
    const chunks = [
      { kind: "text", text: "hello" },
      { kind: "tool", id: "tool-1", name: "Read", status: "running" },
      { kind: "text", text: "world" },
    ] satisfies StreamChunk[];

    expect(revealableLength(chunks)).toBe(10);
    expect(revealChunks(chunks, 3)).toEqual([{ kind: "text", text: "hel" }]);
    expect(revealChunks(chunks, 7)).toEqual([chunks[0], chunks[1], { kind: "text", text: "wo" }]);
    expect(revealChunks(chunks, 10)).toEqual(chunks);
    expect(revealChunks(chunks, 10)).not.toBe(chunks);
  });

  it("reveals thought summaries as readable content", () => {
    const chunks = [
      {
        kind: "thought",
        id: "thought-1",
        provider: "claude",
        text: "summary",
        tokens: 100,
        status: "done",
      },
    ] satisfies StreamChunk[];

    expect(revealableLength(chunks)).toBe(7);
    expect(revealChunks(chunks, 3)).toEqual([{ ...chunks[0], text: "sum" }]);
  });

  it("does not expose half of a surrogate pair", () => {
    const chunks = [{ kind: "text", text: "A😀B" }] satisfies StreamChunk[];

    expect(revealChunks(chunks, 2)).toEqual([{ kind: "text", text: "A" }]);
    expect(revealChunks(chunks, 3)).toEqual([{ kind: "text", text: "A😀" }]);
  });
});

describe("mergeToolDetails", () => {
  it("fills only the requested tool without discarding newer streamed state", () => {
    const untouched = {
      kind: "tool" as const,
      id: "tool-2",
      name: "Bash",
      summary: "echo untouched",
      input: `${"z".repeat(1024)}…`,
      status: "done" as const,
      detailsAvailable: true,
    };
    const chunks: StreamChunk[] = [
      { kind: "text", text: "before" },
      {
        kind: "tool",
        id: "tool-1",
        name: "Read",
        input: `${"x".repeat(1024)}…`,
        output: "newer result",
        status: "done",
        detailsAvailable: true,
      },
      { kind: "text", text: "arrived after the request" },
      untouched,
    ];

    expect(
      mergeToolDetails(
        chunks,
        [
          {
            kind: "tool",
            id: "tool-1",
            name: "Read",
            input: { file_path: "/workspace/large.txt" },
            output: "stale result",
            status: "running",
          },
          {
            kind: "tool",
            id: "tool-2",
            name: "Bash",
            input: { command: "echo should not merge" },
            status: "done",
          },
        ],
        "tool-1",
      ),
    ).toEqual({ matched: true, changed: true, complete: true });

    expect(chunks).toEqual([
      { kind: "text", text: "before" },
      {
        kind: "tool",
        id: "tool-1",
        name: "Read",
        summary: "/workspace/large.txt",
        input: { file_path: "/workspace/large.txt" },
        output: "newer result",
        status: "done",
        detailsAvailable: false,
      },
      { kind: "text", text: "arrived after the request" },
      untouched,
    ]);
    expect(chunks[3]).toBe(untouched);
  });
});
