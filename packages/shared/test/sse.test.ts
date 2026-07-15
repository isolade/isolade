import { describe, expect, it } from "bun:test";
import { parseSse, SseBufferOverflowError, SseIdleTimeoutError } from "../src/sse";

// Build a ReadableStream from an array of byte chunks. Each chunk is
// pushed before the next one is enqueued, simulating exactly the
// fragmentation pattern we care about (frame boundaries can land
// anywhere in the SSE wire format).
function streamFrom(
  chunks: (string | Uint8Array)[],
  opts: { delayMs?: number } = {},
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    async pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      if (opts.delayMs && opts.delayMs > 0) {
        await new Promise((r) => setTimeout(r, opts.delayMs));
      }
      const chunk = chunks[i++];
      controller.enqueue(typeof chunk === "string" ? enc.encode(chunk) : chunk);
    },
  });
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of gen) out.push(x);
  return out;
}

describe("parseSse", () => {
  it("parses a basic event", async () => {
    const stream = streamFrom(["event: msg\ndata: hello\n\n"]);
    const events = await collect(parseSse(stream));
    expect(events).toEqual([{ event: "msg", data: "hello", id: null }]);
  });

  it("survives frame boundaries inside an event", async () => {
    // Split right after 'event: msg\n' so the 'data:' line arrives in
    // a separate chunk. The old hand-rolled parser was correct for
    // this case but only because of the buf-keeps-tail invariant,
    // worth nailing down regardless.
    const stream = streamFrom(["event: msg\n", "data: hello\n\n"]);
    const events = await collect(parseSse(stream));
    expect(events).toEqual([{ event: "msg", data: "hello", id: null }]);
  });

  it("splits a single line across frame boundaries", async () => {
    // The juiciest case: the data line itself is split mid-token. The
    // parser must buffer the partial line and only dispatch on \n.
    const stream = streamFrom(["event: msg\nda", "ta: hel", "lo\n\n"]);
    const events = await collect(parseSse(stream));
    expect(events).toEqual([{ event: "msg", data: "hello", id: null }]);
  });

  it("supports multi-line data per spec", async () => {
    // Per spec, repeated data: fields concatenate with newlines.
    const stream = streamFrom(["event: msg\ndata: line1\ndata: line2\n\n"]);
    const events = await collect(parseSse(stream));
    expect(events).toEqual([{ event: "msg", data: "line1\nline2", id: null }]);
  });

  it("parses event ids", async () => {
    const stream = streamFrom(["id: 42\nevent: delta\ndata: x\n\n"]);
    const events = await collect(parseSse(stream));
    expect(events).toEqual([{ event: "delta", data: "x", id: "42" }]);
  });

  it("ignores comment lines (heartbeats)", async () => {
    const stream = streamFrom([": keepalive\nevent: msg\ndata: hi\n\n"]);
    const events = await collect(parseSse(stream));
    expect(events).toEqual([{ event: "msg", data: "hi", id: null }]);
  });

  it("ignores lines without a colon by treating them as field-only", async () => {
    // Spec allows "field-only" lines like "data\n", equivalent to "data:\n".
    // Our parser should consume them without crashing.
    const stream = streamFrom(["data\ndata: hello\n\n"]);
    const events = await collect(parseSse(stream));
    // First "data" is field-only → empty string; gets joined with "hello".
    expect(events).toEqual([{ event: "", data: "\nhello", id: null }]);
  });

  it("dispatches the last event even without a trailing blank line", async () => {
    // Real producers often close the stream right after the last data
    // line without a final blank. We accept that as a flush.
    const stream = streamFrom(["event: done\ndata: \n"]);
    const events = await collect(parseSse(stream));
    expect(events).toEqual([{ event: "done", data: "", id: null }]);
  });

  it("flushes the TextDecoder at EOF for trailing multi-byte chars", async () => {
    // Construct a stream that splits a 3-byte UTF-8 char ("世") across
    // two chunks. The parser must call decode() with stream:true on
    // the first chunk and flush on EOF.
    const enc = new TextEncoder();
    const bytes = enc.encode("event: msg\ndata: 世\n\n");
    // Split inside the multi-byte char.
    const split = 16; // 'event: msg\ndata: ' is 16 bytes? Let's verify by computing
    const partA = bytes.slice(0, split + 1); // first half includes 1 byte of '世'
    const partB = bytes.slice(split + 1);
    const stream = streamFrom([partA, partB]);
    const events = await collect(parseSse(stream));
    expect(events).toEqual([{ event: "msg", data: "世", id: null }]);
  });

  it("resets event name between dispatches", async () => {
    // Two events back-to-back. The second one has no event: line so
    // it should default to "" rather than inherit "first".
    const stream = streamFrom(["event: first\ndata: one\n\ndata: two\n\n"]);
    const events = await collect(parseSse(stream));
    expect(events).toEqual([
      { event: "first", data: "one", id: null },
      { event: "", data: "two", id: null },
    ]);
  });

  it("rejects on idle timeout", async () => {
    // Stream that produces one chunk, then never another. The parser
    // should reject with SseIdleTimeoutError within idleTimeoutMs.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("event: msg\ndata: hi\n\n"));
        // Never close.
      },
    });
    const gen = parseSse(stream, { idleTimeoutMs: 100 });
    // First event arrives.
    const first = await gen.next();
    expect(first.value).toEqual({ event: "msg", data: "hi", id: null });
    // Second read times out.
    let caught: unknown;
    try {
      await gen.next();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SseIdleTimeoutError);
  });

  it("throws on unbounded buffer", async () => {
    // 100 chars without a newline, capped at 50.
    const stream = streamFrom(["x".repeat(100)]);
    let caught: unknown;
    try {
      await collect(parseSse(stream, { maxLineBytes: 50 }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SseBufferOverflowError);
  });

  it("handles CRLF line endings", async () => {
    const stream = streamFrom(["event: msg\r\ndata: hi\r\n\r\n"]);
    const events = await collect(parseSse(stream));
    expect(events).toEqual([{ event: "msg", data: "hi", id: null }]);
  });

  it("strips exactly one leading space after the colon", async () => {
    // "data:hi" -> "hi"
    // "data: hi" -> "hi"
    // "data:  hi" -> " hi" (one space stripped, one kept)
    const stream = streamFrom([
      "event: a\ndata:hi\n\n",
      "event: b\ndata: hi\n\n",
      "event: c\ndata:  hi\n\n",
    ]);
    const events = await collect(parseSse(stream));
    expect(events).toEqual([
      { event: "a", data: "hi", id: null },
      { event: "b", data: "hi", id: null },
      { event: "c", data: " hi", id: null },
    ]);
  });

  it("ignores the retry: field", async () => {
    // Server may emit retry hints, but we do our own retry logic so they
    // shouldn't surface as events.
    const stream = streamFrom(["retry: 5000\nevent: msg\ndata: ok\n\n"]);
    const events = await collect(parseSse(stream));
    expect(events).toEqual([{ event: "msg", data: "ok", id: null }]);
  });
});
