/**
 * Resilience tests for the chat SSE streaming layer. These tests
 * inject a fake backend so they run without a real VM. What we care
 * about here is the wire protocol, not the LLM behavior.
 *
 * Covered:
 *   * POST /messages emits message_id first, deltas, then done.
 *   * GET .../messages/:id/stream resumes a completed turn from the DB.
 *   * GET resume tails an in-flight turn (no events lost).
 *   * GET resume with afterSeq skips already-applied events.
 *   * DELETE .../messages/:id cancels an in-flight turn.
 *   * The fake heartbeat (`event: ping`) doesn't appear as a delta.
 *   * 404 for resume of a totally unknown messageId.
 *   * 409 when two POSTs race on the same chat.
 *   * Multi-subscriber: two simultaneous resume readers see the same
 *     events in the same order.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { CreateAppOptions } from "../src/app";
import type { ChatEvent as BackendChatEvent } from "../src/chat/backend";
import {
  type ChatResumeSnapshot,
  DEFAULT_ANTHROPIC_MODEL_ID,
  DEFAULT_OPENAI_MODEL_ID,
  TOOL_INPUT_PREVIEW_CHARS,
  TOOL_OUTPUT_PREVIEW_CHARS,
} from "../src/contracts";
import { createTestServer } from "./helpers";

// A controllable fake backend. The constructor takes a "script": a
// list of actions the backend should perform when its sendMessage is
// invoked. Each action either emits a delta, emits an event, throws,
// or waits on an external trigger.
type Action =
  | { kind: "delta"; text: string }
  | { kind: "event"; event: BackendChatEvent }
  | { kind: "meta"; meta: { sessionId?: string; anchorId?: string } }
  | { kind: "ack" }
  | { kind: "wait"; promise: Promise<void> }
  // Simulates a provider that ignores cancellation while one callback is
  // already in progress, then invokes it after the owning chat was deleted.
  | { kind: "late_delta"; promise: Promise<void>; text: string }
  | { kind: "throw"; message: string }
  | { kind: "abortable" }
  // Holds provider cleanup after cancellation so route serialization can be
  // tested without a real CLI process.
  | { kind: "abortable_cleanup"; promise: Promise<void> };

interface FakeSendOpts {
  vmId: string;
  chatId: string;
  message: string;
  model: string;
  effort: string;
  sessionId?: string;
  fork?: { anchorId: string };
  signal?: AbortSignal;
  onDelta: (text: string) => void;
  onEvent?: (event: BackendChatEvent) => void;
  onMeta?: (meta: { sessionId?: string; anchorId?: string }) => void;
  onUserMessageAcknowledged?: (receipt?: { sessionId?: string; priorAnchorId?: string }) => void;
}

class FakeBackend {
  // One-shot script, pushed onto when a test starts the turn.
  private script: Action[] = [];
  public lastSignal: AbortSignal | null = null;
  public lastOpts: FakeSendOpts | null = null;
  public lastCompletion: Promise<void> = Promise.resolve();
  public callCount = 0;
  public lastSteer: {
    message: string;
    userMessageId: string;
    priority: "next" | "now";
  } | null = null;
  public lastCancelSteer: {
    vmId: string;
    chatId: string;
    userMessageId: string;
  } | null = null;
  public cancelSteerResult = true;

  setScript(actions: Action[]) {
    this.script = actions;
  }

  sendMessage = (opts: FakeSendOpts): Promise<{ content: string; sessionId?: string }> => {
    const result = this.runScript(opts);
    this.lastCompletion = result.then(
      () => {},
      () => {},
    );
    return result;
  };

  private async runScript(opts: FakeSendOpts): Promise<{ content: string; sessionId?: string }> {
    this.callCount++;
    this.lastSignal = opts.signal ?? null;
    this.lastOpts = opts;
    let content = "";
    for (const action of this.script) {
      if (opts.signal?.aborted) throw new Error("aborted");
      if (action.kind === "delta") {
        content += action.text;
        opts.onDelta(action.text);
      } else if (action.kind === "event") {
        opts.onEvent?.(action.event);
      } else if (action.kind === "meta") {
        opts.onMeta?.(action.meta);
      } else if (action.kind === "ack") {
        opts.onUserMessageAcknowledged?.();
      } else if (action.kind === "wait") {
        await action.promise;
      } else if (action.kind === "late_delta") {
        await action.promise;
        content += action.text;
        opts.onDelta(action.text);
      } else if (action.kind === "throw") {
        throw new Error(action.message);
      } else if (action.kind === "abortable") {
        await new Promise<void>((_, reject) => {
          opts.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
      } else if (action.kind === "abortable_cleanup") {
        await new Promise<void>((resolve) => {
          opts.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        await action.promise;
        throw new Error("aborted");
      }
    }
    return { content };
  }

  probeContext = async (): Promise<{ available: false; reason: string }> => {
    return { available: false, reason: "fake" };
  };

  steer = async (opts: {
    message: string;
    userMessageId: string;
    priority: "next" | "now";
    onUserMessageAcknowledged?: (receipt?: { sessionId?: string; priorAnchorId?: string }) => void;
  }): Promise<void> => {
    this.lastSteer = opts;
    opts.onUserMessageAcknowledged?.({
      sessionId: "steering-session",
      priorAnchorId: "before-steering",
    });
  };

  cancelSteer = async (opts: {
    vmId: string;
    chatId: string;
    userMessageId: string;
  }): Promise<boolean> => {
    this.lastCancelSteer = opts;
    return this.cancelSteerResult;
  };

  // What the titling call returns. Null by default (what a host with no
  // credentials produces), which leaves the chat on its provisional title.
  public titleResult: string | null = null;
  // Held open by the titling tests so they can act while the model is still
  // "thinking". Resolves immediately otherwise.
  public titleGate: Promise<void> = Promise.resolve();
  // Resolves once a titling call is in flight.
  public titleRequested: Promise<void> = Promise.resolve();
  private markTitleRequested: () => void = () => {};

  // Arms the gate, so the next titling call blocks until `release()` is called
  // and then returns `title`. `requested` resolves when that call comes in.
  gateTitle(title: string | null): { release: () => void } {
    let release!: () => void;
    this.titleGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.titleRequested = new Promise<void>((resolve) => {
      this.markTitleRequested = resolve;
    });
    this.titleResult = title;
    return { release };
  }

  generateTitle = async (): Promise<string | null> => {
    this.markTitleRequested();
    await this.titleGate;
    return this.titleResult;
  };
}

// Parse the SSE response body of one HTTP response. Returns all
// decoded events plus the final terminal kind. Bypasses any
// connection-resilience layer, since we want raw protocol assertions here.
async function readAllSse(res: Response): Promise<{
  events: { event: string; data: string; id: string | null }[];
}> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let eventName = "";
  let dataLines: string[] = [];
  let eventId: string | null = null;
  const events: { event: string; data: string; id: string | null }[] = [];

  const dispatch = () => {
    if (dataLines.length === 0) {
      eventName = "";
      eventId = null;
      return;
    }
    events.push({ event: eventName, data: dataLines.join("\n"), id: eventId });
    eventName = "";
    dataLines = [];
    eventId = null;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      buf += dec.decode();
      if (buf.length > 0) {
        for (const raw of buf.split("\n")) {
          const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
          handleLine(line);
        }
      }
      dispatch();
      break;
    }
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n");
    buf = parts.pop()!;
    for (const raw of parts) {
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      handleLine(line);
    }
  }
  return { events };

  function handleLine(line: string) {
    if (line === "") return dispatch();
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") eventName = value;
    else if (field === "data") dataLines.push(value);
    else if (field === "id") eventId = value;
  }
}

function resumeSnapshot(events: { event: string; data: string }[]): ChatResumeSnapshot {
  const frame = events.find((event) => event.event === "snapshot");
  if (!frame) throw new Error("missing resume snapshot");
  return JSON.parse(frame.data) as ChatResumeSnapshot;
}

describe("chat streaming resilience", () => {
  let baseUrl: string;
  let seedInstance: () => string;
  let chatStreamHub: ReturnType<typeof createTestServer>["chatStreamHub"];
  let chatManager: ReturnType<typeof createTestServer>["chatManager"];
  let instances: ReturnType<typeof createTestServer>["instances"];
  let backend: FakeBackend;
  let cleanup: () => Promise<void>;

  beforeAll(() => {
    backend = new FakeBackend();
    const server = createTestServer({
      backendForTest: backend as unknown as Parameters<typeof createTestServer>[0] extends infer T
        ? T extends { backendForTest?: infer B }
          ? B
          : never
        : never,
      hubOptions: { idleCancelMs: 30_000, evictionMs: 30_000 },
    });
    baseUrl = server.baseUrl;
    seedInstance = server.seedInstance;
    chatStreamHub = server.chatStreamHub;
    chatManager = server.chatManager;
    instances = server.instances;
    cleanup = server.cleanup;
  });

  afterAll(async () => {
    await cleanup();
  });

  async function makeChat(
    model = DEFAULT_ANTHROPIC_MODEL_ID,
  ): Promise<{ instanceId: string; chatId: string }> {
    const instanceId = seedInstance();
    const res = await fetch(`${baseUrl}/api/instances/${instanceId}/chats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
    });
    const { id } = (await res.json()) as { id: string };
    return { instanceId, chatId: id };
  }

  async function waitForInFlight(chatId: string): Promise<string> {
    for (let i = 0; i < 50; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const messageId = chatStreamHub.inFlightFor(chatId);
      if (messageId) return messageId;
    }
    throw new Error(`turn for chat ${chatId} did not start`);
  }

  async function waitForLateProducer(): Promise<void> {
    await backend.lastCompletion;
    // The fake backend resolves immediately before ChatTurnService performs
    // its final persistence and the hub settles its producer promise.
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  it("POST /messages emits user_message, message_id, snapshot, then done", async () => {
    const { instanceId, chatId } = await makeChat();
    backend.setScript([
      { kind: "delta", text: "hello " },
      { kind: "delta", text: "world" },
    ]);

    const res = await fetch(`${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hi" }),
    });
    expect(res.status).toBe(200);
    const { events } = await readAllSse(res);

    // Frame #1 is the persisted user message (id + tree position), so the
    // client can reconcile its optimistic bubble.
    expect(events[0]!.event).toBe("user_message");
    const userMessage = JSON.parse(events[0]!.data) as {
      id: string;
      role: string;
      content: string;
    };
    expect(userMessage.role).toBe("user");
    expect(userMessage.content).toBe("hi");

    expect(events[1]!.event).toBe("message_id");
    const messageId = JSON.parse(events[1]!.data) as string;
    expect(messageId).toMatch(/^[0-9a-f-]{36}$/);

    expect(events[2]!.event).toBe("snapshot");
    const snapshot = JSON.parse(events[2]!.data) as {
      lastSeq: number;
      chunks: Array<{ kind: string; text?: string }>;
    };
    // The concurrently generated title may land before or after this initial
    // snapshot. Either way, both text deltas must be inside its durable cursor.
    expect(snapshot.lastSeq).toBeGreaterThanOrEqual(1);
    expect(snapshot.chunks).toEqual([{ kind: "text", text: "hello world" }]);

    expect(events[events.length - 1]!.event).toBe("done");

    // Persisted assistant message.
    const msgs = chatManager.getMessages(chatId);
    expect(msgs.length).toBe(2);
    expect(msgs[0]).toMatchObject({
      role: "user",
      deliveryStatus: "confirmed",
    });
    expect(events.some((event) => event.event === "user_message_confirmed")).toBe(true);
    expect(msgs[1]!.role).toBe("assistant");
    expect(msgs[1]!.content).toBe("hello world");
    expect(msgs[1]!.id).toBe(messageId);
  });

  // The titles published on a turn, oldest first, read back off its durable
  // event stream (where every publish lands, whoever was subscribed at the
  // time).
  function titlesFor(messageId: string): string[] {
    return chatManager
      .getEventsForMessage(messageId, -2)
      .filter((event) => event.type === "title")
      .map((event) => JSON.parse(event.payload) as string);
  }

  function messageIdOf(events: { event: string; data: string }[]): string {
    const frame = events.find((event) => event.event === "message_id");
    if (!frame) throw new Error("missing message_id frame");
    return JSON.parse(frame.data) as string;
  }

  it("titles a chat from its first message, then swaps in the generated title", async () => {
    const { instanceId, chatId } = await makeChat();
    backend.setScript([{ kind: "delta", text: "on it" }]);
    const { release } = backend.gateTitle("Fix login redirect");

    const res = await fetch(`${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "  why does my   login\nredirect loop?  " }),
    });
    // Titled before the model is even asked, so the chat has a sidebar entry
    // from the first frame of the turn rather than a round-trip later.
    await backend.titleRequested;
    expect(instances.get(instanceId)?.title).toBe("why does my login redirect loop?");
    release();

    const { events } = await readAllSse(res);
    expect(titlesFor(messageIdOf(events))).toEqual([
      "why does my login redirect loop?",
      "Fix login redirect",
    ]);
    expect(instances.get(instanceId)?.title).toBe("Fix login redirect");
    backend.titleResult = null;
  });

  it("leaves the provisional title in place when titling fails", async () => {
    const { instanceId, chatId } = await makeChat();
    backend.setScript([{ kind: "delta", text: "on it" }]);

    const res = await fetch(`${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "why does my login redirect loop?" }),
    });
    const { events } = await readAllSse(res);

    expect(titlesFor(messageIdOf(events))).toEqual(["why does my login redirect loop?"]);
    expect(instances.get(instanceId)?.title).toBe("why does my login redirect loop?");
  });

  it("keeps a rename made while the title is still being generated", async () => {
    const { instanceId, chatId } = await makeChat();
    backend.setScript([{ kind: "delta", text: "on it" }]);
    const { release } = backend.gateTitle("Fix login redirect");

    const res = await fetch(`${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "why does my login redirect loop?" }),
    });
    await backend.titleRequested;
    await fetch(`${baseUrl}/api/instances/${instanceId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Login bug" }),
    });
    release();

    const { events } = await readAllSse(res);
    // The user named it, so the generated title is dropped rather than
    // published over their name.
    expect(titlesFor(messageIdOf(events))).toEqual(["why does my login redirect loop?"]);
    expect(instances.get(instanceId)?.title).toBe("Login bug");
    backend.titleResult = null;
  });

  it("warns after an acknowledgement timeout and clears on a late acknowledgement", async () => {
    const delayedBackend = new FakeBackend();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    delayedBackend.setScript([
      { kind: "wait", promise: blocked },
      { kind: "ack" },
      { kind: "delta", text: "received" },
    ]);
    const timeoutServer = createTestServer({
      backendForTest: delayedBackend as unknown as NonNullable<CreateAppOptions["backendForTest"]>,
      deliveryConfirmationTimeoutMs: 10,
      hubOptions: { idleCancelMs: 30_000, evictionMs: 30_000 },
    });

    try {
      const instanceId = timeoutServer.seedInstance();
      const chatResponse = await fetch(
        `${timeoutServer.baseUrl}/api/instances/${instanceId}/chats`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: DEFAULT_ANTHROPIC_MODEL_ID }),
        },
      );
      const { id: chatId } = (await chatResponse.json()) as { id: string };
      const response = await fetch(
        `${timeoutServer.baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "did this arrive?" }),
        },
      );

      let deliveryStatus: string | null | undefined;
      for (let i = 0; i < 50; i++) {
        deliveryStatus = timeoutServer.chatManager.getMessages(chatId)[0]?.deliveryStatus;
        if (deliveryStatus === "unknown") break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(deliveryStatus).toBe("unknown");

      release();
      const { events } = await readAllSse(response);
      expect(
        events.some(
          (event) =>
            event.event === "user_message_delivery" && event.data.includes('"status":"unknown"'),
        ),
      ).toBe(true);
      expect(events.some((event) => event.event === "user_message_confirmed")).toBe(true);
      expect(timeoutServer.chatManager.getMessages(chatId)[0]?.deliveryStatus).toBe("confirmed");
    } finally {
      await timeoutServer.cleanup();
    }
  });

  it("finalizes only the durable prefix when an event-log write fails", async () => {
    const { instanceId, chatId } = await makeChat();
    backend.setScript([
      { kind: "delta", text: "durable prefix" },
      { kind: "delta", text: " lost suffix" },
    ]);
    const appendEvent = chatManager.appendEvent.bind(chatManager);
    chatManager.appendEvent = (...args: Parameters<typeof appendEvent>) => {
      const [, , , type, payload] = args;
      if (type === "delta" && payload === " lost suffix") throw new Error("disk full");
      return appendEvent(...args);
    };

    try {
      const response = await fetch(
        `${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "persist safely" }),
        },
      );
      const { events } = await readAllSse(response);
      const snapshot = resumeSnapshot(events);
      expect(snapshot.chunks).toEqual([{ kind: "text", text: "durable prefix" }]);
      expect(events.at(-1)?.event).toBe("error");
      expect(events.some((event) => event.data.includes("lost suffix"))).toBe(false);

      const transcript = (await (
        await fetch(`${baseUrl}/api/instances/${instanceId}/chats/${chatId}/transcript`)
      ).json()) as {
        messages: { content: string; role: string }[];
        inFlight: unknown;
      };
      expect(transcript.inFlight).toBeNull();
      expect(transcript.messages.map((message) => [message.role, message.content])).toEqual([
        ["user", "persist safely"],
        ["assistant", "durable prefix"],
      ]);
      expect(chatStreamHub.inFlightFor(chatId)).toBeNull();
    } finally {
      chatManager.appendEvent = appendEvent;
    }
  });

  it("projects the initial POST stream for debug visibility and bounded tool payloads", async () => {
    const oversizedInput = {
      command: "x".repeat(TOOL_INPUT_PREVIEW_CHARS * 4),
    };
    const oversizedOutput = "y".repeat(TOOL_OUTPUT_PREVIEW_CHARS * 4);
    const script: Action[] = [
      { kind: "event", event: { type: "thinking", text: "private reasoning" } },
      {
        kind: "event",
        event: { type: "raw", source: "claude", payload: { private: true } },
      },
      {
        kind: "event",
        event: { type: "tool_call_start", id: "tool-large", name: "Bash" },
      },
      {
        kind: "event",
        event: {
          type: "tool_call_input",
          id: "tool-large",
          input: oversizedInput,
        },
      },
      {
        kind: "event",
        event: {
          type: "tool_call_result",
          id: "tool-large",
          output: oversizedOutput,
        },
      },
      { kind: "delta", text: "finished" },
    ];

    const run = async (debug: boolean) => {
      const { instanceId, chatId } = await makeChat();
      backend.setScript(script);
      const response = await fetch(
        `${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages${debug ? "?debug=1" : ""}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "inspect" }),
        },
      );
      expect(response.status).toBe(200);
      return (await readAllSse(response)).events;
    };

    const snapshotChunks = (events: Awaited<ReturnType<typeof run>>) =>
      (
        JSON.parse(events.find((event) => event.event === "snapshot")!.data) as {
          chunks: Array<{
            kind: string;
            summary?: string;
            input?: unknown;
            output?: string;
            detailsAvailable?: boolean;
          }>;
        }
      ).chunks;

    const visibleChunks = snapshotChunks(await run(false));
    expect(visibleChunks.some((chunk) => chunk.kind === "thinking")).toBe(false);
    expect(visibleChunks.some((chunk) => chunk.kind === "raw")).toBe(false);
    const visibleTool = visibleChunks.find((chunk) => chunk.kind === "tool")!;
    expect(visibleTool.summary).toStartWith("x");
    expect(typeof visibleTool.input).toBe("string");
    expect((visibleTool.input as string).length).toBeLessThanOrEqual(TOOL_INPUT_PREVIEW_CHARS + 1);
    expect(visibleTool.output!.length).toBeLessThanOrEqual(TOOL_OUTPUT_PREVIEW_CHARS + 1);
    expect(visibleTool.detailsAvailable).toBe(true);

    const debugChunks = snapshotChunks(await run(true));
    expect(debugChunks.some((chunk) => chunk.kind === "thinking")).toBe(true);
    expect(debugChunks.some((chunk) => chunk.kind === "raw")).toBe(true);
    const debugTool = debugChunks.find((chunk) => chunk.kind === "tool")!;
    expect((debugTool.input as string).length).toBeLessThanOrEqual(TOOL_INPUT_PREVIEW_CHARS + 1);
    expect(debugTool.output!.length).toBeLessThanOrEqual(TOOL_OUTPUT_PREVIEW_CHARS + 1);
    expect(debugTool.detailsAvailable).toBe(true);
  });

  // A codex shell call as it arrives live: the command wrapped in a login
  // shell, with codex's own parse of the script alongside it. The row a reader
  // watches comes from this frame, so the wrapper has to be gone by here and
  // not only on a later re-read from the projection.
  it("streams a codex shell call summarized without its login shell", async () => {
    const { instanceId, chatId } = await makeChat();
    const input = {
      type: "commandExecution",
      id: "call_rG62uAvw52cEbvA6Ops8UOKk",
      command: "/bin/bash -lc 'sleep 2'",
      cwd: "/workspace",
      status: "inProgress",
      commandActions: [{ type: "unknown", command: "sleep 2" }],
    };
    backend.setScript([
      { kind: "event", event: { type: "tool_call_start", id: "shell-tool", name: "Shell" } },
      { kind: "event", event: { type: "tool_call_input", id: "shell-tool", input } },
      { kind: "delta", text: "done" },
    ]);

    const response = await fetch(
      `${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Run sleep 2" }),
      },
    );
    const { events } = await readAllSse(response);
    const snapshot = JSON.parse(events.find((event) => event.event === "snapshot")!.data) as {
      chunks: Array<{ kind: string; summary?: string; input?: unknown }>;
    };
    const tool = snapshot.chunks.find((chunk) => chunk.kind === "tool")!;
    expect(tool.summary).toBe("sleep 2");
    // The expanded row still shows what actually ran, wrapper and all.
    expect((tool.input as { command?: string }).command).toBe("/bin/bash -lc 'sleep 2'");
  });

  it("publishes usage before done when the backend does not await onEvent", async () => {
    const { instanceId, chatId } = await makeChat();
    const usage = {
      inputTokens: 11,
      cachedInputTokens: 3,
      cacheCreationInputTokens: 2,
      outputTokens: 5,
      reasoningOutputTokens: 1,
      totalTokens: 22,
    };
    backend.setScript([
      {
        kind: "event",
        event: { type: "usage", last: usage, total: usage },
      },
      { kind: "delta", text: "answer" },
    ]);

    const response = await fetch(
      `${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "measure" }),
      },
    );
    const { events } = await readAllSse(response);
    const snapshotIndex = events.findIndex((event) => event.event === "snapshot");
    const doneIndex = events.findIndex((event) => event.event === "done");
    expect(snapshotIndex).toBeGreaterThan(-1);
    expect(doneIndex).toBeGreaterThan(snapshotIndex);
    const snapshot = JSON.parse(events[snapshotIndex]!.data) as {
      metaEvents: Array<{ type: string; payload: unknown }>;
    };
    expect(snapshot.metaEvents.find((event) => event.type === "usage")?.payload).toMatchObject({
      total: usage,
      last: usage,
    });
    expect(chatManager.get(chatId)).toMatchObject({
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      outputTokens: usage.outputTokens,
    });
  });

  it("GET /messages/:id/stream replays a completed turn from the DB", async () => {
    const { instanceId, chatId } = await makeChat();
    backend.setScript([
      { kind: "delta", text: "one" },
      { kind: "delta", text: "two" },
    ]);
    const postRes = await fetch(`${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hi" }),
    });
    const { events: postEvents } = await readAllSse(postRes);
    const messageId = JSON.parse(postEvents.find((e) => e.event === "message_id")!.data) as string;

    // Now resume from the start.
    const getRes = await fetch(
      `${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages/${messageId}/stream?afterSeq=-1`,
    );
    expect(getRes.status).toBe(200);
    const { events: getEvents } = await readAllSse(getRes);
    expect(getEvents[0]!.event).toBe("message_id");
    expect(JSON.parse(getEvents[0]!.data)).toBe(messageId);
    const snapshot = resumeSnapshot(getEvents);
    expect(snapshot.status).toBe("done");
    expect(snapshot.message?.content).toBe("onetwo");
    expect(snapshot.chunks).toEqual([{ kind: "text", text: "onetwo" }]);
    expect(getEvents.filter((event) => event.event === "delta")).toHaveLength(0);
    expect(getEvents[getEvents.length - 1]!.event).toBe("done");
  });

  it("folds structural turn events into one completed render row", async () => {
    const { instanceId, chatId } = await makeChat();
    backend.setScript([
      {
        kind: "event",
        event: { type: "tool_call_start", id: "tool-1", name: "Read" },
      },
      {
        kind: "event",
        event: { type: "tool_call_result", id: "tool-1", output: "ok" },
      },
      { kind: "delta", text: "finished" },
    ]);

    const response = await fetch(
      `${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "run it" }),
      },
    );
    const { events } = await readAllSse(response);
    const messageId = JSON.parse(events.find((event) => event.event === "message_id")!.data);
    const rows = chatManager.getMessageRenders(chatId, [messageId]);

    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.chunks).map((chunk: { kind: string }) => chunk.kind)).toEqual([
      "tool",
      "text",
    ]);
    expect(JSON.parse(rows[0]!.debugChunks).map((chunk: { kind: string }) => chunk.kind)).toEqual([
      "tool",
      "text",
    ]);
  });

  it("persists structural output when a turn fails before producing text", async () => {
    const { instanceId, chatId } = await makeChat();
    backend.setScript([
      {
        kind: "event",
        event: { type: "tool_call_start", id: "tool-1", name: "Read" },
      },
      {
        kind: "event",
        event: {
          type: "tool_call_result",
          id: "tool-1",
          output: "partial result",
        },
      },
      { kind: "throw", message: "provider failed" },
    ]);

    const response = await fetch(
      `${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "run it" }),
      },
    );
    const { events } = await readAllSse(response);
    const messageId = JSON.parse(events.find((event) => event.event === "message_id")!.data);

    expect(events.at(-1)?.event).toBe("error");
    expect(chatManager.getMessage(messageId)?.content).toBe("");
    const rows = chatManager.getMessageRenders(chatId, [messageId]);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.chunks)).toEqual([
      {
        kind: "tool",
        id: "tool-1",
        name: "Read",
        output: "partial result",
        status: "done",
      },
    ]);
  });

  it("GET resume replaces raw replay with one bounded current snapshot", async () => {
    const { instanceId, chatId } = await makeChat();
    backend.setScript([
      { kind: "delta", text: "a" },
      { kind: "delta", text: "b" },
      { kind: "delta", text: "c" },
    ]);
    const postRes = await fetch(`${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hi" }),
    });
    const { events: postEvents } = await readAllSse(postRes);
    const messageId = JSON.parse(postEvents.find((e) => e.event === "message_id")!.data) as string;

    // The snapshot supersedes the old cursor-based raw replay protocol.
    const getRes = await fetch(
      `${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages/${messageId}/stream?afterSeq=0`,
    );
    const { events } = await readAllSse(getRes);
    const snapshot = resumeSnapshot(events);
    expect(snapshot.lastSeq).toBeGreaterThanOrEqual(2);
    expect(snapshot.message?.content).toBe("abc");
    expect(snapshot.chunks).toEqual([{ kind: "text", text: "abc" }]);
    expect(events.filter((event) => event.event === "delta")).toHaveLength(0);
  });

  it("GET resume tails an in-flight turn without re-running the backend", async () => {
    const { instanceId, chatId } = await makeChat();
    let resolveBackend: () => void = () => {};
    const backendHold = new Promise<void>((r) => {
      resolveBackend = r;
    });
    backend.setScript([
      { kind: "delta", text: "first" },
      { kind: "wait", promise: backendHold },
      { kind: "delta", text: "second" },
    ]);
    const beforeCount = backend.callCount;

    // Start POST but don't await, since we want to subscribe via GET while
    // the producer is mid-script.
    const postPromise = fetch(`${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hi" }),
    });

    // Wait for the hub to register the turn so we can read its
    // messageId. Polling is ugly but the hub doesn't expose a "wait
    // for first turn" hook, and we don't want to read the POST body
    // (that'd consume it).
    let messageId: string | null = null;
    for (let i = 0; i < 50 && messageId === null; i++) {
      await new Promise((r) => setTimeout(r, 20));
      messageId = chatStreamHub.inFlightFor(chatId);
    }
    expect(messageId).not.toBeNull();

    // Resume from afterSeq=-1 while in flight.
    const getRes = await fetch(
      `${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages/${messageId}/stream?afterSeq=-1`,
    );
    // Release the backend now so the second delta flows.
    resolveBackend();

    const { events } = await readAllSse(getRes);
    const snapshot = resumeSnapshot(events);
    const deltas = events.filter((e) => e.event === "delta").map((e) => JSON.parse(e.data));
    expect(snapshot.chunks).toEqual([{ kind: "text", text: "first" }]);
    expect(deltas).toEqual(["second"]);
    expect(events[events.length - 1]!.event).toBe("done");

    // The backend was invoked exactly once even though there were two
    // subscribers (POST + GET).
    expect(backend.callCount).toBe(beforeCount + 1);

    // Drain the POST body so the fetch doesn't dangle.
    await readAllSse(await postPromise);
  });

  it("GET transcript returns the compact active turn and then its committed message", async () => {
    const { instanceId, chatId } = await makeChat();
    let releaseBackend: () => void = () => {};
    const backendHold = new Promise<void>((resolve) => {
      releaseBackend = resolve;
    });
    backend.setScript([
      { kind: "delta", text: "first" },
      { kind: "wait", promise: backendHold },
      { kind: "delta", text: " second" },
    ]);

    const postPromise = fetch(`${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "question" }),
    });
    const messageId = await waitForInFlight(chatId);

    const activeResponse = await fetch(
      `${baseUrl}/api/instances/${instanceId}/chats/${chatId}/transcript`,
    );
    expect(activeResponse.status).toBe(200);
    const active = (await activeResponse.json()) as {
      messages: { id: string; role: string; content: string }[];
      inFlight: {
        messageId: string;
        lastSeq: number;
        chunks: unknown[];
      } | null;
    };
    expect(active.messages.map((message) => [message.role, message.content])).toEqual([
      ["user", "question"],
    ]);
    expect(active.inFlight).toMatchObject({
      messageId,
      chunks: [{ kind: "text", text: "first" }],
    });
    expect(active.inFlight!.lastSeq).toBeGreaterThanOrEqual(0);

    releaseBackend();
    const { events } = await readAllSse(await postPromise);
    expect(events.at(-1)?.event).toBe("done");

    const completed = (await (
      await fetch(`${baseUrl}/api/instances/${instanceId}/chats/${chatId}/transcript`)
    ).json()) as {
      messages: { id: string; role: string; content: string }[];
      inFlight: unknown;
    };
    expect(completed.inFlight).toBeNull();
    expect(completed.messages.map((message) => [message.role, message.content])).toEqual([
      ["user", "question"],
      ["assistant", "first second"],
    ]);
    expect(completed.messages.at(-1)?.id).toBe(messageId);
  });

  it("DELETE /messages/:id cancels an in-flight turn", async () => {
    const { instanceId, chatId } = await makeChat();
    backend.setScript([{ kind: "delta", text: "before-cancel" }, { kind: "abortable" }]);

    const postPromise = fetch(`${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hi" }),
    });
    // Wait for the turn to land in the hub.
    let messageId: string | null = null;
    for (let i = 0; i < 50 && messageId === null; i++) {
      await new Promise((r) => setTimeout(r, 20));
      messageId = chatStreamHub.inFlightFor(chatId);
    }
    expect(messageId).not.toBeNull();
    if (!messageId) throw new Error("turn did not become active");

    const delRes = await fetch(
      `${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages/${messageId}`,
      { method: "DELETE" },
    );
    expect(delRes.status).toBe(200);

    const { events } = await readAllSse(await postPromise);
    // The initial snapshot contains the partial output, then error terminates.
    const snapshot = JSON.parse(events.find((event) => event.event === "snapshot")!.data) as {
      chunks: Array<{ kind: string; text?: string }>;
    };
    expect(snapshot.chunks).toEqual([{ kind: "text", text: "before-cancel" }]);
    expect(events.find((event) => event.event === "turn_interrupted")?.data).toBe(
      JSON.stringify({ id: messageId }),
    );
    expect(events[events.length - 1]!.event).toBe("error");
    expect(events[events.length - 1]!.data).toMatch(/aborted/i);

    // Partial assistant message persisted.
    const msgs = chatManager.getMessages(chatId);
    const assistant = msgs.find((m) => m.role === "assistant");
    expect(assistant?.content).toBe("before-cancel");
    expect(
      chatManager.getMessageRenderChunks(chatId, [assistant!.id], false, false)[assistant!.id],
    ).toContainEqual({
      kind: "interruption",
      id: messageId,
    });
  });

  it("deleting an in-flight chat discards callbacks that arrive after deletion", async () => {
    const { instanceId, chatId } = await makeChat();
    let releaseLateCallback: () => void = () => {};
    const lateCallback = new Promise<void>((resolve) => {
      releaseLateCallback = resolve;
    });
    backend.setScript([
      { kind: "delta", text: "before-delete" },
      { kind: "late_delta", promise: lateCallback, text: "-too-late" },
    ]);

    const postResponse = await fetch(
      `${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "delete this chat" }),
      },
    );
    const messageId = await waitForInFlight(chatId);

    const deleteResponse = await fetch(`${baseUrl}/api/instances/${instanceId}/chats/${chatId}`, {
      method: "DELETE",
    });
    expect(deleteResponse.status).toBe(200);
    releaseLateCallback();
    await readAllSse(postResponse);
    await waitForLateProducer();
    expect(chatManager.get(chatId)).toBeUndefined();
    expect(chatManager.getMessages(chatId)).toEqual([]);
    expect(chatManager.getEvents(chatId)).toEqual([]);
    expect(chatManager.getEventsForMessage(messageId, -2)).toEqual([]);
    expect(chatManager.getMessageRenders(chatId, [messageId])).toEqual([]);
  });

  it("deleting an instance discards late callbacks from all of its in-flight chats", async () => {
    const { instanceId, chatId } = await makeChat();
    let releaseLateCallback: () => void = () => {};
    const lateCallback = new Promise<void>((resolve) => {
      releaseLateCallback = resolve;
    });
    backend.setScript([
      { kind: "delta", text: "before-instance-delete" },
      { kind: "late_delta", promise: lateCallback, text: "-too-late" },
    ]);

    const postResponse = await fetch(
      `${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "delete this instance" }),
      },
    );
    const messageId = await waitForInFlight(chatId);

    const deleteResponse = await fetch(`${baseUrl}/api/instances/${instanceId}`, {
      method: "DELETE",
    });
    expect(deleteResponse.status).toBe(200);
    releaseLateCallback();
    await readAllSse(postResponse);
    await waitForLateProducer();
    expect((await fetch(`${baseUrl}/api/instances/${instanceId}`)).status).toBe(404);
    expect(chatManager.get(chatId)).toBeUndefined();
    expect(chatManager.getMessages(chatId)).toEqual([]);
    expect(chatManager.getEvents(chatId)).toEqual([]);
    expect(chatManager.getEventsForMessage(messageId, -2)).toEqual([]);
    expect(chatManager.getMessageRenders(chatId, [messageId])).toEqual([]);
  });

  it("returns 404 when resuming a totally unknown messageId", async () => {
    const { instanceId, chatId } = await makeChat();
    const res = await fetch(
      `${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages/00000000-0000-0000-0000-000000000000/stream?afterSeq=-1`,
    );
    expect(res.status).toBe(404);
  });

  it("does not resume or cancel an in-memory turn through another chat", async () => {
    const owner = await makeChat();
    const other = await makeChat();
    const messageId = crypto.randomUUID();
    chatStreamHub.startTurn({
      chatId: owner.chatId,
      messageId,
      run: async (api) =>
        new Promise<void>((_, reject) => {
          api.signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    });

    const resume = await fetch(
      `${baseUrl}/api/instances/${other.instanceId}/chats/${other.chatId}/messages/${messageId}/stream`,
    );
    expect(resume.status).toBe(404);
    const cancel = await fetch(
      `${baseUrl}/api/instances/${other.instanceId}/chats/${other.chatId}/messages/${messageId}`,
      { method: "DELETE" },
    );
    expect(cancel.status).toBe(404);
    expect(chatStreamHub.hasForChat(owner.chatId, messageId)).toBe(true);
    chatStreamHub.cancel(messageId);
    await chatStreamHub.drain();
  });

  it("returns 409 when a second POST races an in-flight turn", async () => {
    const { instanceId, chatId } = await makeChat();
    let resolveBackend: () => void = () => {};
    const backendHold = new Promise<void>((r) => {
      resolveBackend = r;
    });
    backend.setScript([
      { kind: "delta", text: "x" },
      { kind: "wait", promise: backendHold },
    ]);
    const post1 = fetch(`${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "first" }),
    });
    // Wait for the turn to land in the hub.
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 20));
      if (chatStreamHub.inFlightFor(chatId)) break;
    }
    const post2Res = await fetch(
      `${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "second" }),
      },
    );
    expect(post2Res.status).toBe(409);
    resolveBackend();
    await readAllSse(await post1);
  });

  it("reuses the provider turn when a stable user id is posted again", async () => {
    const { instanceId, chatId } = await makeChat();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const before = backend.callCount;
    backend.setScript([
      { kind: "wait", promise: blocked },
      { kind: "delta", text: "once" },
    ]);
    const url = `${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages`;
    const body = JSON.stringify({ id: "stable-user", content: "only once" });
    const first = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    await waitForInFlight(chatId);
    const duplicate = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(duplicate.status).toBe(200);
    release();
    const [firstStream, duplicateStream] = await Promise.all([
      readAllSse(first),
      readAllSse(duplicate),
    ]);
    expect(firstStream.events.some((event) => event.event === "done")).toBe(true);
    expect(duplicateStream.events.some((event) => event.event === "done")).toBe(true);
    expect(backend.callCount).toBe(before + 1);

    const afterCompletion = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(afterCompletion.status).toBe(200);
    expect((await readAllSse(afterCompletion)).events.some((event) => event.event === "done")).toBe(
      true,
    );
    expect(backend.callCount).toBe(before + 1);
  });

  it("durably queues a normal send and starts it after the active turn settles", async () => {
    const { instanceId, chatId } = await makeChat();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const before = backend.callCount;
    backend.setScript([
      { kind: "wait", promise: blocked },
      { kind: "delta", text: "first" },
    ]);
    const activeResponse = await fetch(
      `${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "user-first", content: "first prompt" }),
      },
    );
    await waitForInFlight(chatId);

    const queuedResponse = await fetch(
      `${baseUrl}/api/instances/${instanceId}/chats/${chatId}/queue`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "user-queued", content: "queued prompt" }),
      },
    );
    expect(queuedResponse.status).toBe(201);
    expect((await queuedResponse.json()).status).toBe("queued");

    backend.setScript([{ kind: "ack" }, { kind: "delta", text: "second" }]);
    release();
    await readAllSse(activeResponse);
    for (let i = 0; i < 50 && backend.callCount < before + 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await chatStreamHub.drain();

    const transcript = await fetch(
      `${baseUrl}/api/instances/${instanceId}/chats/${chatId}/transcript`,
    ).then((response) => response.json());
    expect(transcript.queuedMessages).toEqual([]);
    expect(
      transcript.messages.map((message: { role: string; content: string }) => [
        message.role,
        message.content,
      ]),
    ).toEqual([
      ["user", "first prompt"],
      ["assistant", "first"],
      ["user", "queued prompt"],
      ["assistant", "second"],
    ]);
    expect(
      transcript.messages.find((message: { id: string }) => message.id === "user-queued")
        ?.deliveryStatus,
    ).toBe("confirmed");
  });

  it("shows a Codex steering message at its position in the active turn", async () => {
    const { instanceId, chatId } = await makeChat(DEFAULT_OPENAI_MODEL_ID);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    backend.setScript([
      {
        kind: "event",
        event: { type: "tool_call_start", id: "tool-1", name: "Read" },
      },
      {
        kind: "event",
        event: { type: "tool_call_result", id: "tool-1", output: "done" },
      },
      { kind: "wait", promise: blocked },
      { kind: "delta", text: "continued" },
    ]);
    const activeResponse = await fetch(
      `${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "first prompt" }),
      },
    );
    await waitForInFlight(chatId);
    await fetch(`${baseUrl}/api/instances/${instanceId}/chats/${chatId}/queue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "steer-me", content: "change direction" }),
    });

    const steerResponse = await fetch(
      `${baseUrl}/api/instances/${instanceId}/chats/${chatId}/queue/steer-me/dispatch`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "next" }),
      },
    );
    expect(steerResponse.status).toBe(200);
    expect((await steerResponse.json()).status).toBe("delivered");
    expect(backend.lastSteer).toMatchObject({
      message: "change direction",
      userMessageId: "steer-me",
      priority: "next",
    });

    release();
    const { events } = await readAllSse(activeResponse);
    const steeredEvent = events.findIndex((event) => event.event === "steered_user_message");
    const continuedDelta = events.findIndex(
      (event) => event.event === "delta" && event.data.includes("continued"),
    );
    expect(steeredEvent).toBeGreaterThan(-1);
    expect(continuedDelta).toBeGreaterThan(steeredEvent);

    const transcript = await fetch(
      `${baseUrl}/api/instances/${instanceId}/chats/${chatId}/transcript`,
    ).then((response) => response.json());
    expect(transcript.queuedMessages).toEqual([]);
    const assistant = transcript.messages.find(
      (message: { role: string }) => message.role === "assistant",
    );
    expect(
      transcript.chunksByMessage[assistant.id].map((chunk: { kind: string }) => chunk.kind),
    ).toEqual(["tool", "user_message", "text"]);
    expect(transcript.chunksByMessage[assistant.id][1]).toMatchObject({
      id: "steer-me",
      content: "change direction",
    });
    expect(transcript.chunksByMessage[assistant.id][1].capabilities).toBeUndefined();
  });

  it("marks and displays a Claude immediate interruption inside the active turn", async () => {
    const { instanceId, chatId } = await makeChat();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    backend.setScript([
      { kind: "delta", text: "before" },
      { kind: "wait", promise: blocked },
      { kind: "delta", text: "after" },
    ]);
    const activeResponse = await fetch(
      `${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "first prompt" }),
      },
    );
    await waitForInFlight(chatId);
    await fetch(`${baseUrl}/api/instances/${instanceId}/chats/${chatId}/queue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "claude-now", content: "change now" }),
    });

    const immediateResponse = await fetch(
      `${baseUrl}/api/instances/${instanceId}/chats/${chatId}/queue/claude-now/dispatch`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "now" }),
      },
    );
    expect(immediateResponse.status).toBe(200);
    expect((await immediateResponse.json()).status).toBe("delivered");

    release();
    const { events } = await readAllSse(activeResponse);
    const interrupted = events.findIndex((event) => event.event === "turn_interrupted");
    const steered = events.findIndex((event) => event.event === "steered_user_message");
    const continued = events.findIndex(
      (event) => event.event === "delta" && event.data.includes("after"),
    );
    expect(interrupted).toBeGreaterThan(-1);
    expect(steered).toBeGreaterThan(interrupted);
    expect(continued).toBeGreaterThan(steered);
    expect(JSON.parse(events[steered]!.data).capabilities).toEqual({
      edit: true,
    });
    expect(chatManager.getQueuedMessage("claude-now")).toMatchObject({
      editSessionId: "steering-session",
      editAnchorId: "before-steering",
    });
  });

  it("edits an active Claude in-turn message at its acknowledgement checkpoint", async () => {
    const { instanceId, chatId } = await makeChat();
    backend.setScript([{ kind: "delta", text: "before " }, { kind: "abortable" }]);
    const activeResponse = await fetch(
      `${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "initial prompt" }),
      },
    );
    await waitForInFlight(chatId);
    await fetch(`${baseUrl}/api/instances/${instanceId}/chats/${chatId}/queue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "claude-inline",
        content: "original steering",
      }),
    });
    const dispatch = await fetch(
      `${baseUrl}/api/instances/${instanceId}/chats/${chatId}/queue/claude-inline/dispatch`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "next" }),
      },
    );
    expect(dispatch.status).toBe(200);

    backend.setScript([
      {
        kind: "meta",
        meta: { sessionId: "edited-session", anchorId: "edited-end" },
      },
      { kind: "ack" },
      { kind: "delta", text: "edited suffix" },
    ]);
    const editResponse = await fetch(
      `${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages/claude-inline/edit`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "claude-inline-edited",
          content: "edited steering",
        }),
      },
    );
    expect(editResponse.status).toBe(200);
    const [{ events: activeEvents }] = await Promise.all([
      readAllSse(activeResponse),
      readAllSse(editResponse),
    ]);
    expect(activeEvents.at(-1)?.event).toBe("error");
    await chatStreamHub.drain();

    expect(backend.lastOpts?.sessionId).toBe("steering-session");
    expect(backend.lastOpts?.fork).toEqual({ anchorId: "before-steering" });
    const transcript = await fetch(
      `${baseUrl}/api/instances/${instanceId}/chats/${chatId}/transcript`,
    ).then((response) => response.json());
    expect(transcript.messages.map((message: { role: string }) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    const assistant = transcript.messages[1];
    expect(assistant.content).toBe("before edited suffix");
    expect(transcript.chunksByMessage[assistant.id]).toEqual([
      { kind: "text", text: "before " },
      {
        kind: "user_message",
        id: "claude-inline-edited",
        content: "edited steering",
        deliveryStatus: "confirmed",
        capabilities: { edit: true },
      },
      { kind: "text", text: "edited suffix" },
    ]);

    const calls = backend.callCount;
    const retry = await fetch(
      `${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages/claude-inline/edit`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "claude-inline-edited",
          content: "edited steering",
        }),
      },
    );
    expect(retry.status).toBe(200);
    await readAllSse(retry);
    expect(backend.callCount).toBe(calls);
  });

  it("retracts a Claude next message while it is still pending", async () => {
    const { instanceId, chatId } = await makeChat();
    chatManager.enqueueMessage({
      id: "retract-me",
      chatId,
      content: "change direction",
    });
    chatManager.updateQueuedMessage("retract-me", {
      mode: "next",
      status: "steering",
    });

    const response = await fetch(
      `${baseUrl}/api/instances/${instanceId}/chats/${chatId}/queue/retract-me`,
      { method: "DELETE" },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ removed: true });
    expect(backend.lastCancelSteer).toMatchObject({
      userMessageId: "retract-me",
    });
    expect(chatManager.getQueuedMessage("retract-me")).toBeUndefined();
  });

  it("keeps a Claude next message when it was already dequeued", async () => {
    const { instanceId, chatId } = await makeChat();
    backend.cancelSteerResult = false;
    chatManager.enqueueMessage({
      id: "already-dequeued",
      chatId,
      content: "change direction",
    });
    chatManager.updateQueuedMessage("already-dequeued", {
      mode: "next",
      status: "steering",
    });

    const response = await fetch(
      `${baseUrl}/api/instances/${instanceId}/chats/${chatId}/queue/already-dequeued`,
      { method: "DELETE" },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      removed: false,
      reason: "already_delivered",
    });
    expect(chatManager.getQueuedMessage("already-dequeued")?.status).toBe("delivered");
  });

  it("keeps a steering message when its provider cannot retract it", async () => {
    const { instanceId, chatId } = await makeChat(DEFAULT_OPENAI_MODEL_ID);
    chatManager.enqueueMessage({
      id: "committed",
      chatId,
      content: "change direction",
    });
    chatManager.updateQueuedMessage("committed", {
      mode: "next",
      status: "steering",
    });

    const response = await fetch(
      `${baseUrl}/api/instances/${instanceId}/chats/${chatId}/queue/committed`,
      { method: "DELETE" },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      removed: false,
      reason: "not_retractable",
    });
    expect(chatManager.getQueuedMessage("committed")?.status).toBe("steering");
  });

  it("implements Codex send-now by interrupting and promoting the queued message", async () => {
    const { instanceId, chatId } = await makeChat(DEFAULT_OPENAI_MODEL_ID);
    const before = backend.callCount;
    backend.setScript([{ kind: "abortable" }]);
    const activeResponse = await fetch(
      `${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "old direction" }),
      },
    );
    await waitForInFlight(chatId);
    await fetch(`${baseUrl}/api/instances/${instanceId}/chats/${chatId}/queue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "send-now", content: "new direction" }),
    });
    backend.setScript([{ kind: "ack" }, { kind: "delta", text: "new answer" }]);

    const nowResponse = await fetch(
      `${baseUrl}/api/instances/${instanceId}/chats/${chatId}/queue/send-now/dispatch`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "now" }),
      },
    );
    expect(nowResponse.status).toBe(200);
    expect((await nowResponse.json()).status).toBe("interrupting");
    await readAllSse(activeResponse);
    for (let i = 0; i < 50 && backend.callCount < before + 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await chatStreamHub.drain();

    const transcript = await fetch(
      `${baseUrl}/api/instances/${instanceId}/chats/${chatId}/transcript`,
    ).then((response) => response.json());
    expect(transcript.queuedMessages).toEqual([]);
    expect(transcript.messages.at(-2)).toMatchObject({
      id: "send-now",
      role: "user",
      content: "new direction",
      deliveryStatus: "confirmed",
    });
    expect(transcript.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "new answer",
    });
    const interruptedAssistant = transcript.messages.at(-3);
    expect(interruptedAssistant.role).toBe("assistant");
    expect(transcript.chunksByMessage[interruptedAssistant.id]).toContainEqual({
      kind: "interruption",
      id: "send-now",
    });
  });

  it("context probe is gated while a turn is in flight", async () => {
    const { instanceId, chatId } = await makeChat();
    let resolveBackend: () => void = () => {};
    const backendHold = new Promise<void>((r) => {
      resolveBackend = r;
    });
    backend.setScript([{ kind: "wait", promise: backendHold }]);
    const post = fetch(`${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hi" }),
    });
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 20));
      if (chatStreamHub.inFlightFor(chatId)) break;
    }

    // During the turn: guarded, without invoking the backend probe (the fake
    // would answer with reason "fake").
    const during = await (
      await fetch(`${baseUrl}/api/instances/${instanceId}/chats/${chatId}/context`)
    ).json();
    expect(during).toEqual({
      available: false,
      reason: "context probe unavailable while a turn is running",
    });

    resolveBackend();
    await readAllSse(await post);

    // Once the turn settles, the probe runs again.
    const after = await (
      await fetch(`${baseUrl}/api/instances/${instanceId}/chats/${chatId}/context`)
    ).json();
    expect(after).toEqual({ available: false, reason: "fake" });
  });

  it("two simultaneous resume readers see the same events in order", async () => {
    const { instanceId, chatId } = await makeChat();
    let resolveBackend: () => void = () => {};
    const backendHold = new Promise<void>((r) => {
      resolveBackend = r;
    });
    backend.setScript([
      { kind: "delta", text: "alpha" },
      { kind: "wait", promise: backendHold },
      { kind: "delta", text: "beta" },
    ]);
    const post = fetch(`${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hi" }),
    });
    let messageId: string | null = null;
    for (let i = 0; i < 50 && messageId === null; i++) {
      await new Promise((r) => setTimeout(r, 20));
      messageId = chatStreamHub.inFlightFor(chatId);
    }
    const [r1, r2] = await Promise.all([
      fetch(
        `${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages/${messageId}/stream?afterSeq=-1`,
      ),
      fetch(
        `${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages/${messageId}/stream?afterSeq=-1`,
      ),
    ]);
    resolveBackend();
    const [e1, e2] = await Promise.all([readAllSse(r1), readAllSse(r2)]);
    const d1 = e1.events.filter((e) => e.event === "delta").map((e) => JSON.parse(e.data));
    const d2 = e2.events.filter((e) => e.event === "delta").map((e) => JSON.parse(e.data));
    expect(resumeSnapshot(e1.events).chunks).toEqual([{ kind: "text", text: "alpha" }]);
    expect(resumeSnapshot(e2.events).chunks).toEqual([{ kind: "text", text: "alpha" }]);
    expect(d1).toEqual(["beta"]);
    expect(d2).toEqual(["beta"]);
    await readAllSse(await post);
  });

  it("crash recovery: resume of a hub-evicted turn with persisted events backfills the chat_message row", async () => {
    // Simulate a server restart mid-turn: write chat_events directly
    // (the hub has no in-memory turn). The resume endpoint should
    // replay the events AND backfill chat_messages so future
    // hydrations don't loop trying to resume the same orphan turn.
    const { instanceId, chatId } = await makeChat();
    const orphanId = "00000000-0000-0000-0000-aaaaaaaaaaaa";
    chatManager.appendEvent(chatId, orphanId, 0, "delta", "partial-");
    chatManager.appendEvent(chatId, orphanId, 1, "delta", "content");

    // No chat_messages row for the orphan yet.
    expect(chatManager.getMessages(chatId).some((m) => m.id === orphanId)).toBe(false);

    const res = await fetch(
      `${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages/${orphanId}/stream?afterSeq=-1`,
    );
    expect(res.status).toBe(200);
    const { events } = await readAllSse(res);
    const snapshot = resumeSnapshot(events);
    expect(snapshot.message?.content).toBe("partial-content");
    expect(snapshot.status).toBe("error");
    expect(events.filter((event) => event.event === "delta")).toHaveLength(0);
    expect(events[events.length - 1]!.event).toBe("error");

    // Row was backfilled.
    const msg = chatManager.getMessages(chatId).find((m) => m.id === orphanId);
    expect(msg).toBeDefined();
    expect(msg?.content).toBe("partial-content");
  });

  it("crash recovery is idempotent: a second resume does NOT duplicate the chat_message row", async () => {
    const { instanceId, chatId } = await makeChat();
    const orphanId = "00000000-0000-0000-0000-bbbbbbbbbbbb";
    chatManager.appendEvent(chatId, orphanId, 0, "delta", "abc");

    const url = `${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages/${orphanId}/stream?afterSeq=-1`;
    await readAllSse(await fetch(url));
    await readAllSse(await fetch(url));

    const rowsForOrphan = chatManager.getMessages(chatId).filter((m) => m.id === orphanId);
    expect(rowsForOrphan.length).toBe(1);
    expect(rowsForOrphan[0]!.content).toBe("abc");
  });

  it("chat_events has a turn_started marker before the producer's first publish", async () => {
    // Mirrors the bug: a client that refreshes between startTurn and
    // the producer's first publish() must still be able to detect the
    // in-flight turn via /events. The hub writes a seq=-1 marker
    // synchronously inside startTurn so chat_events is never empty
    // for the messageId, even when the backend hasn't streamed yet.
    const { instanceId, chatId } = await makeChat();
    let resolveBackend: () => void = () => {};
    const backendHold = new Promise<void>((r) => {
      resolveBackend = r;
    });
    // Backend blocks BEFORE any delta, simulating the CLI-spawn /
    // RPC-handshake window where the producer hasn't fired yet.
    backend.setScript([
      { kind: "wait", promise: backendHold },
      { kind: "delta", text: "after" },
    ]);

    const post = fetch(`${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hi" }),
    });
    // Wait for the turn to land in the hub. The marker should already
    // be in chat_events at this point.
    let messageId: string | null = null;
    for (let i = 0; i < 50 && messageId === null; i++) {
      await new Promise((r) => setTimeout(r, 20));
      messageId = chatStreamHub.inFlightFor(chatId);
    }
    expect(messageId).not.toBeNull();

    // Simulates the client's hydration scan: GET /events should
    // return the marker even though the producer hasn't published
    // anything yet. Validate through the shared zod schema (this is
    // what the web client does in listChatEvents), so the schema must
    // accept seq=-1 or the marker is silently dropped on the client
    // and in-flight detection fails.
    const evRes = await fetch(`${baseUrl}/api/instances/${instanceId}/chats/${chatId}/events`);
    const { chatEventArraySchema } = await import("@isolade/shared");
    const events = chatEventArraySchema.parse(await evRes.json());
    const markerRows = events.filter((e) => e.messageId === messageId);
    expect(markerRows.length).toBeGreaterThanOrEqual(1);
    expect(markerRows[0]!.type).toBe("turn_started");
    expect(markerRows[0]!.seq).toBe(-1);

    // Resume the turn from afterSeq=-1: the marker is filtered out
    // (seq > -1) so the client doesn't see it, and the producer's
    // real events come through normally with seq starting at 0.
    const streamRes = await fetch(
      `${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages/${messageId}/stream?afterSeq=-1`,
    );
    resolveBackend();
    const { events: streamEvents } = await readAllSse(streamRes);
    const deltas = streamEvents.filter((e) => e.event === "delta").map((e) => JSON.parse(e.data));
    expect(deltas).toEqual(["after"]);
    expect(streamEvents.some((e) => e.event === "turn_started")).toBe(false);
    expect(streamEvents[streamEvents.length - 1]!.event).toBe("done");

    await readAllSse(await post);
  });

  it("a POST whose connection drops mid-turn does NOT cancel the producer", async () => {
    const { instanceId, chatId } = await makeChat();
    let resolveBackend: () => void = () => {};
    const backendHold = new Promise<void>((r) => {
      resolveBackend = r;
    });
    backend.setScript([
      { kind: "delta", text: "before" },
      { kind: "wait", promise: backendHold },
      { kind: "delta", text: "after" },
    ]);

    const ac = new AbortController();
    const post = fetch(`${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hi" }),
      signal: ac.signal,
    });
    // Wait for the turn to land in the hub.
    let messageId: string | null = null;
    for (let i = 0; i < 50 && messageId === null; i++) {
      await new Promise((r) => setTimeout(r, 20));
      messageId = chatStreamHub.inFlightFor(chatId);
    }
    expect(messageId).not.toBeNull();
    // Wait for the first delta to flush so the producer is actually
    // mid-script and not still warming up.
    await new Promise((r) => setTimeout(r, 50));

    // Simulate a network drop on the POST. The hub's grace timer
    // shouldn't have fired yet (default 30s) so the producer keeps
    // running.
    ac.abort();
    try {
      await post;
    } catch {}

    // Reconnect via GET resume. The producer is still alive thanks to
    // the in-memory turn, so we should see both deltas.
    const getRes = await fetch(
      `${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages/${messageId}/stream?afterSeq=-1`,
    );
    resolveBackend();
    const { events } = await readAllSse(getRes);
    const snapshot = resumeSnapshot(events);
    const deltas = events.filter((e) => e.event === "delta").map((e) => JSON.parse(e.data));
    expect(snapshot.chunks).toEqual([{ kind: "text", text: "before" }]);
    expect(deltas).toEqual(["after"]);
    expect(events[events.length - 1]!.event).toBe("done");
  });

  // ── message editing (branching) ────────────────────────────────────────────

  // One scripted turn over the wire, returning the persisted user message id.
  async function runTurn(
    instanceId: string,
    chatId: string,
    content: string,
    actions: Action[],
    editMessageId?: string,
  ): Promise<{ userMessageId: string }> {
    backend.setScript(actions);
    const url = editMessageId
      ? `${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages/${editMessageId}/edit`
      : `${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    expect(res.status).toBe(200);
    const { events } = await readAllSse(res);
    expect(events[events.length - 1]!.event).toBe("done");
    const userMessage = JSON.parse(events.find((e) => e.event === "user_message")!.data) as {
      id: string;
    };
    return { userMessageId: userMessage.id };
  }

  it("an edit cancels an in-flight turn and preserves its partial branch", async () => {
    const { instanceId, chatId } = await makeChat();
    await runTurn(instanceId, chatId, "first question", [
      { kind: "meta", meta: { sessionId: "sess-1", anchorId: "anchor-1" } },
      { kind: "delta", text: "first answer" },
    ]);

    backend.setScript([{ kind: "delta", text: "partial old answer" }, { kind: "abortable" }]);
    const oldResponse = await fetch(
      `${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "question being replaced" }),
      },
    );
    await waitForInFlight(chatId);
    const original = chatManager
      .getMessages(chatId)
      .find((message) => message.content === "question being replaced")!;

    backend.setScript([
      { kind: "meta", meta: { sessionId: "sess-2", anchorId: "anchor-2" } },
      { kind: "delta", text: "replacement answer" },
    ]);
    const editResponse = await fetch(
      `${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages/${original.id}/edit`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "replacement question" }),
      },
    );
    expect(editResponse.status).toBe(200);
    const [{ events: oldEvents }, { events: editEvents }] = await Promise.all([
      readAllSse(oldResponse),
      readAllSse(editResponse),
    ]);
    expect(oldEvents.at(-1)?.event).toBe("error");
    expect(editEvents.at(-1)?.event).toBe("done");

    const messages = chatManager.getMessages(chatId);
    const partial = messages.find((message) => message.content === "partial old answer")!;
    const replacement = messages.find((message) => message.content === "replacement question")!;
    const replacementAnswer = messages.find((message) => message.content === "replacement answer")!;
    expect(partial.parentId).toBe(original.id);
    expect(replacement.parentId).toBe(original.parentId);
    expect(replacementAnswer.parentId).toBe(replacement.id);
    expect(chatManager.get(chatId)?.activeLeafId).toBe(replacementAnswer.id);
  });

  it("does not admit a normal send while an edit is cleaning up the old turn", async () => {
    const { instanceId, chatId } = await makeChat();
    await runTurn(instanceId, chatId, "first question", [
      { kind: "meta", meta: { sessionId: "sess-1", anchorId: "anchor-1" } },
      { kind: "delta", text: "first answer" },
    ]);

    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    backend.setScript([
      { kind: "delta", text: "partial old answer" },
      { kind: "abortable_cleanup", promise: cleanupGate },
    ]);
    const oldResponse = await fetch(
      `${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "question being replaced" }),
      },
    );
    await waitForInFlight(chatId);
    const original = chatManager
      .getMessages(chatId)
      .find((message) => message.content === "question being replaced")!;

    backend.setScript([{ kind: "delta", text: "replacement started" }, { kind: "abortable" }]);
    const editRequest = fetch(
      `${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages/${original.id}/edit`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "replacement question" }),
      },
    );
    for (let i = 0; i < 50 && !backend.lastSignal?.aborted; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(backend.lastSignal?.aborted).toBe(true);

    const competingSend = fetch(`${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "must not slip through" }),
    });
    const queuedResponse = await fetch(
      `${baseUrl}/api/instances/${instanceId}/chats/${chatId}/queue`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "queued-during-rewind",
          content: "wait until replacement",
        }),
      },
    );
    expect(queuedResponse.status).toBe(201);

    releaseCleanup();
    const editResponse = await editRequest;
    expect(editResponse.status).toBe(200);
    expect((await competingSend).status).toBe(409);

    const replacementMessageId = await waitForInFlight(chatId);
    expect(chatManager.getQueuedMessage("queued-during-rewind")?.status).toBe("queued");
    await fetch(
      `${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages/${replacementMessageId}`,
      { method: "DELETE" },
    );
    await Promise.all([readAllSse(oldResponse), readAllSse(editResponse)]);
    expect(
      chatManager
        .getMessages(chatId)
        .some((message) => message.content === "must not slip through"),
    ).toBe(false);
  });

  it("edit forks the session at the previous turn and records a sibling branch", async () => {
    const { instanceId, chatId } = await makeChat();
    const turn1 = await runTurn(instanceId, chatId, "first question", [
      { kind: "meta", meta: { sessionId: "sess-1", anchorId: "anchor-1" } },
      { kind: "delta", text: "first answer" },
    ]);
    const turn2 = await runTurn(instanceId, chatId, "second question", [
      { kind: "meta", meta: { sessionId: "sess-1", anchorId: "anchor-2" } },
      { kind: "delta", text: "second answer" },
    ]);

    // The linear shape before the edit: u1 → a1 → u2 → a2, with snapshots.
    const before = chatManager.getMessages(chatId);
    expect(before.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    const [u1, a1, u2, a2] = before;
    expect(u1!.id).toBe(turn1.userMessageId);
    expect(a1!.parentId).toBe(u1!.id);
    expect(a1!.sessionId).toBe("sess-1");
    expect(a1!.anchorId).toBe("anchor-1");
    expect(u2!.id).toBe(turn2.userMessageId);
    expect(chatManager.get(chatId)?.activeLeafId).toBe(a2!.id);

    // Edit u2: the turn must fork sess-1 at anchor-1 (the turn before u2).
    const edit = await runTurn(
      instanceId,
      chatId,
      "second question, edited",
      [
        { kind: "meta", meta: { sessionId: "sess-2", anchorId: "anchor-2b" } },
        { kind: "delta", text: "forked answer" },
      ],
      u2!.id,
    );
    expect(backend.lastOpts?.sessionId).toBe("sess-1");
    expect(backend.lastOpts?.fork).toEqual({ anchorId: "anchor-1" });

    // The edited version is a sibling of u2 (same parent), with its own
    // assistant child carrying the forked session's snapshot, and the chat
    // now shows the new branch. The original branch is untouched.
    const after = chatManager.getMessages(chatId);
    expect(after).toHaveLength(6);
    const u2b = after.find((m) => m.id === edit.userMessageId)!;
    expect(u2b.parentId).toBe(a1!.id);
    const a2b = after.find((m) => m.parentId === u2b.id)!;
    expect(a2b.role).toBe("assistant");
    expect(a2b.content).toBe("forked answer");
    expect(a2b.sessionId).toBe("sess-2");
    expect(a2b.anchorId).toBe("anchor-2b");
    expect(chatManager.get(chatId)?.activeLeafId).toBe(a2b.id);
    expect(chatManager.getMessage(a2!.id)?.content).toBe("second answer");
  });

  it("editing the first message starts a fresh session (no fork)", async () => {
    const { instanceId, chatId } = await makeChat();
    const turn1 = await runTurn(instanceId, chatId, "hello", [
      { kind: "meta", meta: { sessionId: "sess-1", anchorId: "anchor-1" } },
      { kind: "delta", text: "hi" },
    ]);
    await runTurn(
      instanceId,
      chatId,
      "hello, edited",
      [{ kind: "delta", text: "hi again" }],
      turn1.userMessageId,
    );
    expect(backend.lastOpts?.sessionId).toBeUndefined();
    expect(backend.lastOpts?.fork).toBeUndefined();
    const msgs = chatManager.getMessages(chatId);
    const edited = msgs.find((m) => m.content === "hello, edited")!;
    expect(edited.parentId).toBeNull();
  });

  it("edit stamps the chat-level session onto a legacy branch tip before forking", async () => {
    const { instanceId, chatId } = await makeChat();
    // A pre-snapshot turn: no meta, so the assistant row has no session.
    const turn1 = await runTurn(instanceId, chatId, "old question", [
      { kind: "delta", text: "old answer" },
    ]);
    // The chat column knows the active session (legacy behavior).
    chatManager.updateSessionId(chatId, "legacy-sess");

    await runTurn(
      instanceId,
      chatId,
      "old question, edited",
      [{ kind: "delta", text: "new answer" }],
      turn1.userMessageId,
    );
    // No anchor anywhere → fresh session for the edit…
    expect(backend.lastOpts?.sessionId).toBeUndefined();
    expect(backend.lastOpts?.fork).toBeUndefined();
    // …but the original branch's assistant tip got the legacy session
    // stamped, so switching back can still resume it.
    const msgs = chatManager.getMessages(chatId);
    const legacyAssistant = msgs.find((m) => m.content === "old answer")!;
    expect(legacyAssistant.sessionId).toBe("legacy-sess");
  });

  it("rejects edits of assistant messages and unknown messages", async () => {
    const { instanceId, chatId } = await makeChat();
    await runTurn(instanceId, chatId, "hi", [{ kind: "delta", text: "hello" }]);
    const assistant = chatManager.getMessages(chatId).find((m) => m.role === "assistant")!;

    const editAssistant = await fetch(
      `${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages/${assistant.id}/edit`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "nope" }),
      },
    );
    expect(editAssistant.status).toBe(400);

    const editUnknown = await fetch(
      `${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages/does-not-exist/edit`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "nope" }),
      },
    );
    expect(editUnknown.status).toBe(404);
  });

  it("version navigation cancels an in-flight turn before activating the target branch", async () => {
    const { instanceId, chatId } = await makeChat();
    await runTurn(instanceId, chatId, "q1", [
      { kind: "meta", meta: { sessionId: "sess-1", anchorId: "anchor-1" } },
      { kind: "delta", text: "a1" },
    ]);
    const original = await runTurn(instanceId, chatId, "q2", [
      { kind: "meta", meta: { sessionId: "sess-1", anchorId: "anchor-2" } },
      { kind: "delta", text: "original answer" },
    ]);
    const originalAssistant = chatManager
      .getMessages(chatId)
      .find((message) => message.parentId === original.userMessageId)!;
    await runTurn(
      instanceId,
      chatId,
      "q2 edited",
      [
        { kind: "meta", meta: { sessionId: "sess-2", anchorId: "anchor-2b" } },
        { kind: "delta", text: "edited answer" },
      ],
      original.userMessageId,
    );

    backend.setScript([{ kind: "delta", text: "partial branch work" }, { kind: "abortable" }]);
    const oldResponse = await fetch(
      `${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "continue edited branch" }),
      },
    );
    await waitForInFlight(chatId);

    const switchResponse = await fetch(
      `${baseUrl}/api/instances/${instanceId}/chats/${chatId}/active-leaf`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leafId: original.userMessageId }),
      },
    );
    expect(switchResponse.status).toBe(200);
    const switched = (await switchResponse.json()) as {
      activeLeafId: string;
      transcript: { messages: { id: string }[] };
    };
    const { events } = await readAllSse(oldResponse);
    expect(events.at(-1)?.event).toBe("error");
    expect(switched.activeLeafId).toBe(originalAssistant.id);
    expect(switched.transcript.messages.at(-1)?.id).toBe(originalAssistant.id);
    expect(
      chatManager.getMessages(chatId).some((message) => message.content === "partial branch work"),
    ).toBe(true);
  });

  it("active-leaf switches branches, descends to the tip, and re-points the session", async () => {
    const { instanceId, chatId } = await makeChat();
    await runTurn(instanceId, chatId, "q1", [
      { kind: "meta", meta: { sessionId: "sess-1", anchorId: "anchor-1" } },
      { kind: "delta", text: "a1" },
    ]);
    const turn2 = await runTurn(instanceId, chatId, "q2", [
      { kind: "meta", meta: { sessionId: "sess-1", anchorId: "anchor-2" } },
      { kind: "delta", text: "a2" },
    ]);
    await runTurn(
      instanceId,
      chatId,
      "q2, edited",
      [
        { kind: "meta", meta: { sessionId: "sess-2", anchorId: "anchor-2b" } },
        { kind: "delta", text: "a2b" },
      ],
      turn2.userMessageId,
    );

    // Switch back to the original branch by naming its user message. The
    // server descends to that branch's tip (its assistant answer).
    const res = await fetch(`${baseUrl}/api/instances/${instanceId}/chats/${chatId}/active-leaf`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ leafId: turn2.userMessageId }),
    });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as {
      activeLeafId: string;
      claudeSessionId: string | null;
      transcript: { messages: { id: string }[] };
    };
    const originalAssistant = chatManager
      .getMessages(chatId)
      .find((m) => m.parentId === turn2.userMessageId)!;
    expect(updated.activeLeafId).toBe(originalAssistant.id);
    expect(updated.claudeSessionId).toBe("sess-1");
    expect(updated.transcript.messages.at(-1)?.id).toBe(originalAssistant.id);
    expect(chatManager.get(chatId)?.activeLeafId).toBe(originalAssistant.id);

    const unknown = await fetch(
      `${baseUrl}/api/instances/${instanceId}/chats/${chatId}/active-leaf`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leafId: "does-not-exist" }),
      },
    );
    expect(unknown.status).toBe(404);
  });
});
