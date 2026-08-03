import { describe, expect, it } from "bun:test";
import type { ChatEvent, ModelBilling } from "../src/chat/backend";
import { ClaudeBackend } from "../src/chat/claude-backend";
import type { Chat, ChatManager } from "../src/chats";
import type { SandboxClient } from "../src/sandbox-client";
import { FakeProc, tick } from "./fake-proc";

// Feeds a fixed list of stream-json lines (one Claude CLI event each) to the
// stdout callback, then exits, exercising ClaudeBackend's parser without a VM.
class FakeSandboxClient {
  sessionIds: string[] = [];
  constructor(
    private readonly lines: object[],
    private readonly exitCode = 0,
  ) {}
  async execStream(
    _vmId: string,
    _command: string,
    opts: { stdout: (chunk: Buffer) => void },
  ): Promise<{ exitCode: number }> {
    for (const line of this.lines) {
      opts.stdout(Buffer.from(JSON.stringify(line) + "\n"));
    }
    return { exitCode: this.exitCode };
  }
}

// During a turn ClaudeBackend calls updateSessionId, plus `get` when it resumes
// a session and has to recover the chat's running totals (see
// seedTotalsFromChat). `row` stands in for the persisted chat.
function fakeChatManager(sink: (id: string) => void, row?: Partial<Chat>): ChatManager {
  return {
    updateSessionId: (_chatId: string, sessionId?: string) => sessionId && sink(sessionId),
    get: () => row as Chat | undefined,
  } as unknown as ChatManager;
}

function backendFor(lines: object[], exitCode = 0, row?: Partial<Chat>) {
  const sessionIds: string[] = [];
  const client = new FakeSandboxClient(lines, exitCode);
  const backend = new ClaudeBackend(
    client as unknown as SandboxClient,
    fakeChatManager((id) => sessionIds.push(id), row),
  );
  return { backend, sessionIds };
}

async function run(
  lines: object[],
  exitCode = 0,
  turn: { sessionId?: string; row?: Partial<Chat> } = {},
) {
  const { backend, sessionIds } = backendFor(lines, exitCode, turn.row);
  const deltas: string[] = [];
  const events: ChatEvent[] = [];
  const billed: ModelBilling[][] = [];
  const result = await backend.sendMessage({
    vmId: "vm",
    chatId: "chat",
    message: "hi",
    model: "claude-sonnet-4-5",
    effort: "high",
    ...(turn.sessionId != null ? { sessionId: turn.sessionId } : {}),
    onDelta: (t) => deltas.push(t),
    onEvent: (e) => events.push(e),
    onBilling: (models) => billed.push(models),
  });
  return { result, deltas, events, billed, sessionIds };
}

const textDelta = (text: string) => ({
  type: "stream_event",
  event: { type: "content_block_delta", delta: { type: "text_delta", text } },
});

describe("ClaudeBackend stream-json parsing", () => {
  it("captures the session id from the init event", async () => {
    const { result, sessionIds } = await run([
      { type: "system", subtype: "init", session_id: "sess-1" },
      { type: "result", result: "done" },
    ]);
    expect(sessionIds).toEqual(["sess-1"]);
    expect(result.sessionId).toBe("sess-1");
  });

  it("streams text deltas and resolves with the result envelope content", async () => {
    const { result, deltas } = await run([
      { type: "system", subtype: "init", session_id: "s" },
      textDelta("Hello"),
      textDelta(", world"),
      { type: "result", result: "Hello, world" },
    ]);
    expect(deltas).toEqual(["Hello", ", world"]);
    expect(result.content).toBe("Hello, world");
  });

  // A text block is the unit the CLI itself calls the answer: its terminal
  // `result` is the last one of the turn. Marking each opening is what lets the
  // transcript pick the reply out of a turn that also talked its way there.
  it("marks each text block as the start of an utterance", async () => {
    const textBlockStart = {
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "text" } },
    };
    const { events, deltas, result } = await run([
      { type: "system", subtype: "init", session_id: "s" },
      textBlockStart,
      textDelta("Let me check the tests."),
      {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "tool-1", name: "Bash" },
        },
      },
      textBlockStart,
      textDelta("They pass."),
      { type: "result", result: "They pass." },
    ]);

    // Usage rides along on the result frame and says nothing about structure.
    const structure = events.map((event) => event.type).filter((type) => type !== "usage");
    expect(structure).toEqual(["reply_start", "tool_call_start", "reply_start"]);
    expect(deltas).toEqual(["Let me check the tests.", "They pass."]);
    // The CLI's own verdict on where the reply starts, which is the line we
    // are drawing: everything before the last text block is not it.
    expect(result.content).toBe("They pass.");
  });

  it("assembles a tool call: start, streamed JSON input, and result", async () => {
    const { events } = await run([
      { type: "system", subtype: "init", session_id: "s" },
      {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "tool-1", name: "Bash" },
        },
      },
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"command":' },
        },
      },
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '"ls"}' },
        },
      },
      { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "file.txt",
              is_error: false,
            },
          ],
        },
      },
      { type: "result", result: "" },
    ]);

    expect(events).toContainEqual({
      type: "tool_call_start",
      id: "tool-1",
      name: "Bash",
    });
    expect(events).toContainEqual({
      type: "tool_call_input",
      id: "tool-1",
      input: { command: "ls" },
    });
    expect(events).toContainEqual({
      type: "tool_call_result",
      id: "tool-1",
      output: "file.txt",
      isError: false,
    });
  });

  it("emits animated token totals and completes with the thinking summary", async () => {
    const { events } = await run([
      { type: "system", subtype: "init", session_id: "s" },
      {
        type: "system",
        subtype: "thinking_tokens",
        estimated_tokens: 768,
        estimated_tokens_delta: 372,
      },
      {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking" },
        },
      },
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "let me think" },
        },
      },
      { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
      { type: "result", result: "" },
    ]);
    expect(events).toEqual(
      expect.arrayContaining([
        {
          type: "thinking_start",
          id: "claude-thinking-0",
          provider: "claude",
        },
        {
          type: "thinking_tokens",
          id: "claude-thinking-0",
          provider: "claude",
          tokens: 768,
        },
        {
          type: "thinking_done",
          id: "claude-thinking-0",
          provider: "claude",
          text: "let me think",
          tokens: 768,
        },
      ]),
    );
  });

  it("emits usage with last + accumulated total", async () => {
    const { events } = await run([
      { type: "system", subtype: "init", session_id: "s" },
      {
        type: "stream_event",
        event: {
          type: "message_start",
          message: {
            usage: {
              input_tokens: 100,
              cache_read_input_tokens: 20,
              output_tokens: 1,
            },
          },
        },
      },
      {
        type: "stream_event",
        event: { type: "message_delta", usage: { output_tokens: 50 } },
      },
      {
        type: "result",
        result: "ok",
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 20,
          output_tokens: 50,
        },
        total_cost_usd: 0.01,
      },
    ]);
    const usage = events.filter((e) => e.type === "usage") as Extract<
      ChatEvent,
      { type: "usage" }
    >[];
    expect(usage.length).toBeGreaterThan(0);
    const last = usage[usage.length - 1]!;
    expect(last.last.inputTokens).toBe(100);
    expect(last.last.outputTokens).toBe(50);
    // Usage frames are the gauge and carry no money at all.
    expect(usage.every((event) => !("turnCostUsd" in event))).toBe(true);
  });

  it("bills a turn once it settles, from the model breakdown", async () => {
    const { billed } = await run([
      { type: "system", subtype: "init", session_id: "s" },
      {
        type: "result",
        result: "ok",
        usage: { input_tokens: 100, cache_read_input_tokens: 20, output_tokens: 50 },
        total_cost_usd: 0.42,
        // Two models in one turn: the main loop plus a sub-agent. The flat
        // `usage` above sees only the former, which is why it is not the source.
        modelUsage: {
          "claude-sonnet-4-5": {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadInputTokens: 20,
            cacheCreationInputTokens: 5,
            webSearchRequests: 2,
            costUSD: 0.3,
          },
          "claude-haiku-4-5-20251001": {
            inputTokens: 900,
            outputTokens: 40,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0.12,
          },
        },
      },
    ]);
    expect(billed).toHaveLength(1);
    expect(billed[0]).toEqual([
      {
        model: "claude-sonnet-4-5",
        usage: {
          inputTokens: 100,
          cachedInputTokens: 20,
          cacheCreationInputTokens: 5,
          outputTokens: 50,
          reasoningOutputTokens: 0,
          totalTokens: 175,
        },
        cacheWrite1hTokens: 0,
        fast: false,
        webSearchRequests: 2,
        costUsd: 0.3,
      },
      {
        model: "claude-haiku-4-5-20251001",
        usage: {
          inputTokens: 900,
          cachedInputTokens: 0,
          cacheCreationInputTokens: 0,
          outputTokens: 40,
          reasoningOutputTokens: 0,
          totalTokens: 940,
        },
        cacheWrite1hTokens: 0,
        fast: false,
        webSearchRequests: 0,
        costUsd: 0.12,
      },
    ]);
  });

  it("reads the cache-write TTL split off the envelope's flat usage", async () => {
    // Anthropic bills a one-hour write at twice input where five minutes costs
    // 1.25x, and only the flat `usage` carries the split: `modelUsage` sums the
    // two together. Reproduces the shape of a real first turn, whose bill is
    // almost entirely the system prompt and tools being cached.
    const { billed } = await run([
      { type: "system", subtype: "init", session_id: "s" },
      {
        type: "result",
        result: "ok",
        usage: {
          input_tokens: 20,
          cache_creation_input_tokens: 11_520,
          output_tokens: 28,
          cache_creation: {
            ephemeral_5m_input_tokens: 0,
            ephemeral_1h_input_tokens: 11_520,
          },
        },
        modelUsage: {
          "claude-sonnet-4-5": {
            inputTokens: 20,
            outputTokens: 28,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 11_520,
            webSearchRequests: 0,
            costUSD: 0.1155,
          },
        },
      },
    ]);
    expect(billed[0]![0]).toMatchObject({
      cacheWrite1hTokens: 11_520,
      usage: { cacheCreationInputTokens: 11_520 },
    });
  });

  it("treats writes as five-minute when the CLI reports no split", async () => {
    // Accounts that never get one-hour entries (API keys, subscribers in
    // overage) report no `cache_creation` object at all.
    const { billed } = await run([
      { type: "system", subtype: "init", session_id: "s" },
      {
        type: "result",
        result: "ok",
        usage: { input_tokens: 20, cache_creation_input_tokens: 500, output_tokens: 5 },
        modelUsage: {
          "claude-sonnet-4-5": {
            inputTokens: 20,
            outputTokens: 5,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 500,
            webSearchRequests: 0,
            costUSD: 0.01,
          },
        },
      },
    ]);
    expect(billed[0]![0]!.cacheWrite1hTokens).toBe(0);
  });

  it("leaves a sub-agent's writes unsplit rather than guessing at them", async () => {
    // The flat `usage` covers the main loop only, so the split can only be
    // attributed to the model the turn ran on.
    const { billed } = await run([
      { type: "system", subtype: "init", session_id: "s" },
      {
        type: "result",
        result: "ok",
        usage: {
          input_tokens: 1,
          cache_creation_input_tokens: 100,
          output_tokens: 1,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 100 },
        },
        modelUsage: {
          "claude-sonnet-4-5": {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 100,
            webSearchRequests: 0,
            costUSD: 0.01,
          },
          "claude-haiku-4-5-20251001": {
            inputTokens: 900,
            outputTokens: 40,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 700,
            webSearchRequests: 0,
            costUSD: 0.002,
          },
        },
      },
    ]);
    const byModel = new Map(billed[0]!.map((entry) => [entry.model, entry]));
    expect(byModel.get("claude-sonnet-4-5")!.cacheWrite1hTokens).toBe(100);
    expect(byModel.get("claude-haiku-4-5-20251001")!.cacheWrite1hTokens).toBe(0);
  });

  it("records the rate card the provider actually billed at", async () => {
    // What was asked for and what was charged can differ: fast mode can be
    // refused, and it drops into cooldown after a rate limit. The turn's own
    // report is the one that decides how it is costed.
    const withSpeed = (speed?: string) => [
      { type: "system", subtype: "init", session_id: "s" },
      {
        type: "result",
        result: "ok",
        usage: { input_tokens: 100, output_tokens: 10, ...(speed ? { speed } : {}) },
        modelUsage: {
          "claude-sonnet-4-5": {
            inputTokens: 100,
            outputTokens: 10,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0.02,
          },
        },
      },
    ];
    expect((await run(withSpeed("fast"))).billed[0]![0]!.fast).toBe(true);
    expect((await run(withSpeed("standard"))).billed[0]![0]!.fast).toBe(false);
    expect((await run(withSpeed())).billed[0]![0]!.fast).toBe(false);
  });

  it("falls back to the flat usage and cost when the CLI reports no model breakdown", async () => {
    const { billed } = await run([
      { type: "system", subtype: "init", session_id: "s" },
      {
        type: "result",
        result: "ok",
        usage: { input_tokens: 100, cache_read_input_tokens: 20, output_tokens: 50 },
        total_cost_usd: 0.01,
      },
    ]);
    expect(billed).toHaveLength(1);
    expect(billed[0]![0]).toMatchObject({
      model: "claude-sonnet-4-5",
      costUsd: 0.01,
      usage: { inputTokens: 100, cachedInputTokens: 20, outputTokens: 50 },
    });
  });

  // A fresh backend with a chat row that already holds usage is what a restarted
  // server looks like: Claude reports one turn at a time, so without recovering
  // the row the next turn would report token totals lower than the row already
  // holds, dipping the UI and clamping that turn out of every rollup.
  const oneTurn = [
    { type: "system", subtype: "init", session_id: "s" },
    {
      type: "stream_event",
      event: {
        type: "message_start",
        message: { usage: { input_tokens: 100, cache_read_input_tokens: 20, output_tokens: 1 } },
      },
    },
    {
      type: "result",
      result: "ok",
      usage: { input_tokens: 100, cache_read_input_tokens: 20, output_tokens: 50 },
      total_cost_usd: 0.01,
    },
  ];
  const spentChat: Partial<Chat> = {
    inputTokens: 900,
    cachedInputTokens: 100,
    cacheCreationInputTokens: 0,
    outputTokens: 50,
    reasoningOutputTokens: 0,
    costUsd: 1.5,
  };
  const finalUsage = (events: ChatEvent[]) =>
    events.filter((e) => e.type === "usage").at(-1) as Extract<ChatEvent, { type: "usage" }>;

  it("resumes a restarted server's running token totals from the chat row", async () => {
    const { events } = await run(oneTurn, 0, { sessionId: "s", row: spentChat });
    const usage = finalUsage(events);
    expect(usage.total.inputTokens).toBe(1000);
    expect(usage.total.cachedInputTokens).toBe(120);
    expect(usage.total.outputTokens).toBe(100);
  });

  it("does not inherit the row's token totals when starting a fresh session", async () => {
    // No resume id means a new native session (a retired one's figures are not
    // this session's), so the turn stands alone.
    const { events, billed } = await run(oneTurn, 0, { row: spentChat });
    const usage = finalUsage(events);
    expect(usage.total.inputTokens).toBe(100);
    // The bill is the turn's own either way: it never consults the row.
    expect(billed[0]![0]!.costUsd).toBeCloseTo(0.01);
  });

  it("reports `last` usage as the latest sub-call, not the sum, across a tool-use turn", async () => {
    // A tool-use turn produces one message_start per roundtrip. `last` must
    // track the LATEST sub-call's prompt (the context-pressure signal), not
    // accumulate. Otherwise cache_read sums across sub-calls and inflates the
    // gauge N×. The turn-cumulative figure lives on the result envelope.
    const { events } = await run([
      { type: "system", subtype: "init", session_id: "s" },
      {
        type: "stream_event",
        event: {
          type: "message_start",
          message: {
            usage: {
              input_tokens: 1000,
              cache_read_input_tokens: 0,
              output_tokens: 1,
            },
          },
        },
      },
      {
        type: "stream_event",
        event: {
          type: "message_start",
          message: {
            usage: {
              input_tokens: 50,
              cache_read_input_tokens: 1200,
              output_tokens: 1,
            },
          },
        },
      },
      {
        type: "result",
        result: "done",
        usage: {
          input_tokens: 1050,
          cache_read_input_tokens: 1200,
          output_tokens: 80,
        },
      },
    ]);
    const usage = events.filter((e) => e.type === "usage") as Extract<
      ChatEvent,
      { type: "usage" }
    >[];
    const last = usage[usage.length - 1]!;
    // The 2nd sub-call's prompt, NOT 1050/1200 summed across both.
    expect(last.last.inputTokens).toBe(50);
    expect(last.last.cachedInputTokens).toBe(1200);
  });

  it("surfaces an unrecognized line as a raw event, not a crash", async () => {
    const { events } = await run([
      { type: "system", subtype: "init", session_id: "s" },
      { type: "some_future_event", foo: "bar" },
      { type: "result", result: "" },
    ]);
    expect(events.some((e) => e.type === "raw")).toBe(true);
  });

  it("probeContext requests structured usage from the persistent process", async () => {
    const proc = new FakeProc();
    const client = {
      execStream: proc.execStream,
    };
    const backend = new ClaudeBackend(
      client as unknown as SandboxClient,
      fakeChatManager(() => {}),
    );
    const pending = backend.probeContext({
      vmId: "vm",
      chatId: "chat",
      model: "claude-sonnet-4-5",
      effort: "high",
      sessionId: "s",
    });
    await tick();
    const control = proc.controls("get_context_usage")[0];
    expect(control).toBeDefined();
    proc.succeedControl(control, {
      totalTokens: 19_800,
      maxTokens: 167_000,
      rawMaxTokens: 200_000,
      percentage: 10,
      categories: [
        { name: "System prompt", tokens: 2_500, color: "blue" },
        { name: "Messages", tokens: 17_300, color: "green" },
      ],
    });
    const bd = await pending;
    expect(bd.available).toBe(true);
    if (bd.available) {
      expect(bd.totalTokens).toBe(19_800);
      expect(bd.contextWindow).toBe(200_000);
      expect(bd.percent).toBe(10);
      expect(bd.categories).toEqual([
        { name: "System prompt", tokens: 2_500, percent: 1.3 },
        { name: "Messages", tokens: 17_300, percent: 8.6 },
      ]);
    }
    expect(proc.command).toContain("--input-format stream-json");
    expect(proc.command).toContain("--resume s");
    expect(proc.command).not.toContain("/context");
    // A custom title stops the CLI from spending a Haiku call on a session
    // title isolade never reads.
    expect(proc.command).toContain("--name -");
    backend.disposeChat("chat");
    proc.exit(0);
    await tick();
  });

  it("passes the system prompt through a shell var and blanks CLI attribution", async () => {
    const proc = new FakeProc();
    const backend = new ClaudeBackend(
      { execStream: proc.execStream } as unknown as SandboxClient,
      fakeChatManager(() => {}),
    );
    // A prelude can be long and is user-authored, so it travels base64-encoded
    // in a shell variable rather than inline: the whole command is one string
    // sent to the VM, and an inline value would risk ARG_MAX and quoting.
    const systemPrompt = {
      text: "You are a coding agent in Isolade.\n\n# Project instructions\n'quoted'",
      mode: "replace" as const,
    };
    const pending = backend.probeContext({
      vmId: "vm",
      chatId: "chat",
      model: "claude-sonnet-4-5",
      effort: "high",
      sessionId: "s",
      systemPrompt,
    });
    await tick();

    expect(proc.command).toContain('--system-prompt "$ISOLADE_SP"');
    const encoded = /ISOLADE_SP="\$\(printf %s '([A-Za-z0-9+/=]+)' \| base64 -d\)"/.exec(
      proc.command,
    );
    expect(encoded).not.toBeNull();
    expect(Buffer.from(encoded![1]!, "base64").toString("utf8")).toBe(systemPrompt.text);
    // Otherwise the untouched Bash tool description would keep advertising
    // `Co-Authored-By: Claude` against our Assisted-by trailer.
    expect(proc.command).toContain(
      `--settings '${JSON.stringify({ attribution: { commit: "", pr: "" } })}'`,
    );

    const control = proc.controls("get_context_usage")[0];
    proc.succeedControl(control, {
      totalTokens: 1,
      maxTokens: 2,
      rawMaxTokens: 2,
      percentage: 50,
      categories: [],
    });
    await pending;
    backend.disposeChat("chat");
    proc.exit(0);
    await tick();
  });

  it("still blanks CLI attribution for a prelude-only prompt", async () => {
    // A prelude-only profile supplies no Isolade trailer, and the CLI's own is
    // suppressed regardless, so such a profile gets no trailer unless its prelude
    // adds one. Deliberate: Isolade never wants the harness's attribution.
    const proc = new FakeProc();
    const backend = new ClaudeBackend(
      { execStream: proc.execStream } as unknown as SandboxClient,
      fakeChatManager(() => {}),
    );
    const pending = backend.probeContext({
      vmId: "vm",
      chatId: "chat",
      model: "claude-sonnet-4-5",
      effort: "high",
      sessionId: "s",
      systemPrompt: { text: "Only my rules.", mode: "replace" as const },
    });
    await tick();

    expect(proc.command).toContain('--system-prompt "$ISOLADE_SP"');
    expect(proc.command).toContain("--settings");

    const control = proc.controls("get_context_usage")[0];
    proc.succeedControl(control, {
      totalTokens: 1,
      maxTokens: 2,
      rawMaxTokens: 2,
      percentage: 50,
      categories: [],
    });
    await pending;
    backend.disposeChat("chat");
    proc.exit(0);
    await tick();
  });

  // The three base-prompt choices reduce to three distinct command shapes. Each
  // is asserted separately because the flag, not just the text, is what makes the
  // CLI keep or discard its own prompt.
  const commandFor = async (systemPrompt: { text: string; mode: "replace" | "append" }) => {
    const proc = new FakeProc();
    const backend = new ClaudeBackend(
      { execStream: proc.execStream } as unknown as SandboxClient,
      fakeChatManager(() => {}),
    );
    const pending = backend.probeContext({
      vmId: "vm",
      chatId: "chat",
      model: "claude-sonnet-4-5",
      effort: "high",
      sessionId: "s",
      systemPrompt,
    });
    await tick();
    const command = proc.command;
    proc.succeedControl(proc.controls("get_context_usage")[0], {
      totalTokens: 1,
      maxTokens: 2,
      rawMaxTokens: 2,
      percentage: 50,
      categories: [],
    });
    await pending;
    backend.disposeChat("chat");
    proc.exit(0);
    await tick();
    return command;
  };

  it('base "none" passes an empty --system-prompt, which suppresses the CLI\'s own', async () => {
    // Empty is NOT "no flag": omitting it would silently hand the chat the stock
    // prompt, which is a different option in the UI.
    const command = await commandFor({ text: "", mode: "replace" });
    expect(command).toContain('--system-prompt "$ISOLADE_SP"');
    expect(command).toContain("printf %s '' | base64 -d");
    expect(command).not.toContain("--append-system-prompt");
  });

  it('base "cli" appends instead of replacing, keeping the CLI\'s prompt', async () => {
    const command = await commandFor({ text: "Only my rules.", mode: "append" });
    expect(command).toContain('--append-system-prompt "$ISOLADE_SP"');
    // A bare --system-prompt would discard the prompt this option exists to keep.
    expect(command).not.toMatch(/(?<!-)--system-prompt/);
  });

  it('base "cli" with nothing to add passes no prompt flag at all', async () => {
    // Appending an empty string is a no-op, so the flag is simply omitted.
    const command = await commandFor({ text: "", mode: "append" });
    expect(command).not.toContain("system-prompt");
    expect(command).not.toContain("ISOLADE_SP");
    // Attribution is still suppressed, as it is on every chat.
    expect(command).toContain("--settings");
  });

  it("generateTitle runs `claude -p` in the VM and parses the result", async () => {
    let seenCommand = "";
    const client = {
      exec: async (_vmId: string, command: string) => {
        seenCommand = command;
        return {
          stdout: JSON.stringify({ result: "Fix login redirect." }),
          stderr: "",
          exitCode: 0,
        };
      },
    };
    const backend = new ClaudeBackend(
      client as unknown as SandboxClient,
      fakeChatManager(() => {}),
    );
    const title = await backend.generateTitle("vm", "why does my login redirect loop?");
    // Trailing period stripped, no surrounding quotes.
    expect(title).toBe("Fix login redirect");
    // The user text must never reach the command line verbatim (base64 + stdin).
    expect(seenCommand).not.toContain("login redirect loop");
    expect(seenCommand).toContain("claude -p");
  });

  it("generateTitle returns null on a non-zero exit (caller falls back)", async () => {
    const client = {
      exec: async () => ({ stdout: "", stderr: "auth error", exitCode: 1 }),
    };
    const backend = new ClaudeBackend(
      client as unknown as SandboxClient,
      fakeChatManager(() => {}),
    );
    expect(await backend.generateTitle("vm", "hi")).toBeNull();
  });

  it("generateTitle returns null when the exec throws", async () => {
    const client = {
      exec: async () => {
        throw new Error("vm gone");
      },
    };
    const backend = new ClaudeBackend(
      client as unknown as SandboxClient,
      fakeChatManager(() => {}),
    );
    expect(await backend.generateTitle("vm", "hi")).toBeNull();
  });

  it("generateTitle uses the pre-warmed stream-json session when one is ready", async () => {
    const commands: string[] = [];
    // A stream-json fake: for each `user` message pushed on stdin, emit a
    // `result` event, mimicking the persistent titling process. Stays open
    // until stdin closes (shutdown), like the real exec-stream.
    const client = {
      execStream: (
        _vmId: string,
        command: string,
        opts: { stdin: AsyncIterable<Buffer>; stdout: (c: Buffer) => void },
      ): Promise<{ exitCode: number }> => {
        commands.push(command);
        return new Promise((resolve) => {
          void (async () => {
            for await (const chunk of opts.stdin) {
              for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) {
                let msg: { type?: string };
                try {
                  msg = JSON.parse(line) as { type?: string };
                } catch {
                  continue;
                }
                if (msg.type === "user") {
                  opts.stdout(
                    Buffer.from(
                      JSON.stringify({
                        type: "result",
                        result: "Login redirect loop.",
                      }) + "\n",
                    ),
                  );
                }
              }
            }
            resolve({ exitCode: 0 });
          })();
        });
      },
    };
    const backend = new ClaudeBackend(
      client as unknown as SandboxClient,
      fakeChatManager(() => {}),
    );
    backend.warmTitleSession("vm");
    const title = await backend.generateTitle("vm", "why does my login redirect loop?");
    // Resolved via the warm session. Trailing period stripped by cleanTitle.
    expect(title).toBe("Login redirect loop");
    // The persistent path runs stream-json with the lean flags, not a one-shot.
    expect(commands[0]).toContain("--input-format stream-json");
    expect(commands[0]).toContain("--tools ''");
    expect(commands[0]).toContain("--name '-'");
    backend.disposeForVm("vm"); // close the warm process so the fake stream ends
  });

  it("probeContext reports unavailable without a session", async () => {
    const backend = new ClaudeBackend(
      {} as unknown as SandboxClient,
      fakeChatManager(() => {}),
    );
    const bd = await backend.probeContext({
      vmId: "vm",
      chatId: "chat",
      model: "claude-sonnet-4-5",
      effort: "high",
    });
    expect(bd.available).toBe(false);
  });

  it("throws on a non-zero CLI exit code", async () => {
    const { backend } = backendFor([{ type: "system", subtype: "init", session_id: "s" }], 1);
    await expect(
      backend.sendMessage({
        vmId: "vm",
        chatId: "chat",
        message: "hi",
        model: "claude-sonnet-4-5",
        effort: "high",
        onDelta: () => {},
        onEvent: () => {},
      }),
    ).rejects.toThrow(/exited with code 1/);
  });
});
