import { describe, expect, it } from "bun:test";
import type { ChatEvent } from "../src/chat/backend";
import { ClaudeBackend } from "../src/chat/claude-backend";
import type { ChatManager } from "../src/chats";
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

// ClaudeBackend only calls updateSessionId on the manager during a turn.
function fakeChatManager(sink: (id: string) => void): ChatManager {
  return {
    updateSessionId: (_chatId: string, sessionId?: string) => sessionId && sink(sessionId),
  } as unknown as ChatManager;
}

function backendFor(lines: object[], exitCode = 0) {
  const sessionIds: string[] = [];
  const client = new FakeSandboxClient(lines, exitCode);
  const backend = new ClaudeBackend(
    client as unknown as SandboxClient,
    fakeChatManager((id) => sessionIds.push(id)),
  );
  return { backend, sessionIds };
}

async function run(lines: object[], exitCode = 0) {
  const { backend, sessionIds } = backendFor(lines, exitCode);
  const deltas: string[] = [];
  const events: ChatEvent[] = [];
  const result = await backend.sendMessage({
    vmId: "vm",
    chatId: "chat",
    message: "hi",
    model: "claude-sonnet-4-5",
    effort: "high",
    onDelta: (t) => deltas.push(t),
    onEvent: (e) => events.push(e),
  });
  return { result, deltas, events, sessionIds };
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

  it("emits a thinking event from a thinking block", async () => {
    const { events } = await run([
      { type: "system", subtype: "init", session_id: "s" },
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
    expect(events).toContainEqual({ type: "thinking", text: "let me think" });
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
    expect(last.costUsd).toBeCloseTo(0.01);
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
    backend.disposeChat("chat");
    proc.exit(0);
    await tick();
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
