// SSE parser, shared by the web client (chat turn streams) and the server
// (the sandbox build / registry-gc streams). Spec-compliant in the ways that
// have bitten us before:
//
//   * Multi-line `data:` is concatenated with newlines, then dispatched
//     when the event terminates (blank line or end-of-stream).
//   * The "event" buffer resets on the dispatch of each event, not just
//     after we see a `data:` line.
//   * Lines without a colon are treated as field names with empty
//     values (per spec).
//   * Comments (lines starting with `:`) are ignored entirely.
//   * The TextDecoder is flushed at end-of-stream so trailing
//     multi-byte UTF-8 isn't truncated.
//   * Buffer size is capped so a producer that forgets to send `\n`
//     can't OOM the consumer.
//
// The optional `idleTimeoutMs` makes `reader.read()` reject when no
// bytes have flowed in for that long (pass 0 to disable, for streams that
// legitimately sit silent, e.g. builds). The chat server emits `:`
// heartbeats so any healthy connection refreshes the timer cheaply.

export interface SseEvent {
  // Empty string when the server didn't send an `event:` field.
  // Spec default is "message", but our protocol always names events.
  event: string;
  data: string;
  // Server's `id:` field, when present. Used by the chat client to
  // track `afterSeq` for reconnects.
  id: string | null;
}

export interface ParseSseOptions {
  // Reject with `SseIdleTimeoutError` if no bytes are read for this
  // many ms. Resets on every chunk, including heartbeat comments.
  idleTimeoutMs?: number;
  // Cap the internal line buffer. Malformed servers that forget to
  // emit `\n` could otherwise grow the buffer unboundedly.
  maxLineBytes?: number;
  // External abort signal. When it fires, the next read returns done
  // and the generator exits. parseSse owns the reader, so this is the
  // only way for a caller to wake it cleanly.
  signal?: AbortSignal;
}

export class SseIdleTimeoutError extends Error {
  constructor(ms: number) {
    super(`no SSE bytes for ${ms}ms`);
    this.name = "SseIdleTimeoutError";
  }
}

export class SseBufferOverflowError extends Error {
  constructor(limit: number) {
    super(`SSE line buffer exceeded ${limit} bytes without a newline`);
    this.name = "SseBufferOverflowError";
  }
}

const DEFAULT_IDLE_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_LINE_BYTES = 16 * 1024 * 1024;

// Async generator that yields one SSE event per dispatch. Reads from
// the response body until it ends or an error fires. The caller is
// responsible for `reader.cancel()` if it abandons the iteration
// early, but as long as the caller iterates to completion (or breaks
// out of a for-await), the generator's finally block cleans up.
export async function* parseSse(
  stream: ReadableStream<Uint8Array>,
  opts: ParseSseOptions = {},
): AsyncGenerator<SseEvent> {
  const idleMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const maxLineBytes = opts.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let eventName = "";
  let dataLines: string[] = [];
  let eventId: string | null = null;

  const dispatch = (): SseEvent | null => {
    // Per spec, an event with no `data:` lines is discarded. We also
    // reset the buffered fields after dispatch, success or not.
    if (dataLines.length === 0) {
      eventName = "";
      eventId = null;
      return null;
    }
    const ev: SseEvent = {
      event: eventName,
      data: dataLines.join("\n"),
      id: eventId,
    };
    eventName = "";
    dataLines = [];
    eventId = null;
    return ev;
  };

  // One read with the idle watchdog AND optional external abort.
  // Returns the chunk, or throws SseIdleTimeoutError on idle, or
  // returns a synthetic `done` result on external abort. (Typed
  // structurally rather than as ReadableStreamReadResult because the DOM
  // and Bun lib definitions of that type disagree on `value`'s optionality.)
  const readWithIdle = (): Promise<{ done: boolean; value?: Uint8Array }> => {
    if (opts.signal?.aborted) {
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };
      const t =
        idleMs > 0
          ? setTimeout(() => {
              settle(() => {
                try {
                  void reader.cancel();
                } catch {}
                reject(new SseIdleTimeoutError(idleMs));
              });
            }, idleMs)
          : null;
      const onAbort = () => {
        settle(() => {
          if (t) clearTimeout(t);
          try {
            void reader.cancel();
          } catch {}
          resolve({ done: true, value: undefined });
        });
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      reader.read().then(
        (r) => {
          settle(() => {
            if (t) clearTimeout(t);
            opts.signal?.removeEventListener("abort", onAbort);
            resolve(r);
          });
        },
        (err) => {
          settle(() => {
            if (t) clearTimeout(t);
            opts.signal?.removeEventListener("abort", onAbort);
            reject(err);
          });
        },
      );
    });
  };

  try {
    while (true) {
      const { done, value } = await readWithIdle();
      if (done) {
        // Flush the decoder for trailing multi-byte UTF-8.
        buf += dec.decode();
        if (buf.length > 0) {
          // Last line of the stream isn't newline-terminated, so treat
          // it as a final line for completeness.
          const line = buf;
          buf = "";
          const ev = handleLine(line);
          if (ev) yield ev;
        }
        // End-of-stream also terminates any pending event (per spec,
        // sort of. Strict reading is that we only dispatch on blank
        // lines, but the live producer often closes without a trailing
        // blank line and we don't want to drop the last event).
        const ev = dispatch();
        if (ev) yield ev;
        return;
      }
      buf += dec.decode(value, { stream: true });
      if (buf.length > maxLineBytes) {
        throw new SseBufferOverflowError(maxLineBytes);
      }
      // Split off complete lines. Keep the trailing (potentially
      // partial) fragment in `buf` for the next iteration. Handle
      // CRLF and bare LF. CR-only is rare in SSE and we ignore it.
      const parts = buf.split("\n");
      buf = parts.pop()!;
      for (const raw of parts) {
        const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
        const ev = handleLine(line);
        if (ev) yield ev;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }

  function handleLine(line: string): SseEvent | null {
    if (line === "") {
      // Blank line, so dispatch the buffered event.
      return dispatch();
    }
    if (line.startsWith(":")) {
      // Comment / heartbeat. Ignored.
      return null;
    }
    const colon = line.indexOf(":");
    let field: string;
    let value: string;
    if (colon === -1) {
      field = line;
      value = "";
    } else {
      field = line.slice(0, colon);
      // Spec: skip exactly one leading space after the colon.
      value = line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
    }
    switch (field) {
      case "event":
        eventName = value;
        return null;
      case "data":
        dataLines.push(value);
        return null;
      case "id":
        eventId = value;
        return null;
      case "retry":
        // We do our own retry timing, so ignore the server's hint.
        return null;
      default:
        // Unknown fields are ignored per spec.
        return null;
    }
  }
}
