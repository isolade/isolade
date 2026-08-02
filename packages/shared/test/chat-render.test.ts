import { describe, expect, it } from "bun:test";
import {
  applyChatRenderEvent,
  type ChatRenderChunk,
  summarizeChatToolInput,
} from "../src/chat-render";

describe("applyChatRenderEvent", () => {
  it("moves an optimistic interruption and user message together to the acknowledged position", () => {
    const chunks: ChatRenderChunk[] = [
      { kind: "text", text: "Before." },
      { kind: "interruption", id: "now-1" },
      {
        kind: "user_message",
        id: "now-1",
        content: "Change direction.",
        deliveryStatus: "sending",
      },
      { kind: "text", text: "Raced with acknowledgement." },
    ];
    const toolIndex = new Map<string, number>();

    applyChatRenderEvent(chunks, toolIndex, "turn_interrupted", { id: "now-1" });
    applyChatRenderEvent(chunks, toolIndex, "steered_user_message", {
      id: "now-1",
      content: "Change direction.",
      deliveryStatus: "confirmed",
    });

    expect(chunks).toEqual([
      { kind: "text", text: "Before." },
      { kind: "text", text: "Raced with acknowledgement." },
      { kind: "interruption", id: "now-1" },
      {
        kind: "user_message",
        id: "now-1",
        content: "Change direction.",
        deliveryStatus: "confirmed",
      },
    ]);
  });

  it("folds a snapshotted image into a lookup chunk for the occurrence", () => {
    const chunks: ChatRenderChunk[] = [{ kind: "text", text: "Here it is: ![a chart](out/a.png)" }];
    applyChatRenderEvent(chunks, new Map(), "agent_image", {
      id: "upload-1",
      sourcePath: "out/a.png",
      offset: 12,
      filename: "a.png",
      mediaType: "image/png",
      size: 24,
    });
    expect(chunks).toContainEqual({
      kind: "image",
      id: "upload-1",
      sourcePath: "out/a.png",
      offset: 12,
      filename: "a.png",
      mediaType: "image/png",
      size: 24,
    });
  });

  it("does not break a sentence in two when a snapshot lands mid-stream", () => {
    // The snapshot is published the instant its reference closes, which is
    // mid-sentence. Left after the text, it would stop the next delta
    // coalescing, and the reply would render as two paragraphs split at
    // whatever character the capture happened to interrupt.
    const chunks: ChatRenderChunk[] = [];
    const toolIndex = new Map<string, number>();
    applyChatRenderEvent(chunks, toolIndex, "delta", "And the site");
    applyChatRenderEvent(chunks, toolIndex, "agent_image", {
      id: "upload-1",
      sourcePath: "og.png",
      offset: 4,
      filename: "og.png",
      mediaType: "image/png",
      size: 24,
    });
    applyChatRenderEvent(chunks, toolIndex, "delta", "'s Open Graph card:");

    expect(chunks.filter((chunk) => chunk.kind === "text")).toEqual([
      { kind: "text", text: "And the site's Open Graph card:" },
    ]);
    // And the growing text run stays last, which is what the streaming caret
    // and the reveal projection both key off.
    expect(chunks.at(-1)?.kind).toBe("text");
  });

  it("still appends a snapshot that follows a tool call", () => {
    // Text after a tool call is a new block regardless, so there is nothing to
    // coalesce into and the image simply goes at the end.
    const chunks: ChatRenderChunk[] = [];
    const toolIndex = new Map<string, number>();
    applyChatRenderEvent(chunks, toolIndex, "tool_call_start", { id: "t1", name: "Bash" });
    applyChatRenderEvent(chunks, toolIndex, "agent_image", {
      id: "upload-1",
      sourcePath: "og.png",
      offset: 4,
      filename: "og.png",
      mediaType: "image/png",
      size: 24,
    });
    expect(chunks.map((chunk) => chunk.kind)).toEqual(["tool", "image"]);
  });

  it("replaces rather than stacks when a resumed turn republishes an image", () => {
    const chunks: ChatRenderChunk[] = [];
    const toolIndex = new Map<string, number>();
    const image = {
      id: "upload-1",
      sourcePath: "out/a.png",
      offset: 12,
      filename: "a.png",
      mediaType: "image/png",
      size: 24,
    };
    applyChatRenderEvent(chunks, toolIndex, "agent_image", image);
    applyChatRenderEvent(chunks, toolIndex, "agent_image", { ...image, id: "upload-2" });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ kind: "image", id: "upload-2" });
  });

  it("keeps one path's separate mentions apart", () => {
    // Two mentions of a file the agent rewrote in between are two snapshots,
    // told apart by where they sit, so neither replaces the other.
    const chunks: ChatRenderChunk[] = [];
    const toolIndex = new Map<string, number>();
    const image = {
      sourcePath: "shot.png",
      filename: "shot.png",
      mediaType: "image/png",
      size: 24,
    };
    applyChatRenderEvent(chunks, toolIndex, "agent_image", { ...image, id: "before", offset: 10 });
    applyChatRenderEvent(chunks, toolIndex, "agent_image", { ...image, id: "after", offset: 90 });
    expect(chunks).toHaveLength(2);
    expect(chunks.map((chunk) => chunk.kind === "image" && chunk.id)).toEqual(["before", "after"]);
  });

  it("ignores a malformed image payload instead of poisoning the chunk stream", () => {
    const chunks: ChatRenderChunk[] = [];
    applyChatRenderEvent(chunks, new Map(), "agent_image", { id: "upload-1" });
    expect(chunks).toEqual([]);
  });
});

describe("what the reducer claims to handle", () => {
  // One representative payload per event the reducer folds. The point is not
  // the shape of each but that the reducer both recognizes the name and does
  // something with it, since the live client decides what to surface as an
  // unknown event purely from what this reports. A new chunk event added to
  // the switch belongs here too.
  const SAMPLES: Record<string, unknown> = {
    delta: "text",
    thinking: { text: "reasoning" },
    thinking_start: { id: "r1", provider: "codex" },
    thinking_delta: { id: "r1", provider: "codex", text: "x" },
    thinking_tokens: { id: "r1", provider: "codex", tokens: 5 },
    thinking_done: { id: "r1", provider: "codex", text: "x" },
    tool_call_start: { id: "t1", name: "Bash" },
    tool_call_input: { id: "t1", input: { command: "ls" } },
    tool_call_result: { id: "t1", output: "ok" },
    steered_user_message: { id: "u1", content: "hi" },
    turn_interrupted: { id: "u1" },
    render_seed: [{ kind: "text", text: "seeded" }],
    api_retry: { attempt: 1, maxRetries: 3, retryDelayMs: 10 },
    provider_switch: { toProvider: "openai", toModel: "gpt" },
    agent_image: {
      id: "upload-1",
      sourcePath: "a.png",
      offset: 0,
      filename: "a.png",
      mediaType: "image/png",
      size: 1,
    },
    raw: { source: "claude", payload: {} },
  };

  it("claims every event it folds, and folds every event it claims", () => {
    for (const [type, payload] of Object.entries(SAMPLES)) {
      const chunks: ChatRenderChunk[] = [];
      // `tool_call_input` and `tool_call_result` only amend an existing card,
      // so give them one to amend. Not `tool_call_start` itself, which is
      // idempotent and would look unfolded against its own seed.
      if (type === "tool_call_input" || type === "tool_call_result") {
        applyChatRenderEvent(chunks, new Map(), "tool_call_start", SAMPLES.tool_call_start);
      }
      const toolIndex = new Map<string, number>();
      for (const [index, chunk] of chunks.entries()) {
        if (chunk.kind === "tool") toolIndex.set(chunk.id, index);
      }
      const before = JSON.stringify(chunks);
      expect(
        applyChatRenderEvent(chunks, toolIndex, type, payload),
        `${type} was not claimed`,
      ).toBe(true);
      expect(JSON.stringify(chunks), `${type} was claimed but not folded`).not.toBe(before);
    }
  });

  it("disowns an event it has never heard of, rather than ignoring it", () => {
    // This is the signal the live client turns into a visible debug chunk, so
    // an event from a newer server is never dropped without trace.
    const chunks: ChatRenderChunk[] = [];
    expect(applyChatRenderEvent(chunks, new Map(), "some_future_event", { a: 1 })).toBe(false);
    expect(chunks).toEqual([]);
  });

  it("still claims a recognized event whose payload is malformed", () => {
    // Ours to drop quietly. Disowning it would show the reader an unknown
    // event, which is a claim about the server rather than about the payload.
    const chunks: ChatRenderChunk[] = [];
    expect(applyChatRenderEvent(chunks, new Map(), "tool_call_start", {})).toBe(true);
    expect(applyChatRenderEvent(chunks, new Map(), "agent_image", { id: "only-an-id" })).toBe(true);
    expect(chunks).toEqual([]);
  });
});

describe("summarizeChatToolInput", () => {
  // Payload shapes from codex's app-server schema (v2 ThreadItem): every
  // command runs through a login shell, and commandActions is its own parse of
  // the script, collapsed to one Unknown entry when it recognized no steps.
  it("shows the script a codex shell call ran, not the login shell around it", () => {
    expect(
      summarizeChatToolInput({
        command: "/bin/bash -lc 'sleep 2'",
        cwd: "/workspace",
        commandActions: [{ type: "unknown", command: "sleep 2" }],
      }),
    ).toBe("sleep 2");
  });

  it("unwraps the login shell when codex parsed the script into several steps", () => {
    expect(
      summarizeChatToolInput({
        command: `/bin/bash -lc 'cat notes.md | grep todo'`,
        commandActions: [
          { type: "read", command: "cat notes.md", name: "notes.md", path: "/w/notes.md" },
          { type: "search", command: "grep todo", query: "todo", path: null },
        ],
      }),
    ).toBe("cat notes.md | grep todo");
  });

  it("unwraps the login shell without any parse to lean on", () => {
    expect(summarizeChatToolInput({ command: `sh -c "bun test"` })).toBe("bun test");
    expect(summarizeChatToolInput({ command: "/usr/bin/zsh --login -c 'bun test'" })).toBe(
      "bun test",
    );
  });

  it("keeps a command that is not a wrapped script as it is", () => {
    expect(summarizeChatToolInput({ command: "bun test --coverage" })).toBe("bun test --coverage");
    expect(summarizeChatToolInput({ command: ["bun", "test", "--coverage"] })).toBe(
      "bun test --coverage",
    );
    // An inner single quote leaves the unescaping to a shell lexer, so the raw
    // string stands rather than being cut at the wrong quote.
    expect(summarizeChatToolInput({ command: `bash -lc 'echo '\\''hi'\\'''` })).toBe(
      `bash -lc 'echo '\\''hi'\\'''`,
    );
  });

  it("takes the first line that says something from a multi-line script", () => {
    expect(
      summarizeChatToolInput({ command: "/bin/bash -lc '\n  bun test\n  bun run lint\n'" }),
    ).toBe("bun test");
  });

  it("names the file a codex file change touched, and counts the rest", () => {
    expect(summarizeChatToolInput({ changes: [{ path: "/w/app.ts", kind: "update" }] })).toBe(
      "/w/app.ts",
    );
    expect(
      summarizeChatToolInput({
        changes: [
          { path: "/w/app.ts", kind: "update" },
          { path: "/w/blocks.tsx", kind: "update" },
          { path: "/w/index.css", kind: "add" },
        ],
      }),
    ).toBe("/w/app.ts (+2 more)");
  });
});
