import { beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "crypto";
import { ChatStreamHub, type StreamSignal } from "../src/chat/stream-hub";
import { ChatManager } from "../src/chats";
import { createDb } from "../src/db";

function makeDb() {
  return createDb(":memory:");
}

function makeInstanceId(db: ReturnType<typeof makeDb>) {
  const { schema } = require("../src/db");
  const id = randomUUID();
  db.insert(schema.instances)
    .values({
      id,
      vmId: `vm-${id.slice(0, 8)}`,
      status: "running",
      image: "test-image",
      profileId: "default",
    })
    .run();
  return id;
}

// Capture every signal a subscriber sees so we can assert on the
// sequence after the test runs.
function captureSubscriber(): {
  signals: StreamSignal[];
  cb: (s: StreamSignal) => void;
  awaitTerminal: () => Promise<void>;
} {
  const signals: StreamSignal[] = [];
  let resolve: () => void = () => {};
  const done = new Promise<void>((r) => {
    resolve = r;
  });
  return {
    signals,
    cb: (s) => {
      signals.push(s);
      if (s.kind === "done" || s.kind === "error") resolve();
    },
    awaitTerminal: () => done,
  };
}

describe("ChatStreamHub", () => {
  let db: ReturnType<typeof makeDb>;
  let cm: ChatManager;
  let hub: ChatStreamHub;
  let chatId: string;
  let messageId: string;

  beforeEach(() => {
    db = makeDb();
    cm = new ChatManager(db);
    hub = new ChatStreamHub(cm, { idleCancelMs: 60_000, evictionMs: 60_000 });
    const instanceId = makeInstanceId(db);
    const chat = cm.create(instanceId, "claude-sonnet-4-5", "anthropic", "high");
    chatId = chat.id;
    messageId = randomUUID();
  });

  describe("happy path", () => {
    it("fans out producer events to a single subscriber", async () => {
      const sub = captureSubscriber();
      hub.startTurn({
        chatId,
        messageId,
        run: async (api) => {
          api.publish("delta", "hello ");
          api.publish("delta", "world");
        },
      });
      hub.subscribe(messageId, -1, sub.cb);
      await sub.awaitTerminal();
      expect(sub.signals.length).toBe(3);
      expect(sub.signals[0]).toEqual({
        kind: "event",
        event: { seq: 0, type: "delta", payload: "hello " },
      });
      expect(sub.signals[1]).toEqual({
        kind: "event",
        event: { seq: 1, type: "delta", payload: "world" },
      });
      expect(sub.signals[2]).toEqual({ kind: "done" });
    });

    it("persists events to chat_events as they fan out", async () => {
      hub.startTurn({
        chatId,
        messageId,
        run: async (api) => {
          api.publish("delta", "abc");
          api.publish("delta", "def");
        },
      });
      await hub.drain();
      const events = cm.getEventsForMessage(messageId);
      expect(
        events.map((e) => ({
          seq: e.seq,
          type: e.type,
          payload: JSON.parse(e.payload),
        })),
      ).toEqual([
        { seq: 0, type: "delta", payload: "abc" },
        { seq: 1, type: "delta", payload: "def" },
      ]);
    });

    it("emits error signal when the producer throws", async () => {
      const sub = captureSubscriber();
      hub.startTurn({
        chatId,
        messageId,
        run: async () => {
          throw new Error("oops");
        },
      });
      hub.subscribe(messageId, -1, sub.cb);
      await sub.awaitTerminal();
      expect(sub.signals).toEqual([{ kind: "error", message: "oops" }]);
    });
  });

  describe("resume / replay", () => {
    it("replays buffered events to a late subscriber", async () => {
      // Producer publishes immediately but we don't subscribe until
      // after they've all landed. Use a delay to ensure publish() has
      // happened before subscribe().
      let resolveProducer: () => void = () => {};
      const producerHold = new Promise<void>((r) => {
        resolveProducer = r;
      });
      hub.startTurn({
        chatId,
        messageId,
        run: async (api) => {
          api.publish("delta", "a");
          api.publish("delta", "b");
          api.publish("delta", "c");
          await producerHold;
        },
      });
      // Subscribe NOW, and it should get replay of all 3 events.
      const sub = captureSubscriber();
      hub.subscribe(messageId, -1, sub.cb);
      // Sanity: replay is synchronous within subscribe().
      expect(sub.signals.length).toBe(3);
      expect(sub.signals.map((s) => (s.kind === "event" ? s.event.payload : null))).toEqual([
        "a",
        "b",
        "c",
      ]);
      // Now let producer finish.
      resolveProducer();
      await sub.awaitTerminal();
      // Done arrives after the producer settles.
      expect(sub.signals[sub.signals.length - 1]).toEqual({ kind: "done" });
    });

    it("skips events the subscriber has already seen", async () => {
      let resolveProducer: () => void = () => {};
      const producerHold = new Promise<void>((r) => {
        resolveProducer = r;
      });
      hub.startTurn({
        chatId,
        messageId,
        run: async (api) => {
          api.publish("delta", "a"); // seq 0
          api.publish("delta", "b"); // seq 1
          api.publish("delta", "c"); // seq 2
          await producerHold;
        },
      });
      const sub = captureSubscriber();
      // Subscribe asking for events after seq 0, and it should only get b, c.
      hub.subscribe(messageId, 0, sub.cb);
      expect(sub.signals.map((s) => (s.kind === "event" ? s.event.seq : null))).toEqual([1, 2]);
      resolveProducer();
      await sub.awaitTerminal();
    });

    it("delivers settled status synchronously to late subscribers", async () => {
      hub.startTurn({
        chatId,
        messageId,
        run: async (api) => {
          api.publish("delta", "done");
        },
      });
      await hub.drain();
      const sub = captureSubscriber();
      hub.subscribe(messageId, -1, sub.cb);
      // Both replay event and terminal signal arrive synchronously.
      expect(sub.signals).toEqual([
        { kind: "event", event: { seq: 0, type: "delta", payload: "done" } },
        { kind: "done" },
      ]);
    });

    it("late subscribers after error see the error", async () => {
      hub.startTurn({
        chatId,
        messageId,
        run: async () => {
          throw new Error("boom");
        },
      });
      await hub.drain();
      const sub = captureSubscriber();
      hub.subscribe(messageId, -1, sub.cb);
      expect(sub.signals).toEqual([{ kind: "error", message: "boom" }]);
    });
  });

  describe("multi-subscriber", () => {
    it("delivers the same events to two subscribers in order", async () => {
      let resolveProducer: () => void = () => {};
      const producerHold = new Promise<void>((r) => {
        resolveProducer = r;
      });
      hub.startTurn({
        chatId,
        messageId,
        run: async (api) => {
          api.publish("delta", "x");
          await producerHold;
          api.publish("delta", "y");
        },
      });
      const a = captureSubscriber();
      const b = captureSubscriber();
      hub.subscribe(messageId, -1, a.cb);
      hub.subscribe(messageId, -1, b.cb);
      // Both saw the first replay.
      expect(a.signals.length).toBe(1);
      expect(b.signals.length).toBe(1);
      resolveProducer();
      await Promise.all([a.awaitTerminal(), b.awaitTerminal()]);
      const aPayloads = a.signals
        .filter((s) => s.kind === "event")
        .map((s) => (s as Extract<StreamSignal, { kind: "event" }>).event.payload);
      const bPayloads = b.signals
        .filter((s) => s.kind === "event")
        .map((s) => (s as Extract<StreamSignal, { kind: "event" }>).event.payload);
      expect(aPayloads).toEqual(["x", "y"]);
      expect(bPayloads).toEqual(["x", "y"]);
    });

    it("unsubscribe stops delivery without affecting other subscribers", async () => {
      let resolveProducer: () => void = () => {};
      const producerHold = new Promise<void>((r) => {
        resolveProducer = r;
      });
      hub.startTurn({
        chatId,
        messageId,
        run: async (api) => {
          api.publish("delta", "first");
          await producerHold;
          api.publish("delta", "second");
        },
      });
      const a = captureSubscriber();
      const b = captureSubscriber();
      const subA = hub.subscribe(messageId, -1, a.cb)!;
      hub.subscribe(messageId, -1, b.cb);
      subA.unsubscribe();
      resolveProducer();
      await b.awaitTerminal();
      // A only saw "first"; B saw both.
      const aPayloads = a.signals
        .filter((s) => s.kind === "event")
        .map((s) => (s as Extract<StreamSignal, { kind: "event" }>).event.payload);
      const bPayloads = b.signals
        .filter((s) => s.kind === "event")
        .map((s) => (s as Extract<StreamSignal, { kind: "event" }>).event.payload);
      expect(aPayloads).toEqual(["first"]);
      expect(bPayloads).toEqual(["first", "second"]);
    });
  });

  describe("cancellation", () => {
    it("cancel aborts the producer signal", async () => {
      const sub = captureSubscriber();
      // Captured inside the producer callback. A plain `let` would be
      // flow-narrowed to its initializer (TS doesn't track assignments made
      // inside nested closures), so use a holder object whose property type
      // is preserved.
      const captured: { signal: AbortSignal | null } = { signal: null };
      hub.startTurn({
        chatId,
        messageId,
        run: async (api) => {
          captured.signal = api.signal;
          await new Promise<void>((_resolve, reject) => {
            api.signal.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
          });
        },
      });
      hub.subscribe(messageId, -1, sub.cb);
      const cancelled = hub.cancel(messageId);
      expect(cancelled).toBe(true);
      await sub.awaitTerminal();
      expect(captured.signal?.aborted).toBe(true);
      expect(sub.signals[sub.signals.length - 1]).toEqual({
        kind: "error",
        message: "aborted",
      });
    });

    it("cancel returns false for unknown messageId", () => {
      expect(hub.cancel("nonexistent")).toBe(false);
    });

    it("cancelForChat tears down every turn for the chat", async () => {
      const otherChatId = cm.create(
        makeInstanceId(db),
        "claude-sonnet-4-5",
        "anthropic",
        "high",
      ).id;
      const otherMsgId = randomUUID();
      const subA = captureSubscriber();
      const subB = captureSubscriber();
      hub.startTurn({
        chatId,
        messageId,
        run: async (api) => {
          await new Promise<void>((_, reject) => {
            api.signal.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
          });
        },
      });
      hub.startTurn({
        chatId: otherChatId,
        messageId: otherMsgId,
        run: async (api) => {
          await new Promise<void>((_, reject) => {
            api.signal.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
          });
        },
      });
      hub.subscribe(messageId, -1, subA.cb);
      hub.subscribe(otherMsgId, -1, subB.cb);
      hub.cancelForChat(chatId);
      // Subscriber A should see error and be evicted.
      // Subscriber B keeps going.
      await new Promise((r) => setTimeout(r, 50));
      expect(subA.signals[subA.signals.length - 1]?.kind).toBe("error");
      expect(subB.signals.length).toBe(0); // still running
      hub.cancel(otherMsgId);
      await subB.awaitTerminal();
    });
  });

  describe("idle cancel", () => {
    it("cancels the producer when no subscriber attaches before grace", async () => {
      const fastHub = new ChatStreamHub(cm, {
        idleCancelMs: 50,
        evictionMs: 60_000,
      });
      const result = new Promise<unknown>((resolve) => {
        fastHub.startTurn({
          chatId,
          messageId,
          run: async (api) => {
            try {
              await new Promise<void>((_, reject) => {
                api.signal.addEventListener("abort", () => reject(new Error("aborted")), {
                  once: true,
                });
              });
              resolve(null);
            } catch (err) {
              resolve(err);
            }
          },
        });
      });
      // Don't subscribe. Wait > idleCancelMs.
      await new Promise((r) => setTimeout(r, 150));
      const err = await result;
      expect((err as Error)?.message).toBe("aborted");
    });

    it("attaching a subscriber clears the grace timer", async () => {
      const fastHub = new ChatStreamHub(cm, {
        idleCancelMs: 50,
        evictionMs: 60_000,
      });
      let producerAlive = true;
      let resolveProducer: () => void = () => {};
      fastHub.startTurn({
        chatId,
        messageId,
        run: async (api) => {
          await new Promise<void>((resolve, reject) => {
            resolveProducer = resolve;
            api.signal.addEventListener(
              "abort",
              () => {
                producerAlive = false;
                reject(new Error("aborted"));
              },
              { once: true },
            );
          });
        },
      });
      const sub = captureSubscriber();
      // Subscribe inside the grace window so it cancels the timer.
      await new Promise((r) => setTimeout(r, 10));
      fastHub.subscribe(messageId, -1, sub.cb);
      // Wait well past the grace window.
      await new Promise((r) => setTimeout(r, 150));
      expect(producerAlive).toBe(true);
      resolveProducer();
      await sub.awaitTerminal();
    });

    it("unsubscribing the last subscriber restarts the grace timer", async () => {
      const fastHub = new ChatStreamHub(cm, {
        idleCancelMs: 50,
        evictionMs: 60_000,
      });
      let aborted = false;
      fastHub.startTurn({
        chatId,
        messageId,
        run: async (api) => {
          await new Promise<void>((_, reject) => {
            api.signal.addEventListener(
              "abort",
              () => {
                aborted = true;
                reject(new Error("aborted"));
              },
              { once: true },
            );
          });
        },
      });
      const sub = captureSubscriber();
      const handle = fastHub.subscribe(messageId, -1, sub.cb)!;
      handle.unsubscribe();
      await new Promise((r) => setTimeout(r, 150));
      expect(aborted).toBe(true);
    });
  });

  describe("invariants", () => {
    it("rejects starting two turns with the same messageId", () => {
      hub.startTurn({
        chatId,
        messageId,
        run: async () => new Promise(() => {}),
      });
      expect(() => hub.startTurn({ chatId, messageId, run: async () => {} })).toThrow();
    });

    it("has() reports running turns", async () => {
      expect(hub.has(messageId)).toBe(false);
      let resolveProducer: () => void = () => {};
      hub.startTurn({
        chatId,
        messageId,
        run: async () =>
          new Promise<void>((r) => {
            resolveProducer = r;
          }),
      });
      expect(hub.has(messageId)).toBe(true);
      resolveProducer();
      await hub.drain();
      // Still in memory until evictionMs elapses.
      expect(hub.has(messageId)).toBe(true);
    });

    it("inFlightFor returns the active messageId for a chat", async () => {
      expect(hub.inFlightFor(chatId)).toBe(null);
      let resolveProducer: () => void = () => {};
      hub.startTurn({
        chatId,
        messageId,
        run: async () =>
          new Promise<void>((r) => {
            resolveProducer = r;
          }),
      });
      expect(hub.inFlightFor(chatId)).toBe(messageId);
      resolveProducer();
      await hub.drain();
      // Done turns aren't reported as in flight.
      expect(hub.inFlightFor(chatId)).toBe(null);
    });

    it("subscribe returns null for unknown messageId", () => {
      expect(hub.subscribe("nonexistent", -1, () => {})).toBe(null);
    });

    it("eviction removes settled turns from memory", async () => {
      const fastHub = new ChatStreamHub(cm, {
        idleCancelMs: 60_000,
        evictionMs: 30,
      });
      fastHub.startTurn({
        chatId,
        messageId,
        run: async (api) => {
          api.publish("delta", "x");
        },
      });
      await fastHub.drain();
      expect(fastHub.has(messageId)).toBe(true);
      await new Promise((r) => setTimeout(r, 80));
      expect(fastHub.has(messageId)).toBe(false);
    });
  });

  describe("persistence resilience", () => {
    it("publishing survives a failing appendEvent", async () => {
      // Spy/stub: replace appendEvent with one that throws to simulate
      // a transient DB hiccup. The hub should still fan out the event.
      const originalAppend = cm.appendEvent.bind(cm);
      let calls = 0;
      cm.appendEvent = (chat, msg, seq, type, payload) => {
        calls++;
        if (calls === 1) throw new Error("disk full");
        return originalAppend(chat, msg, seq, type, payload);
      };
      const sub = captureSubscriber();
      hub.startTurn({
        chatId,
        messageId,
        run: async (api) => {
          api.publish("delta", "first"); // appendEvent throws
          api.publish("delta", "second"); // appendEvent succeeds
        },
      });
      hub.subscribe(messageId, -1, sub.cb);
      await sub.awaitTerminal();
      // Both events fanned out.
      expect(sub.signals.length).toBe(3);
      expect(sub.signals[0]).toEqual({
        kind: "event",
        event: { seq: 0, type: "delta", payload: "first" },
      });
      expect(sub.signals[1]).toEqual({
        kind: "event",
        event: { seq: 1, type: "delta", payload: "second" },
      });
    });
  });
});
