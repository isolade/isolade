import { beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "crypto";
import { ChatStreamHub, type StreamSignal } from "../src/chat/stream-hub";
import { ChatManager } from "../src/chats";
import { createDb, schema } from "../src/db";

function captureSubscriber() {
  const signals: StreamSignal[] = [];
  let resolve: () => void = () => {};
  const terminal = new Promise<void>((done) => {
    resolve = done;
  });
  return {
    signals,
    cb(signal: StreamSignal) {
      signals.push(signal);
      if (signal.kind !== "event") resolve();
    },
    terminal,
  };
}

describe("ChatStreamHub", () => {
  let db: ReturnType<typeof createDb>;
  let chatManager: ChatManager;
  let hub: ChatStreamHub;
  let chatId: string;
  let messageId: string;

  beforeEach(() => {
    db = createDb(":memory:");
    chatManager = new ChatManager(db);
    const instanceId = randomUUID();
    db.insert(schema.instances)
      .values({
        id: instanceId,
        vmId: `vm-${instanceId}`,
        status: "running",
        image: "test-image",
        profileId: "default",
      })
      .run();
    chatId = chatManager.create(instanceId, "claude-sonnet-4-5", "anthropic", "high").id;
    messageId = randomUUID();
    hub = new ChatStreamHub(chatManager, { idleCancelMs: 60_000, evictionMs: 60_000 });
  });

  it("captures compact state atomically and delivers only later events", async () => {
    let release: () => void = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    hub.startTurn({
      chatId,
      messageId,
      run: async (api) => {
        api.publish("delta", "before");
        expect(api.renderChunks()).toEqual([{ kind: "text", text: "before" }]);
        await hold;
        api.publish("delta", "after");
      },
    });

    const tail = captureSubscriber();
    const subscription = hub.subscribeSnapshot(chatId, messageId, false, tail.cb);
    expect(subscription?.snapshot).toMatchObject({
      messageId,
      lastSeq: 0,
      status: "running",
      chunks: [{ kind: "text", text: "before" }],
    });
    expect(tail.signals).toEqual([]);

    release();
    await tail.terminal;
    expect(tail.signals).toEqual([
      { kind: "event", event: { seq: 1, type: "delta", payload: "after" } },
      { kind: "done" },
    ]);
  });

  it("persists before fanout", async () => {
    let release: () => void = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    hub.startTurn({
      chatId,
      messageId,
      run: async (api) => {
        await hold;
        api.publish("delta", "durable");
      },
    });
    const subscriber = captureSubscriber();
    hub.subscribeSnapshot(chatId, messageId, false, (signal) => {
      if (signal.kind === "event") {
        expect(chatManager.getEventsForMessage(messageId)).toHaveLength(1);
      }
      subscriber.cb(signal);
    });
    release();
    await subscriber.terminal;
    expect(JSON.parse(chatManager.getEventsForMessage(messageId)[0]!.payload)).toBe("durable");
  });

  it("keeps only the latest resume metadata", () => {
    hub.startTurn({
      chatId,
      messageId,
      run: async (api) => {
        api.publish("usage", { total: 1 });
        api.publish("title", "Title");
        api.publish("usage", { total: 2 });
        api.publish("context_compacted", null);
        await new Promise(() => {});
      },
    });

    expect(hub.snapshotForChat(chatId, messageId, false)?.metaEvents).toEqual([
      { seq: 1, type: "title", payload: "Title" },
      { seq: 2, type: "usage", payload: { total: 2 } },
      { seq: 3, type: "context_compacted", payload: null },
    ]);
    hub.cancel(messageId);
  });

  it("filters debug events and bounds live tool payloads", async () => {
    let release: () => void = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    hub.startTurn({
      chatId,
      messageId,
      run: async (api) => {
        await hold;
        api.publish("thinking", { text: "secret" });
        api.publish("thinking_start", { id: "visible", provider: "claude" });
        api.publish("thinking_tokens", { id: "visible", provider: "claude", tokens: 768 });
        api.publish("raw", { source: "claude", payload: { value: "z".repeat(20_000) } });
        api.publish("tool_call_start", { id: "tool", name: "Bash" });
        api.publish("tool_call_input", {
          id: "tool",
          input: { command: `echo ${"x".repeat(20_000)}` },
        });
        api.publish("tool_call_result", { id: "tool", output: "y".repeat(20_000) });
      },
    });
    const subscriber = captureSubscriber();
    hub.subscribeSnapshot(chatId, messageId, false, subscriber.cb);
    release();
    await subscriber.terminal;

    const events = subscriber.signals.filter(
      (signal): signal is Extract<StreamSignal, { kind: "event" }> => signal.kind === "event",
    );
    expect(events.map((signal) => signal.event.type)).toEqual([
      "thinking_start",
      "thinking_tokens",
      "tool_call_start",
      "tool_call_input",
      "tool_call_result",
    ]);
    const input = events[3]!.event.payload as {
      input: unknown;
      summary?: string;
      detailsAvailable?: boolean;
    };
    const result = events[4]!.event.payload as { output: string; detailsAvailable?: boolean };
    expect(JSON.stringify(input.input).length).toBeLessThan(1_200);
    expect(input.summary).toStartWith("echo ");
    expect(input.summary!.length).toBeLessThan(600);
    expect(input.detailsAvailable).toBe(true);
    expect(result.output.length).toBeLessThan(2_100);
    expect(result.detailsAvailable).toBe(true);
  });

  it("fans out the same tail to multiple subscribers", async () => {
    let release: () => void = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    hub.startTurn({
      chatId,
      messageId,
      run: async (api) => {
        api.publish("delta", "snapshot");
        await hold;
        api.publish("delta", "tail");
      },
    });
    const first = captureSubscriber();
    const second = captureSubscriber();
    expect(hub.subscribeSnapshot(chatId, messageId, false, first.cb)?.snapshot.chunks).toEqual([
      { kind: "text", text: "snapshot" },
    ]);
    hub.subscribeSnapshot(chatId, messageId, false, second.cb);
    release();
    await Promise.all([first.terminal, second.terminal]);
    expect(first.signals).toEqual(second.signals);
  });

  it("unsubscribing one listener does not affect another", async () => {
    let release: () => void = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    hub.startTurn({
      chatId,
      messageId,
      run: async (api) => {
        await hold;
        api.publish("delta", "tail");
      },
    });
    const first = captureSubscriber();
    const second = captureSubscriber();
    const firstHandle = hub.subscribeSnapshot(chatId, messageId, false, first.cb)!;
    hub.subscribeSnapshot(chatId, messageId, false, second.cb);
    firstHandle.unsubscribe();
    release();
    await second.terminal;
    expect(first.signals).toEqual([]);
    expect(second.signals.at(-1)).toEqual({ kind: "done" });
  });

  it("cancels explicitly and tears down every turn for a deleted chat", async () => {
    const subscriber = captureSubscriber();
    hub.startTurn({
      chatId,
      messageId,
      run: async (api) =>
        new Promise<void>((_, reject) => {
          api.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    });
    hub.subscribeSnapshot(chatId, messageId, false, subscriber.cb);
    expect(hub.cancel(messageId)).toBe(true);
    await subscriber.terminal;
    expect(subscriber.signals.at(-1)).toEqual({ kind: "error", message: "aborted" });

    const deletedMessageId = randomUUID();
    const deletedSubscriber = captureSubscriber();
    hub.startTurn({
      chatId,
      messageId: deletedMessageId,
      run: async (api) =>
        new Promise<void>((_, reject) => {
          api.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    });
    hub.subscribeSnapshot(chatId, deletedMessageId, false, deletedSubscriber.cb);
    hub.cancelForChat(chatId);
    await deletedSubscriber.terminal;
    expect(deletedSubscriber.signals.at(-1)?.kind).toBe("error");
    expect(hub.has(deletedMessageId)).toBe(false);
  });

  it("uses one bounded no-subscriber lifetime", async () => {
    const abandonedHub = new ChatStreamHub(chatManager, {
      idleCancelMs: 40,
      evictionMs: 60_000,
    });
    let abandonedTurnAborted = false;
    abandonedHub.startTurn({
      chatId,
      messageId: randomUUID(),
      run: async (api) =>
        new Promise<void>((_, reject) => {
          api.signal.addEventListener(
            "abort",
            () => {
              abandonedTurnAborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        }),
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(abandonedTurnAborted).toBe(true);

    const fastHub = new ChatStreamHub(chatManager, { idleCancelMs: 40, evictionMs: 60_000 });
    let aborted = false;
    fastHub.startTurn({
      chatId,
      messageId,
      run: async (api) =>
        new Promise<void>((_, reject) => {
          api.signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        }),
    });
    const handle = fastHub.subscribeSnapshot(chatId, messageId, false, () => {})!;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(aborted).toBe(false);
    handle.unsubscribe();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(aborted).toBe(true);
  });

  it("reports ownership, running state, and eviction", async () => {
    const fastHub = new ChatStreamHub(chatManager, {
      idleCancelMs: 60_000,
      evictionMs: 20,
    });
    fastHub.startTurn({
      chatId,
      messageId,
      run: async (api) => {
        api.publish("delta", "done");
      },
    });
    expect(fastHub.hasForChat(chatId, messageId)).toBe(true);
    expect(fastHub.hasForChat("other", messageId)).toBe(false);
    expect(fastHub.inFlightFor(chatId)).toBe(messageId);
    expect(fastHub.subscribeSnapshot(chatId, "missing", false, () => {})).toBe(null);
    expect(() => fastHub.startTurn({ chatId, messageId, run: async () => {} })).toThrow();
    await fastHub.drain();
    expect(fastHub.inFlightFor(chatId)).toBe(null);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(fastHub.has(messageId)).toBe(false);
  });

  it("aborts without exposing a non-durable event", async () => {
    chatManager.appendEvent = () => {
      throw new Error("disk full");
    };
    let aborted = false;
    hub.startTurn({
      chatId,
      messageId,
      run: async (api) => {
        try {
          api.publish("delta", "lost");
        } finally {
          aborted = api.signal.aborted;
        }
      },
    });
    await hub.drain();
    expect(aborted).toBe(true);
    expect(hub.snapshotForChat(chatId, messageId, false)).toMatchObject({
      lastSeq: -1,
      chunks: [],
      status: "error",
    });
  });
});
