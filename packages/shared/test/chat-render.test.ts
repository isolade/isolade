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
