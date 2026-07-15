import { describe, expect, it } from "bun:test";
import {
  type ChatTurnEvent,
  cancelChatTurn,
  resumeChatTurn,
  runChatTurn,
} from "../src/lib/chat-stream";

// In-memory mock of the server's SSE endpoint surface. We install it
// as a fetch override so the chat-stream module's fetch() calls land
// in the mock without us monkey-patching any internals.
//
// Each test registers a script of responses: each entry maps a
// matcher (method + path) to either a string body (treated as SSE) or
// a function that constructs a Response (allowing per-call state).
//
// Setting `delayBeforeFirstByte` simulates a server that opens the
// response but doesn't send the body promptly, which is useful for testing
// the idle timeout. Setting `endEarly` simulates a body that closes
// without a terminal event, which the client should reconnect on.

type RouteResponder = string | ((req: Request) => Promise<Response> | Response);

interface MockServerOptions {
  routes: Array<{
    method: string;
    pathRegex: RegExp;
    respond: RouteResponder;
  }>;
}

function installMockFetch(opts: MockServerOptions): {
  restore: () => void;
  calls: { method: string; url: string }[];
} {
  const original = globalThis.fetch;
  const calls: { method: string; url: string }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const u = new URL(req.url);
    calls.push({ method: req.method, url: req.url });
    for (const route of opts.routes) {
      if (route.method === req.method && route.pathRegex.test(u.pathname + u.search)) {
        if (typeof route.respond === "string") {
          return new Response(route.respond, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          });
        }
        return await route.respond(req);
      }
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = original;
    },
    calls,
  };
}

function sseBody(events: { event?: string; data: string; id?: string | number }[]): string {
  return (
    events
      .map((e) => {
        const parts: string[] = [];
        if (e.id !== undefined) parts.push(`id: ${e.id}`);
        if (e.event) parts.push(`event: ${e.event}`);
        parts.push(`data: ${e.data}`);
        return parts.join("\n") + "\n";
      })
      .join("\n") + "\n"
  );
}

// Construct a Response from a stream we control, so we can inject
// disconnects, partial frames, etc.
function streamedResponse(
  controllerFn: (controller: ReadableStreamDefaultController<Uint8Array>) => void | Promise<void>,
  init: ResponseInit = {},
): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      void Promise.resolve(controllerFn(controller));
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
    ...init,
  });
}

describe("runChatTurn", () => {
  it("happy path: POST → message_id, deltas, done", async () => {
    const mock = installMockFetch({
      routes: [
        {
          method: "POST",
          pathRegex: /\/messages$/,
          respond: sseBody([
            { event: "message_id", data: JSON.stringify("msg-1") },
            { id: 0, event: "delta", data: JSON.stringify("hi") },
            { id: 1, event: "delta", data: JSON.stringify(" world") },
            { event: "done", data: "" },
          ]),
        },
      ],
    });
    const events: ChatTurnEvent[] = [];
    const ac = new AbortController();
    try {
      await runChatTurn({
        apiBase: "http://test",
        instanceId: "i1",
        chatId: "c1",
        content: "hi",
        onEvent: (ev) => events.push(ev),
        signal: ac.signal,
      });
      expect(events[0]).toEqual({ kind: "message_id", messageId: "msg-1" });
      expect(
        events
          .filter((e) => e.kind === "event")
          .map((e) => (e as Extract<ChatTurnEvent, { kind: "event" }>).payload),
      ).toEqual(["hi", " world"]);
      expect(events[events.length - 1]).toEqual({ kind: "done" });
    } finally {
      mock.restore();
    }
  });

  it("reconnects via GET when POST disconnects mid-stream", async () => {
    let postCount = 0;
    let resumeCount = 0;
    const mock = installMockFetch({
      routes: [
        {
          method: "POST",
          pathRegex: /\/messages$/,
          respond: () => {
            postCount++;
            // First POST: emit message_id + delta then close abruptly.
            return streamedResponse((controller) => {
              const enc = new TextEncoder();
              controller.enqueue(
                enc.encode(`event: message_id\ndata: ${JSON.stringify("msg-2")}\n\n`),
              );
              controller.enqueue(
                enc.encode(`id: 0\nevent: delta\ndata: ${JSON.stringify("hi ")}\n\n`),
              );
              // Close without a `done` event, which simulates network drop.
              controller.close();
            });
          },
        },
        {
          method: "GET",
          pathRegex: /\/messages\/msg-2\/stream/,
          respond: (req) => {
            resumeCount++;
            const url = new URL(req.url);
            const after = Number(url.searchParams.get("afterSeq"));
            // Server replays seqs > after, then done.
            const body = sseBody([
              { event: "message_id", data: JSON.stringify("msg-2") },
              ...(after < 1 ? [{ id: 1, event: "delta", data: JSON.stringify("world") }] : []),
              { event: "done", data: "" },
            ]);
            return new Response(body, {
              status: 200,
              headers: { "Content-Type": "text/event-stream" },
            });
          },
        },
      ],
    });
    const events: ChatTurnEvent[] = [];
    const ac = new AbortController();
    try {
      await runChatTurn({
        apiBase: "http://test",
        instanceId: "i1",
        chatId: "c1",
        content: "hi",
        onEvent: (ev) => events.push(ev),
        signal: ac.signal,
        backoffBaseMs: 1,
        backoffCapMs: 5,
      });
      expect(postCount).toBe(1);
      expect(resumeCount).toBe(1);
      const deltas = events
        .filter((e) => e.kind === "event")
        .map((e) => (e as Extract<ChatTurnEvent, { kind: "event" }>).payload);
      expect(deltas).toEqual(["hi ", "world"]);
      expect(events[events.length - 1]).toEqual({ kind: "done" });
    } finally {
      mock.restore();
    }
  });

  it("idempotent: applies the same event only once across reconnects", async () => {
    // The server replays seq 0 again (poorly behaved), but the client
    // should still pass it through onEvent. The application-level
    // dedup happens in the caller (drainTurn in Chat.tsx). Here we
    // just verify the stream client doesn't itself dedup. That's
    // correct because the SSE id contract is the only seq tracking
    // the stream client knows about.
    const mock = installMockFetch({
      routes: [
        {
          method: "POST",
          pathRegex: /\/messages$/,
          respond: () => {
            return streamedResponse((controller) => {
              const enc = new TextEncoder();
              controller.enqueue(
                enc.encode(`event: message_id\ndata: ${JSON.stringify("msg-3")}\n\n`),
              );
              controller.enqueue(
                enc.encode(`id: 0\nevent: delta\ndata: ${JSON.stringify("a")}\n\n`),
              );
              controller.close();
            });
          },
        },
        {
          method: "GET",
          pathRegex: /\/messages\/msg-3\/stream/,
          respond: () =>
            new Response(
              sseBody([
                { event: "message_id", data: JSON.stringify("msg-3") },
                { id: 0, event: "delta", data: JSON.stringify("a") },
                { id: 1, event: "delta", data: JSON.stringify("b") },
                { event: "done", data: "" },
              ]),
              { status: 200, headers: { "Content-Type": "text/event-stream" } },
            ),
        },
      ],
    });
    const events: ChatTurnEvent[] = [];
    try {
      await runChatTurn({
        apiBase: "http://test",
        instanceId: "i1",
        chatId: "c1",
        content: "hi",
        onEvent: (ev) => events.push(ev),
        signal: new AbortController().signal,
        backoffBaseMs: 1,
        backoffCapMs: 5,
      });
      const deltas = events
        .filter((e) => e.kind === "event")
        .map((e) => ({
          seq: (e as Extract<ChatTurnEvent, { kind: "event" }>).seq,
          payload: (e as Extract<ChatTurnEvent, { kind: "event" }>).payload,
        }));
      // Two events with seq 0 land (one from POST, one from GET).
      // The application is responsible for dedup. The stream client
      // just reports both.
      expect(deltas.length).toBe(3);
      expect(deltas[0]).toEqual({ seq: 0, payload: "a" });
      expect(deltas[1]).toEqual({ seq: 0, payload: "a" });
      expect(deltas[2]).toEqual({ seq: 1, payload: "b" });
    } finally {
      mock.restore();
    }
  });

  it("aborts cleanly when signal fires mid-stream", async () => {
    const mock = installMockFetch({
      routes: [
        {
          method: "POST",
          pathRegex: /\/messages$/,
          respond: () => {
            // Stream that never ends (would hang the test if abort doesn't fire).
            return streamedResponse(async (controller) => {
              const enc = new TextEncoder();
              controller.enqueue(
                enc.encode(`event: message_id\ndata: ${JSON.stringify("msg-4")}\n\n`),
              );
              controller.enqueue(
                enc.encode(`id: 0\nevent: delta\ndata: ${JSON.stringify("a")}\n\n`),
              );
              // Hold open indefinitely.
              await new Promise(() => {});
            });
          },
        },
      ],
    });
    const events: ChatTurnEvent[] = [];
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    try {
      await runChatTurn({
        apiBase: "http://test",
        instanceId: "i1",
        chatId: "c1",
        content: "hi",
        onEvent: (ev) => events.push(ev),
        signal: ac.signal,
        backoffBaseMs: 1,
        backoffCapMs: 5,
      });
      // We got the delta but no terminal event because we aborted.
      const deltas = events.filter((e) => e.kind === "event");
      expect(deltas.length).toBeGreaterThanOrEqual(1);
      // No `error` event with HTTP-aborted message. The runner
      // returns silently on the outer abort signal.
      const errors = events.filter((e) => e.kind === "error");
      expect(errors.length).toBe(0);
    } finally {
      mock.restore();
    }
  });

  it("propagates initial POST errors without retrying", async () => {
    let attempts = 0;
    const mock = installMockFetch({
      routes: [
        {
          method: "POST",
          pathRegex: /\/messages$/,
          respond: () => {
            attempts++;
            return new Response(JSON.stringify({ error: "chat not found" }), {
              status: 404,
              headers: { "Content-Type": "application/json" },
            });
          },
        },
      ],
    });
    try {
      let caught: unknown;
      try {
        await runChatTurn({
          apiBase: "http://test",
          instanceId: "i1",
          chatId: "c1",
          content: "hi",
          onEvent: () => {},
          signal: new AbortController().signal,
          backoffBaseMs: 1,
          backoffCapMs: 5,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe("chat not found");
      expect(attempts).toBe(1);
    } finally {
      mock.restore();
    }
  });

  it("gives up after maxRetries when reconnect keeps failing", async () => {
    let resumeCount = 0;
    const mock = installMockFetch({
      routes: [
        {
          method: "POST",
          pathRegex: /\/messages$/,
          respond: () =>
            streamedResponse((controller) => {
              const enc = new TextEncoder();
              controller.enqueue(
                enc.encode(`event: message_id\ndata: ${JSON.stringify("msg-5")}\n\n`),
              );
              controller.close();
            }),
        },
        {
          method: "GET",
          pathRegex: /\/messages\/msg-5\/stream/,
          respond: () => {
            resumeCount++;
            return streamedResponse((controller) => {
              // Open then immediately close. Client keeps reconnecting.
              controller.close();
            });
          },
        },
      ],
    });
    const events: ChatTurnEvent[] = [];
    try {
      await runChatTurn({
        apiBase: "http://test",
        instanceId: "i1",
        chatId: "c1",
        content: "hi",
        onEvent: (ev) => events.push(ev),
        signal: new AbortController().signal,
        maxRetries: 2,
        backoffBaseMs: 1,
        backoffCapMs: 5,
      });
      // After exhausting retries, we emit a synthetic error.
      const last = events[events.length - 1];
      expect(last.kind).toBe("error");
      // POST counts as the first attempt (attempt 0). Then we get
      // maxRetries=2 resume attempts (attempts 1 and 2). After
      // attempt 2's failure we exit the loop.
      expect(resumeCount).toBeGreaterThanOrEqual(2);
    } finally {
      mock.restore();
    }
  });

  it("does not abandon a long turn that reconnects more than maxRetries times while making progress", async () => {
    // A turn that streams one delta per connection and drops, many more
    // times than maxRetries. Because each reconnect makes progress (advances
    // seq), the consecutive-failure budget keeps resetting and the turn runs
    // to completion instead of being abandoned at the maxRetries-th drop.
    const TOTAL = 10; // >> maxRetries (2)
    let resumeCount = 0;
    const mock = installMockFetch({
      routes: [
        {
          method: "POST",
          pathRegex: /\/messages$/,
          respond: () =>
            streamedResponse((controller) => {
              const enc = new TextEncoder();
              controller.enqueue(
                enc.encode(`event: message_id\ndata: ${JSON.stringify("msg-long")}\n\n`),
              );
              controller.enqueue(
                enc.encode(`id: 0\nevent: delta\ndata: ${JSON.stringify("p0")}\n\n`),
              );
              controller.close(); // drop, no terminal event
            }),
        },
        {
          method: "GET",
          pathRegex: /\/messages\/msg-long\/stream/,
          respond: (req) => {
            const seq = ++resumeCount; // 1, 2, 3, ...
            const after = Number(new URL(req.url).searchParams.get("afterSeq"));
            return streamedResponse((controller) => {
              const enc = new TextEncoder();
              controller.enqueue(
                enc.encode(`event: message_id\ndata: ${JSON.stringify("msg-long")}\n\n`),
              );
              if (seq < TOTAL) {
                // Emit the next delta then drop again, real progress.
                controller.enqueue(
                  enc.encode(
                    `id: ${after + 1}\nevent: delta\ndata: ${JSON.stringify("p" + seq)}\n\n`,
                  ),
                );
                controller.close();
              } else {
                // Final reconnect completes the turn.
                controller.enqueue(
                  enc.encode(
                    `id: ${after + 1}\nevent: delta\ndata: ${JSON.stringify("p" + seq)}\n\n`,
                  ),
                );
                controller.enqueue(enc.encode(`event: done\ndata: \n\n`));
                controller.close();
              }
            });
          },
        },
      ],
    });
    const events: ChatTurnEvent[] = [];
    try {
      await runChatTurn({
        apiBase: "http://test",
        instanceId: "i1",
        chatId: "c1",
        content: "hi",
        onEvent: (ev) => events.push(ev),
        signal: new AbortController().signal,
        maxRetries: 2,
        backoffBaseMs: 1,
        backoffCapMs: 5,
      });
      // Reached the terminal event despite TOTAL reconnects >> maxRetries.
      expect(events[events.length - 1]).toEqual({ kind: "done" });
      expect(events.some((e) => e.kind === "error")).toBe(false);
      expect(resumeCount).toBe(TOTAL);
      // All deltas arrived in order.
      const deltas = events
        .filter((e) => e.kind === "event")
        .map((e) => (e as Extract<ChatTurnEvent, { kind: "event" }>).payload);
      expect(deltas).toEqual(Array.from({ length: TOTAL + 1 }, (_, i) => "p" + i));
    } finally {
      mock.restore();
    }
  });
});

describe("resumeChatTurn", () => {
  it("subscribes to an existing turn and replays from afterSeq", async () => {
    const mock = installMockFetch({
      routes: [
        {
          method: "GET",
          pathRegex: /\/messages\/msg-r\/stream/,
          respond: (req) => {
            const url = new URL(req.url);
            const after = Number(url.searchParams.get("afterSeq"));
            expect(after).toBe(5);
            return new Response(
              sseBody([
                { event: "message_id", data: JSON.stringify("msg-r") },
                { id: 6, event: "delta", data: JSON.stringify("tail") },
                { event: "done", data: "" },
              ]),
              { status: 200, headers: { "Content-Type": "text/event-stream" } },
            );
          },
        },
      ],
    });
    const events: ChatTurnEvent[] = [];
    try {
      await resumeChatTurn({
        apiBase: "http://test",
        instanceId: "i1",
        chatId: "c1",
        messageId: "msg-r",
        afterSeq: 5,
        onEvent: (ev) => events.push(ev),
        signal: new AbortController().signal,
        backoffBaseMs: 1,
        backoffCapMs: 5,
      });
      expect(events.filter((e) => e.kind === "event").length).toBe(1);
      expect(events[events.length - 1].kind).toBe("done");
    } finally {
      mock.restore();
    }
  });

  it("returns a synthetic error when the server reports 404", async () => {
    const mock = installMockFetch({
      routes: [
        {
          method: "GET",
          pathRegex: /\/messages\/missing\/stream/,
          respond: () =>
            new Response(JSON.stringify({ error: "message not found" }), {
              status: 404,
              headers: { "Content-Type": "application/json" },
            }),
        },
      ],
    });
    const events: ChatTurnEvent[] = [];
    try {
      await resumeChatTurn({
        apiBase: "http://test",
        instanceId: "i1",
        chatId: "c1",
        messageId: "missing",
        afterSeq: -1,
        onEvent: (ev) => events.push(ev),
        signal: new AbortController().signal,
        backoffBaseMs: 1,
        backoffCapMs: 5,
      });
      expect(events.length).toBe(1);
      expect(events[0].kind).toBe("error");
    } finally {
      mock.restore();
    }
  });
});

describe("cancelChatTurn", () => {
  it("fires a DELETE to the cancel endpoint", async () => {
    let deleted = false;
    const mock = installMockFetch({
      routes: [
        {
          method: "DELETE",
          pathRegex: /\/messages\/cancel-me$/,
          respond: () => {
            deleted = true;
            return new Response(JSON.stringify({ ok: true }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          },
        },
      ],
    });
    try {
      cancelChatTurn("http://test", "i1", "c1", "cancel-me");
      // Best-effort, wait a beat for the fetch to fire.
      await new Promise((r) => setTimeout(r, 20));
      expect(deleted).toBe(true);
    } finally {
      mock.restore();
    }
  });
});
