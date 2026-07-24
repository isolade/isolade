import { describe, expect, it } from "bun:test";
import {
  type ClaudeTranscriptEntry,
  claudeEntriesToHandoff,
  DEFAULT_ESTIMATE_CONSTANTS,
  decideHandoffAction,
  decodeHandoffItems,
  encodeHandoffItems,
  estimateFirstTargetRequest,
  estimateTokens,
  type HandoffAction,
  type HandoffBucket,
  type HandoffItem,
  isoladeBranchToHandoff,
  newestCompactSummaryIndex,
  reconstructClaudeChain,
  reduceHandoffItems,
  renderFirstTargetPrompt,
  renderHandoffEnvelope,
  renderItemsForSummary,
  resolveLimits,
  splitHandoffIntoChunks,
  stripClaudeSummaryWrapper,
  stripIsoladePrelude,
} from "../src/chat/handoff";
import type { ChatRenderChunk } from "../src/contracts";

// ── envelope ─────────────────────────────────────────────────────────────────

describe("handoff envelope", () => {
  it("round-trips items through JSON Lines", () => {
    const items: HandoffItem[] = [
      { kind: "summary", text: "earlier work" },
      { kind: "user", text: "do the thing", attachments: [] },
      { kind: "assistant", text: "on it" },
      { kind: "tool_call", id: "t1", name: "Bash", input: { command: "ls" } },
      { kind: "tool_result", id: "t1", content: [{ type: "text", text: "a\nb" }], isError: false },
    ];
    const decoded = decodeHandoffItems(encodeHandoffItems(items));
    expect(decoded).toEqual(items);
  });

  it("frames the block as historical context, not instructions", () => {
    const envelope = renderHandoffEnvelope({
      version: 1,
      source: "anthropic",
      items: [{ kind: "assistant", text: "hi" }],
    });
    expect(envelope).toContain("<isolade-context-handoff>");
    expect(envelope).toContain("</isolade-context-handoff>");
    expect(envelope).toContain("CONTEXT, not new");
    expect(envelope.toLowerCase()).toContain("historical data");
    // The single item is on its own JSONL line inside the envelope.
    expect(envelope).toContain(JSON.stringify({ kind: "assistant", text: "hi" }));
  });

  it("throws rather than silently dropping a malformed line", () => {
    expect(() => decodeHandoffItems('{"kind":"assistant","text":"ok"}\nnot json')).toThrow();
  });
});

// ── Isolade-branch normalization (Codex source / Claude raw fallback) ─────────

describe("isoladeBranchToHandoff", () => {
  const toolChunk = (
    over: Partial<Extract<ChatRenderChunk, { kind: "tool" }>>,
  ): ChatRenderChunk => ({
    kind: "tool",
    id: "t1",
    name: "Bash",
    status: "done",
    ...over,
  });

  it("reconstructs the branch with interleaved text and paired tool results", () => {
    const handoff = isoladeBranchToHandoff({
      source: "openai",
      messages: [
        { id: "u1", role: "user", content: "do X" },
        { id: "a1", role: "assistant", content: "final text ignored when chunks exist" },
        { id: "u2", role: "user", content: "next" },
        { id: "a2", role: "assistant", content: "plain answer" },
      ],
      renderChunksByMessageId: {
        a1: [
          { kind: "text", text: "working " },
          toolChunk({ input: { command: "ls" }, output: "file.txt", isError: false }),
          { kind: "text", text: "done" },
        ],
        a2: [], // pure-text turn: use content
      },
      attachmentsByMessageId: {
        u1: [{ filename: "a.png", mediaType: "image/png", guestPath: "/w/a.png" }],
      },
    });
    expect(handoff.source).toBe("openai");
    expect(handoff.items).toEqual([
      {
        kind: "user",
        text: "do X",
        attachments: [{ filename: "a.png", mediaType: "image/png", guestPath: "/w/a.png" }],
      },
      { kind: "assistant", text: "working " },
      { kind: "tool_call", id: "t1", name: "Bash", input: { command: "ls" } },
      {
        kind: "tool_result",
        id: "t1",
        content: [{ type: "text", text: "file.txt" }],
        isError: false,
      },
      { kind: "assistant", text: "done" },
      { kind: "user", text: "next" },
      { kind: "assistant", text: "plain answer" },
    ]);
  });

  it("marks an unfinished tool call interrupted and omits its result", () => {
    const handoff = isoladeBranchToHandoff({
      source: "openai",
      messages: [{ id: "a1", role: "assistant", content: "" }],
      renderChunksByMessageId: {
        a1: [toolChunk({ id: "t9", name: "Read", input: { path: "x" }, status: "running" })],
      },
    });
    expect(handoff.items).toEqual([
      { kind: "tool_call", id: "t9", name: "Read", input: { path: "x" }, interrupted: true },
    ]);
  });

  it("drops thinking and raw chunks", () => {
    const handoff = isoladeBranchToHandoff({
      source: "openai",
      messages: [{ id: "a1", role: "assistant", content: "" }],
      renderChunksByMessageId: {
        a1: [
          { kind: "thinking", text: "secret reasoning" },
          { kind: "text", text: "visible" },
          { kind: "raw", source: "codex", label: "debug", payload: {} },
        ],
      },
    });
    expect(handoff.items).toEqual([{ kind: "assistant", text: "visible" }]);
  });
});

// ── Claude native-transcript extraction ──────────────────────────────────────

describe("Claude transcript reconstruction", () => {
  const entry = (over: Partial<ClaudeTranscriptEntry>): ClaudeTranscriptEntry => ({ ...over });
  const user = (uuid: string, parent: string | null, text: string) =>
    entry({ uuid, parentUuid: parent, type: "user", message: { role: "user", content: text } });
  const assistant = (uuid: string, parent: string | null, text: string) =>
    entry({
      uuid,
      parentUuid: parent,
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text }] },
    });

  it("follows parentUuid, not physical order, and ignores the other branch", () => {
    const entries = [
      user("u0", null, "hello"),
      assistant("u1", "u0", "A"),
      // Branch B interleaved physically before branch A's tip.
      user("u2b", "u1", "path B"),
      assistant("u3b", "u2b", "resB"),
      user("u2a", "u1", "path A"),
      assistant("u3a", "u2a", "resA"),
    ];
    const chain = reconstructClaudeChain(entries, "u3a").map((e) => e.uuid);
    expect(chain).toEqual(["u0", "u1", "u2a", "u3a"]);
    expect(chain).not.toContain("u3b");
  });

  it("selects the newest compact summary and drops what it supersedes", () => {
    const entries = [
      user("u0", null, "old stuff"),
      entry({
        uuid: "s1",
        parentUuid: "u0",
        type: "user",
        isCompactSummary: true,
        message: { role: "user", content: "SUMMARY ONE" },
      }),
      assistant("a1", "s1", "after one"),
      entry({
        uuid: "s2",
        parentUuid: "a1",
        type: "user",
        isCompactSummary: true,
        message: { role: "user", content: "SUMMARY TWO" },
      }),
      assistant("a2", "s2", "after two"),
    ];
    const chain = reconstructClaudeChain(entries, "a2");
    expect(newestCompactSummaryIndex(chain)).toBe(3);
    const handoff = claudeEntriesToHandoff(entries, { anchorUuid: "a2" });
    expect(handoff.items).toEqual([
      { kind: "summary", text: "SUMMARY TWO" },
      { kind: "assistant", text: "after two" },
    ]);
  });

  it("strips the continuation wrapper and transcript-path suggestion from a summary", () => {
    const wrapped =
      "This session is being continued from a previous conversation that ran out of context. " +
      "The summary below covers the earlier portion of the conversation.\n\n" +
      "1. The user asked for a parser.\n2. We wrote it.\n\n" +
      "If you need specific details from before compaction (like exact code snippets, error " +
      "messages, or content you generated), read the full transcript at: /home/user/.claude/x.jsonl";
    expect(stripClaudeSummaryWrapper(wrapped)).toBe(
      "1. The user asked for a parser.\n2. We wrote it.",
    );
  });

  it("excludes thinking, signatures, sidechains, meta, and compact-boundary records", () => {
    const entries = [
      user("u0", null, "start"),
      entry({
        uuid: "a1",
        parentUuid: "u0",
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "visible answer" },
            { type: "thinking", thinking: "private chain of thought", signature: "sig-abc" },
            { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
          ],
        },
      }),
      entry({
        uuid: "tr",
        parentUuid: "a1",
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "ok", is_error: false }],
        },
      }),
      // Noise entries that must be dropped.
      entry({
        uuid: "m1",
        parentUuid: "tr",
        type: "user",
        isMeta: true,
        message: { role: "user", content: "meta" },
      }),
      entry({
        uuid: "sc",
        parentUuid: "tr",
        type: "assistant",
        isSidechain: true,
        message: { role: "assistant", content: [{ type: "text", text: "subagent" }] },
      }),
      entry({
        uuid: "cb",
        parentUuid: "sc",
        type: "system",
        compactMetadata: {},
        message: { role: "user", content: "boundary" },
      }),
      assistant("a2", "cb", "final"),
    ];
    const handoff = claudeEntriesToHandoff(entries, { anchorUuid: "a2" });
    expect(handoff.items).toEqual([
      { kind: "user", text: "start" },
      { kind: "assistant", text: "visible answer" },
      { kind: "tool_call", id: "t1", name: "Bash", input: { command: "ls" } },
      { kind: "tool_result", id: "t1", content: [{ type: "text", text: "ok" }], isError: false },
      { kind: "assistant", text: "final" },
    ]);
    // No leaked private reasoning or signatures.
    const encoded = encodeHandoffItems(handoff.items);
    expect(encoded).not.toContain("private chain of thought");
    expect(encoded).not.toContain("sig-abc");
    expect(encoded).not.toContain("subagent");
  });

  it("marks a non-text tool result unsupported (requires consent)", () => {
    const entries = [
      { uuid: "u0", parentUuid: null, type: "user", message: { role: "user", content: "look" } },
      {
        uuid: "a1",
        parentUuid: "u0",
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "Screenshot", input: {} }],
        },
      },
      {
        uuid: "tr",
        parentUuid: "a1",
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: [{ type: "image", source: { type: "base64", data: "AAAA" } }],
              is_error: false,
            },
          ],
        },
      },
    ] satisfies ClaudeTranscriptEntry[];
    const handoff = claudeEntriesToHandoff(entries, { anchorUuid: "tr" });
    const result = handoff.items.find((i) => i.kind === "tool_result");
    expect(result).toBeDefined();
    expect(result?.kind === "tool_result" && result.content[0]?.type).toBe("unsupported");
  });

  // Regression tests for bugs found by running against a real claude 2.1.217
  // transcript (hand-written fixtures had missed them).

  it("strips the Isolade prelude from the first user message", () => {
    // The native transcript stores the first user message WITH the injected
    // <prelude> block; the design excludes it (the target gets the current
    // prelude separately).
    expect(
      stripIsoladePrelude(
        "<prelude>\nYou are operating within a sandbox.\n</prelude>\n\nImplement the design",
      ),
    ).toBe("Implement the design");
    const entries = [
      {
        uuid: "u0",
        parentUuid: null,
        type: "user",
        message: {
          role: "user",
          content: "<prelude>\nenvironment notes\n</prelude>\n\nDo the thing",
        },
      },
      assistant("a1", "u0", "done"),
    ] satisfies ClaudeTranscriptEntry[];
    const handoff = claudeEntriesToHandoff(entries, { anchorUuid: "a1" });
    expect(handoff.items[0]).toEqual({ kind: "user", text: "Do the thing" });
  });

  it("falls back to the last conversation entry, not trailing bookkeeping lines", () => {
    // Real transcripts end with non-conversation entries (ai-title, last-prompt,
    // queue-operation) that carry a uuid but no parentUuid. Without an explicit
    // anchor, the leaf must be the last user/assistant entry, or the chain
    // collapses to a single stray line.
    const entries = [
      user("u0", null, "hi"),
      assistant("a1", "u0", "answer"),
      // Bookkeeping entries physically last, each a root with no parentUuid.
      entry({ uuid: "lp", parentUuid: null, type: "last-prompt", message: undefined }),
      entry({ uuid: "at", parentUuid: null, type: "ai-title", message: undefined }),
    ];
    const chain = reconstructClaudeChain(entries).map((e) => e.uuid);
    expect(chain).toEqual(["u0", "a1"]);
  });

  it("ignores isCompactSummary:false entries (present on ordinary rows)", () => {
    // claude writes the key with value false on many entries; only `true` marks
    // a real summary.
    const entries = [
      entry({
        uuid: "u0",
        parentUuid: null,
        type: "user",
        isCompactSummary: false,
        message: { role: "user", content: "hello" },
      }),
      assistant("a1", "u0", "hi"),
    ];
    expect(newestCompactSummaryIndex(reconstructClaudeChain(entries, "a1"))).toBe(-1);
    const handoff = claudeEntriesToHandoff(entries, { anchorUuid: "a1" });
    expect(handoff.items.some((i) => i.kind === "summary")).toBe(false);
  });
});

// ── capacity estimation & decision policy ────────────────────────────────────

describe("capacity estimation", () => {
  const capacity = { contextWindow: 100_000 };
  const parts = (summaryText: string, userMessage = "answer this") => ({
    prelude: null,
    handoff: {
      version: 1,
      source: "anthropic" as const,
      items: summaryText ? ([{ kind: "summary", text: summaryText }] as HandoffItem[]) : [],
    },
    attachmentsPreamble: null,
    userMessage,
  });

  it("derives the three limit points", () => {
    const limits = resolveLimits(capacity);
    // 0.9 * 100000, then 0.85 of that; hard = window - safety.
    expect(limits.preferredCompactionLimit).toBe(90_000);
    expect(limits.directLimit).toBe(76_500);
    expect(limits.hardLimit).toBe(92_000);
  });

  it("honors a provider-reported auto-compaction limit", () => {
    const limits = resolveLimits({ contextWindow: 100_000, autoCompactLimit: 60_000 });
    expect(limits.preferredCompactionLimit).toBe(60_000);
    expect(limits.directLimit).toBe(51_000);
  });

  const bucketFor = (summaryText: string): HandoffBucket =>
    estimateFirstTargetRequest(parts(summaryText), capacity).bucket;

  it("classifies a small handoff as direct", () => {
    expect(bucketFor("just a little context")).toBe("direct");
  });

  it("classifies a mid handoff as compaction-preferred", () => {
    // ~90k bytes ≈ 30k tokens → total ≈ 82k, between directLimit and hardLimit.
    expect(bucketFor("a".repeat(90_000))).toBe("compaction-preferred");
  });

  it("classifies a large handoff as oversized", () => {
    // ~140k bytes ≈ 46.7k tokens → total ≈ 99k, above the hard limit.
    expect(bucketFor("a".repeat(140_000))).toBe("oversized");
  });

  it("flags a current user message that alone exceeds the hard limit", () => {
    const est = estimateFirstTargetRequest(parts("", "b".repeat(140_000)), capacity);
    expect(est.userMessageExceedsHardLimit).toBe(true);
    // Reducing history cannot help: it is also oversized.
    expect(est.bucket).toBe("oversized");
  });

  it("does not flag a normal current message even with a big history", () => {
    const est = estimateFirstTargetRequest(parts("a".repeat(140_000)), capacity);
    expect(est.userMessageExceedsHardLimit).toBe(false);
  });

  it("measures the fully assembled prompt including the envelope framing", () => {
    const p = parts("context body");
    const est = estimateFirstTargetRequest(p, capacity);
    const rendered = renderFirstTargetPrompt(p);
    expect(est.estimatedInputTokens).toBe(
      Math.ceil(Buffer.byteLength(rendered, "utf8") / DEFAULT_ESTIMATE_CONSTANTS.bytesPerToken),
    );
  });
});

describe("decideHandoffAction (availability matrix)", () => {
  const cases: Array<[HandoffBucket, boolean, boolean, HandoffAction]> = [
    ["direct", true, true, "transfer-direct"],
    ["direct", false, true, "transfer-direct"],
    ["compaction-preferred", true, true, "source-reduce"],
    ["compaction-preferred", false, true, "transfer-raw"],
    ["oversized", true, true, "source-reduce"],
    ["oversized", false, true, "target-chunk"],
    ["direct", true, false, "keep-pending"],
    ["compaction-preferred", false, false, "keep-pending"],
    ["oversized", true, false, "keep-pending"],
  ];
  for (const [bucket, sourceAvailable, targetAvailable, expected] of cases) {
    it(`${bucket} / source=${sourceAvailable} / target=${targetAvailable} → ${expected}`, () => {
      expect(decideHandoffAction({ bucket, sourceAvailable, targetAvailable })).toBe(expected);
    });
  }
});

// ── target-side chunking ─────────────────────────────────────────────────────

describe("splitHandoffIntoChunks", () => {
  const constants = DEFAULT_ESTIMATE_CONSTANTS;
  const budgetOf = (text: string) =>
    Math.ceil(Buffer.byteLength(text, "utf8") / constants.bytesPerToken);

  it("splits at turn boundaries and keeps a tool call with its result", () => {
    const items: HandoffItem[] = [
      { kind: "user", text: "turn one" },
      { kind: "assistant", text: "reply one" },
      { kind: "tool_call", id: "t1", name: "Bash", input: { c: "ls" } },
      { kind: "tool_result", id: "t1", content: [{ type: "text", text: "out" }], isError: false },
      { kind: "user", text: "turn two" },
      { kind: "assistant", text: "reply two" },
    ];
    // A budget that fits one turn but not two.
    const oneTurn = JSON.stringify(items.slice(0, 4));
    const chunks = splitHandoffIntoChunks(items, {
      chunkBudgetTokens: budgetOf(oneTurn) + 10,
      constants,
    });
    expect(chunks.length).toBe(2);
    // The tool_call and its tool_result never land in different chunks.
    for (const chunk of chunks) {
      const call = chunk.findIndex((i) => i.kind === "tool_call");
      if (call !== -1) {
        expect(chunk[call + 1]?.kind).toBe("tool_result");
      }
    }
    // First chunk is the first whole turn.
    expect(chunks[0]!.map((i) => i.kind)).toEqual([
      "user",
      "assistant",
      "tool_call",
      "tool_result",
    ]);
    expect(chunks[1]!.map((i) => i.kind)).toEqual(["user", "assistant"]);
  });

  it("splits a single oversized tool result into labeled parts within budget", () => {
    const huge = "X".repeat(60_000);
    const items: HandoffItem[] = [
      { kind: "user", text: "run it" },
      { kind: "tool_call", id: "t1", name: "Bash", input: {} },
      { kind: "tool_result", id: "t1", content: [{ type: "text", text: huge }], isError: false },
    ];
    const budget = 5_000; // far smaller than the tool result alone
    const chunks = splitHandoffIntoChunks(items, { chunkBudgetTokens: budget, constants });
    const resultItems = chunks.flat().filter((i) => i.kind === "tool_result");
    // The one huge result became several parts.
    expect(resultItems.length).toBeGreaterThan(1);
    // Every part keeps the original tool id and is labeled.
    for (const r of resultItems) {
      expect(r.kind === "tool_result" && r.id).toBe("t1");
      const text =
        r.kind === "tool_result" ? (r.content[0]?.type === "text" ? r.content[0].text : "") : "";
      expect(text).toContain("Isolade handoff: tool result continued");
    }
    // No chunk exceeds the budget.
    for (const chunk of chunks) {
      const tokens = Math.ceil(
        Buffer.byteLength(JSON.stringify(chunk), "utf8") / constants.bytesPerToken,
      );
      expect(tokens).toBeLessThanOrEqual(budget);
    }
    // Reassembling the parts recovers the full output.
    const reassembled = resultItems
      .map((r) =>
        r.kind === "tool_result" && r.content[0]?.type === "text" ? r.content[0].text : "",
      )
      .map((t) => t.replace(/^\[Isolade handoff: tool result continued, part \d+ of \d+\]\n/, ""))
      .join("");
    expect(reassembled).toBe(huge);
  });

  it("keeps a leading summary with the first chunk", () => {
    const items: HandoffItem[] = [
      { kind: "summary", text: "the story so far" },
      { kind: "user", text: "u1" },
      { kind: "user", text: "u2" },
    ];
    const chunks = splitHandoffIntoChunks(items, { chunkBudgetTokens: 30, constants });
    expect(chunks[0]![0]).toEqual({ kind: "summary", text: "the story so far" });
  });
});

// ── rolling-summary reduction ────────────────────────────────────────────────

describe("reduceHandoffItems", () => {
  const conversation = (): HandoffItem[] => [
    { kind: "user", text: "build a parser" },
    { kind: "assistant", text: "starting on the parser" },
    { kind: "user", text: "now add error recovery" },
    { kind: "assistant", text: "added error recovery" },
    { kind: "user", text: "now the formatter" },
    { kind: "assistant", text: "formatter done" },
  ];

  it("rolls a running summary through the chunks and returns one summary item", async () => {
    const items = conversation();
    // A budget small enough that each turn becomes its own chunk.
    const chunkBudgetTokens = 25;
    const chunks = splitHandoffIntoChunks(items, { chunkBudgetTokens });
    expect(chunks.length).toBeGreaterThan(1);

    const prompts: string[] = [];
    const summarize = async (prompt: string) => {
      prompts.push(prompt);
      return `summary-after-${prompts.length}`;
    };
    const progress: Array<[number, number]> = [];
    const reduced = await reduceHandoffItems(items, {
      summarize,
      chunkBudgetTokens,
      onProgress: (step, total) => progress.push([step, total]),
    });

    // One summarization request per chunk, and the result is a single compact
    // summary item (well under the target, so no compression pass).
    expect(prompts).toHaveLength(chunks.length);
    expect(reduced).toEqual([{ kind: "summary", text: `summary-after-${chunks.length}` }]);
    // Rolling: each step after the first carries the previous summary forward.
    expect(prompts[1]).toContain("summary-after-1");
    expect(prompts[0]).toContain("no summary yet");
    expect(progress.at(-1)).toEqual([chunks.length, chunks.length]);
  });

  it("bounds an over-long summary by compressing then truncating", async () => {
    // A model that ignores the length instruction and always returns a huge blob.
    const summarize = async () => "X".repeat(60_000);
    const reduced = await reduceHandoffItems([{ kind: "user", text: "hi" }], {
      summarize,
      chunkBudgetTokens: 100_000,
      summaryTokenTarget: 100,
    });
    expect(reduced).toHaveLength(1);
    const summary = reduced[0]!;
    expect(summary.kind).toBe("summary");
    if (summary.kind === "summary") {
      // Even against an uncooperative model, the handoff can't itself be oversized.
      expect(estimateTokens(summary.text)).toBeLessThanOrEqual(200);
      expect(summary.text).toContain("truncated");
    }
  });

  it("propagates abort", async () => {
    const controller = new AbortController();
    const summarize = async () => {
      controller.abort();
      return "partial";
    };
    await expect(
      reduceHandoffItems(conversation(), {
        summarize,
        chunkBudgetTokens: 25,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });

  it("renders items as readable prose for the summarizer", () => {
    const text = renderItemsForSummary([
      { kind: "user", text: "do X" },
      { kind: "assistant", text: "ok" },
      { kind: "tool_call", id: "t1", name: "Bash", input: { command: "ls" } },
      {
        kind: "tool_result",
        id: "t1",
        content: [{ type: "text", text: "file.txt" }],
        isError: false,
      },
    ]);
    expect(text).toContain("User: do X");
    expect(text).toContain("Assistant: ok");
    expect(text).toContain("Assistant called tool Bash");
    expect(text).toContain("Tool result: file.txt");
    // No JSON envelope leaks into the summarization prompt.
    expect(text).not.toContain('"kind"');
  });
});
