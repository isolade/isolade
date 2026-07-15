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
import type { ChatEvent as BackendChatEvent } from "../src/chat/backend";
import { DEFAULT_ANTHROPIC_MODEL_ID } from "../src/contracts";
import { createTestServer } from "./helpers";

// A controllable fake backend. The constructor takes a "script": a
// list of actions the backend should perform when its sendMessage is
// invoked. Each action either emits a delta, emits an event, throws,
// or waits on an external trigger.
type Action =
  | { kind: "delta"; text: string }
  | { kind: "event"; event: BackendChatEvent }
  | { kind: "wait"; promise: Promise<void> }
  | { kind: "throw"; message: string }
  | { kind: "abortable" }; // returns once abort signal fires

class FakeBackend {
  // One-shot script, pushed onto when a test starts the turn.
  private script: Action[] = [];
  public lastSignal: AbortSignal | null = null;
  public callCount = 0;

  setScript(actions: Action[]) {
    this.script = actions;
  }

  sendMessage = async (opts: {
    vmId: string;
    chatId: string;
    message: string;
    model: string;
    effort: string;
    sessionId?: string;
    signal?: AbortSignal;
    onDelta: (text: string) => void;
    onEvent?: (event: BackendChatEvent) => void;
  }): Promise<{ content: string; sessionId?: string }> => {
    this.callCount++;
    this.lastSignal = opts.signal ?? null;
    let content = "";
    for (const action of this.script) {
      if (opts.signal?.aborted) throw new Error("aborted");
      if (action.kind === "delta") {
        content += action.text;
        opts.onDelta(action.text);
      } else if (action.kind === "event") {
        await opts.onEvent?.(action.event);
      } else if (action.kind === "wait") {
        await action.promise;
      } else if (action.kind === "throw") {
        throw new Error(action.message);
      } else if (action.kind === "abortable") {
        await new Promise<void>((_, reject) => {
          opts.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
      }
    }
    return { content };
  };

  probeContext = async (): Promise<{ available: false; reason: string }> => {
    return { available: false, reason: "fake" };
  };

  // Titles are best-effort, and returning null exercises the truncation fallback,
  // matching how these tests behaved when the host had no credentials.
  generateTitle = async (): Promise<string | null> => {
    return null;
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

describe("chat streaming resilience", () => {
  let baseUrl: string;
  let seedInstance: () => string;
  let chatStreamHub: ReturnType<typeof createTestServer>["chatStreamHub"];
  let chatManager: ReturnType<typeof createTestServer>["chatManager"];
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
    cleanup = server.cleanup;
  });

  afterAll(async () => {
    await cleanup();
  });

  async function makeChat(): Promise<{ instanceId: string; chatId: string }> {
    const instanceId = seedInstance();
    const res = await fetch(`${baseUrl}/api/instances/${instanceId}/chats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: DEFAULT_ANTHROPIC_MODEL_ID }),
    });
    const { id } = (await res.json()) as { id: string };
    return { instanceId, chatId: id };
  }

  it("POST /messages emits message_id, deltas, then done", async () => {
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

    expect(events[0]!.event).toBe("message_id");
    const messageId = JSON.parse(events[0]!.data) as string;
    expect(messageId).toMatch(/^[0-9a-f-]{36}$/);

    const deltaEvents = events.filter((e) => e.event === "delta");
    expect(deltaEvents.length).toBe(2);
    expect(JSON.parse(deltaEvents[0]!.data)).toBe("hello ");
    expect(JSON.parse(deltaEvents[1]!.data)).toBe("world");
    // Each event carries an SSE id with the server-assigned seq.
    expect(deltaEvents[0]!.id).toBe("0");
    expect(deltaEvents[1]!.id).toBe("1");

    expect(events[events.length - 1]!.event).toBe("done");

    // Persisted assistant message.
    const msgs = chatManager.getMessages(chatId);
    expect(msgs.length).toBe(2);
    expect(msgs[1]!.role).toBe("assistant");
    expect(msgs[1]!.content).toBe("hello world");
    expect(msgs[1]!.id).toBe(messageId);
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
    const messageId = JSON.parse(postEvents[0]!.data) as string;

    // Now resume from the start.
    const getRes = await fetch(
      `${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages/${messageId}/stream?afterSeq=-1`,
    );
    expect(getRes.status).toBe(200);
    const { events: getEvents } = await readAllSse(getRes);
    expect(getEvents[0]!.event).toBe("message_id");
    expect(JSON.parse(getEvents[0]!.data)).toBe(messageId);
    const replayedDeltas = getEvents
      .filter((e) => e.event === "delta")
      .map((e) => JSON.parse(e.data));
    expect(replayedDeltas).toEqual(["one", "two"]);
    expect(getEvents[getEvents.length - 1]!.event).toBe("done");
  });

  it("GET resume with afterSeq skips already-applied events", async () => {
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
    const messageId = JSON.parse(postEvents[0]!.data) as string;

    // Resume with afterSeq=0: should only see "b" and "c".
    const getRes = await fetch(
      `${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages/${messageId}/stream?afterSeq=0`,
    );
    const { events } = await readAllSse(getRes);
    const deltas = events.filter((e) => e.event === "delta").map((e) => JSON.parse(e.data));
    expect(deltas).toEqual(["b", "c"]);
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
    const deltas = events.filter((e) => e.event === "delta").map((e) => JSON.parse(e.data));
    expect(deltas).toEqual(["first", "second"]);
    expect(events[events.length - 1]!.event).toBe("done");

    // The backend was invoked exactly once even though there were two
    // subscribers (POST + GET).
    expect(backend.callCount).toBe(beforeCount + 1);

    // Drain the POST body so the fetch doesn't dangle.
    await readAllSse(await postPromise);
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

    const delRes = await fetch(
      `${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages/${messageId}`,
      { method: "DELETE" },
    );
    expect(delRes.status).toBe(200);

    const { events } = await readAllSse(await postPromise);
    // Partial delta was sent, terminal event is `error` ("aborted").
    expect(events.filter((e) => e.event === "delta").map((e) => JSON.parse(e.data))).toEqual([
      "before-cancel",
    ]);
    expect(events[events.length - 1]!.event).toBe("error");
    expect(events[events.length - 1]!.data).toMatch(/aborted/i);

    // Partial assistant message persisted.
    const msgs = chatManager.getMessages(chatId);
    const assistant = msgs.find((m) => m.role === "assistant");
    expect(assistant?.content).toBe("before-cancel");
  });

  it("returns 404 when resuming a totally unknown messageId", async () => {
    const { instanceId, chatId } = await makeChat();
    const res = await fetch(
      `${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages/00000000-0000-0000-0000-000000000000/stream?afterSeq=-1`,
    );
    expect(res.status).toBe(404);
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
    expect(d1).toEqual(["alpha", "beta"]);
    expect(d2).toEqual(["alpha", "beta"]);
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
    const deltas = events.filter((e) => e.event === "delta").map((e) => JSON.parse(e.data));
    expect(deltas).toEqual(["partial-", "content"]);
    expect(events[events.length - 1]!.event).toBe("done");

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
    const deltas = events.filter((e) => e.event === "delta").map((e) => JSON.parse(e.data));
    expect(deltas).toEqual(["before", "after"]);
    expect(events[events.length - 1]!.event).toBe("done");
  });
});
