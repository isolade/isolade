import { parseSse, type SseEvent } from "@isolade/shared";
import { apiFetch } from "./api";
import { type ChatMessage, chatMessageSchema, errorResponseSchema } from "./contracts";

// Logical events the chat client cares about, decoded from the raw SSE
// frames. `done`/`error` are terminal. Once one fires, the caller's
// onEvent will not be called again. `user_message` is the persisted user
// message row this turn replies to, sent as the first frame of the two POST
// paths (send, edit) so the caller can reconcile its optimistic bubble with
// the server-assigned id and tree position.
export type ChatTurnEvent =
  | { kind: "message_id"; messageId: string }
  | { kind: "user_message"; message: ChatMessage }
  | { kind: "event"; type: string; payload: unknown; seq: number }
  | { kind: "done" }
  | { kind: "error"; message: string };

export interface RunChatTurnOptions {
  apiBase: string;
  instanceId: string;
  chatId: string;
  content: string;
  // When set, the turn is an *edit* of this user message: the server inserts
  // the content as a sibling version and recomputes the answer from that
  // point (same SSE stream shape as a normal send).
  editMessageId?: string;
  // Caller-visible hook fired once per logical event. `seq` is the
  // server-assigned monotonic number. The caller should ignore events
  // with seq <= the last applied one (the reconnect path passes
  // `afterSeq` so the server is supposed to not re-send those, but
  // we're defensive).
  onEvent: (event: ChatTurnEvent) => void;
  // Aborts the entire turn loop. Different from the per-attempt
  // AbortController we manage internally. When this fires, we stop
  // retrying and exit. The Stop button uses cancelChatTurn() to also
  // tell the server to abort the producer.
  signal: AbortSignal;
  // Knobs, mostly for tests.
  maxRetries?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  idleTimeoutMs?: number;
}

// Default retry budget: covers brief WiFi flaps and laptop sleep
// resume without retrying forever on a permanently-broken server.
const DEFAULT_MAX_RETRIES = 8;
const DEFAULT_BACKOFF_BASE_MS = 500;
const DEFAULT_BACKOFF_CAP_MS = 10_000;
// Reject a stalled stream after this long without bytes. The chat server sends
// `:` heartbeats, so any healthy connection refreshes the watchdog well inside
// this window. A real network drop trips it and we reconnect.
const DEFAULT_IDLE_TIMEOUT_MS = 45_000;

function jitter(ms: number): number {
  return ms * (0.5 + Math.random());
}

// Jittered exponential backoff for the Nth consecutive failure (1-based),
// capped. `failures` is the consecutive-failure count, so a fresh failure
// after progress backs off from the base again rather than from wherever the
// turn's lifetime attempt counter happened to be.
function backoffFor(failures: number, baseMs: number, capMs: number): number {
  const exponent = Math.max(0, failures - 1);
  return Math.min(capMs, jitter(baseMs * 2 ** exponent));
}

async function extractErrorMessage(resp: Response): Promise<string> {
  let message = `HTTP ${resp.status}`;
  try {
    message = errorResponseSchema.parse(await resp.json()).error;
  } catch {}
  return message;
}

// Open the initial POST and stream until it ends, an error fires, or
// the connection drops. On clean termination (terminal `done`/`error`
// event seen) the promise resolves with `{ terminated: true }`. On a
// recoverable disconnect (network error, idle timeout, body ended
// without a terminal event) it resolves with `{ terminated: false,
// messageId, lastSeq }` so the caller can decide whether to retry.
//
// The caller's `onEvent` sees every logical event, including the
// terminal one. Reconnect attempts pass the same onEvent so the caller
// can stay agnostic to whether bytes came from POST or a resume GET.
interface AttemptResult {
  terminated: boolean;
  messageId: string | null;
  lastSeq: number;
}

async function streamFromResponse(
  resp: Response,
  initialMessageId: string | null,
  initialLastSeq: number,
  onEvent: (event: ChatTurnEvent) => void,
  signal: AbortSignal,
  idleTimeoutMs: number,
): Promise<AttemptResult> {
  if (!resp.body) {
    throw new Error("missing response body");
  }
  let messageId = initialMessageId;
  let lastSeq = initialLastSeq;
  let terminated = false;

  if (signal.aborted) {
    return { terminated: false, messageId, lastSeq };
  }

  for await (const raw of parseSse(resp.body, { idleTimeoutMs, signal })) {
    const decoded = decodeSseEvent(raw);
    if (!decoded) continue;
    if (decoded.kind === "message_id") {
      messageId = decoded.messageId;
      onEvent(decoded);
      continue;
    }
    if (decoded.kind === "user_message") {
      onEvent(decoded);
      continue;
    }
    if (decoded.kind === "event") {
      if (decoded.seq > lastSeq) lastSeq = decoded.seq;
      onEvent(decoded);
      continue;
    }
    // Terminal.
    onEvent(decoded);
    terminated = true;
    break;
  }
  return { terminated, messageId, lastSeq };
}

// Translate one raw SSE frame to a ChatTurnEvent. Unknown event names
// flow through as `event` with raw string payload, and the chat UI's
// existing "unknown sse" handling renders them as raw debug chunks.
function decodeSseEvent(ev: SseEvent): ChatTurnEvent | null {
  if (ev.event === "" || ev.event === "ping") {
    // Heartbeat or untyped: server uses "ping" for keepalive.
    return null;
  }
  if (ev.event === "message_id") {
    let messageId: string;
    try {
      messageId = JSON.parse(ev.data) as string;
    } catch (err) {
      // The server JSON.stringify-s every SSE data field. A bare
      // string here suggests version skew with an older server build,
      // so fall back, but log so the mismatch is visible.
      console.warn("[chat] message_id frame is not JSON, using raw value:", err);
      messageId = ev.data;
    }
    return { kind: "message_id", messageId };
  }
  if (ev.event === "user_message") {
    // The persisted user-message row. Parse defensively: a malformed frame
    // (version skew) just means the caller keeps its optimistic bubble, and
    // the next hydration reconciles ids anyway.
    try {
      return { kind: "user_message", message: chatMessageSchema.parse(JSON.parse(ev.data)) };
    } catch (err) {
      console.warn("[chat] unparseable user_message frame, ignoring:", err);
      return null;
    }
  }
  if (ev.event === "done") return { kind: "done" };
  if (ev.event === "error") return { kind: "error", message: ev.data };
  let payload: unknown;
  try {
    payload = JSON.parse(ev.data);
  } catch {
    payload = ev.data;
  }
  // SSE `id:` is the server's seq when present. Falls back to -1
  // (i.e. "no resume cursor advance") so seqless events don't make us
  // skip future ones.
  const seq = ev.id !== null && ev.id !== "" ? Number(ev.id) : -1;
  return {
    kind: "event",
    type: ev.event,
    payload,
    seq: Number.isFinite(seq) ? seq : -1,
  };
}

// Top-level: send a new user message and stream the assistant turn.
// On recoverable disconnects, reconnect to the resume endpoint with
// the last seen seq until terminated or retry budget exhausted. Throws
// only if every attempt fails AND we never got a messageId (i.e. the
// initial POST itself never made it).
export async function runChatTurn(opts: RunChatTurnOptions): Promise<void> {
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const backoffBase = opts.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const backoffCap = opts.backoffCapMs ?? DEFAULT_BACKOFF_CAP_MS;
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

  let messageId: string | null = null;
  let lastSeq = -1;

  // Initial attempt = POST. Subsequent attempts = GET resume. We
  // surface fatal early errors (chat doesn't exist, etc) by throwing,
  // since those aren't recoverable so we don't waste retries.
  const post = async (): Promise<Response> => {
    const base = `${opts.apiBase}/api/instances/${opts.instanceId}/chats/${opts.chatId}/messages`;
    const url = opts.editMessageId ? `${base}/${opts.editMessageId}/edit` : base;
    const resp = await apiFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: opts.content }),
      signal: opts.signal,
    });
    if (!resp.ok) {
      const msg = await extractErrorMessage(resp);
      throw new Error(msg);
    }
    return resp;
  };

  const resume = async (mid: string, afterSeq: number): Promise<Response> => {
    const qs = `?afterSeq=${encodeURIComponent(String(afterSeq))}`;
    const resp = await apiFetch(
      `${opts.apiBase}/api/instances/${opts.instanceId}/chats/${opts.chatId}/messages/${mid}/stream${qs}`,
      { signal: opts.signal },
    );
    if (!resp.ok) {
      const msg = await extractErrorMessage(resp);
      throw new Error(msg);
    }
    return resp;
  };

  // `failures` is the count of *consecutive* failed attempts, reset to 0
  // whenever an attempt makes progress (learns the messageId or advances
  // lastSeq). The retry budget is therefore "N failures in a row", not "N
  // disconnects over the turn's life", so a long turn (subagents, big
  // tasks) that reconnects many times while genuinely streaming is never
  // abandoned mid-flight. Backoff scales with the consecutive-failure count.
  let failures = 0;
  while (failures <= maxRetries) {
    if (opts.signal.aborted) return;
    let resp: Response;
    try {
      if (messageId === null) {
        resp = await post();
      } else {
        resp = await resume(messageId, lastSeq);
      }
    } catch (err) {
      // Couldn't even open the connection. If we have a messageId,
      // treat this as a recoverable disconnect and back off. Without
      // one, the initial POST failed, so surface the error to the
      // caller, nothing to resume.
      if (messageId === null) throw err;
      if (opts.signal.aborted) return;
      failures++;
      await delay(backoffFor(failures, backoffBase, backoffCap), opts.signal);
      continue;
    }

    const seqBefore = lastSeq;
    const hadMessageId = messageId !== null;
    let result: AttemptResult;
    try {
      result = await streamFromResponse(
        resp,
        messageId,
        lastSeq,
        opts.onEvent,
        opts.signal,
        idleTimeoutMs,
      );
    } catch (err) {
      // Body read failed (network drop, idle timeout, decoder error).
      // Without a messageId there's nothing for the resume endpoint to
      // find, so we'd loop forever, so bail out (covers idle timeout and
      // any other read error on the initial POST) so the UI shows a
      // clear failure.
      if (opts.signal.aborted) return;
      if (messageId === null) throw err;
      failures++;
      await delay(backoffFor(failures, backoffBase, backoffCap), opts.signal);
      continue;
    }

    // Result may have learned a messageId mid-attempt (the very first
    // POST sees `message_id` as event #1) or advanced lastSeq.
    messageId = result.messageId;
    lastSeq = result.lastSeq;

    if (result.terminated) return;
    // Body ended without a terminal event: server-side disconnect,
    // proxy timeout, etc. Retry if we have something to resume from.
    if (messageId === null) {
      throw new Error("stream ended before any message_id event");
    }
    const madeProgress = lastSeq > seqBefore || (!hadMessageId && messageId !== null);
    failures = madeProgress ? 0 : failures + 1;
    await delay(backoffFor(failures, backoffBase, backoffCap), opts.signal);
  }

  // Exhausted retries without termination. Surface an error to the
  // caller's onEvent so it can render a final state.
  opts.onEvent({
    kind: "error",
    message: "lost connection to chat stream after multiple retries",
  });
}

// Resolve after `ms`, or early (resolved, not rejected) if the signal aborts.
// Callers re-check `signal.aborted` after awaiting, so an aborted wait just
// short-circuits the backoff.
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// Best-effort fire-and-forget cancel for the Stop button. We don't
// wait for the response, since the abort signal is plenty to tear down the
// local stream loop, and the server's DELETE just speeds up the CLI
// cleanup. Network/HTTP errors are non-actionable for the UI (the
// abort already happened locally), but we still attach a .catch
// handler so a failing cancel shows up in the console instead of
// becoming an unhandled rejection.
export function cancelChatTurn(
  apiBase: string,
  instanceId: string,
  chatId: string,
  messageId: string,
): void {
  try {
    void apiFetch(`${apiBase}/api/instances/${instanceId}/chats/${chatId}/messages/${messageId}`, {
      method: "DELETE",
      keepalive: true,
    }).catch((err) => {
      console.warn(`[chat] cancel request failed for ${messageId}:`, err);
    });
  } catch (err) {
    // Synchronous throw from fetch is rare (invalid URL) and would
    // indicate a programming error, so log instead of silently dropping.
    console.warn(`[chat] cancel fetch threw synchronously for ${messageId}:`, err);
  }
}

// Reconnect to an in-flight turn after a page reload. The chat UI
// figures out the messageId by looking at the events log (most-recent
// event whose messageId has no chat_message row). `afterSeq` is the
// last seq the client has applied. Pass -1 to ask for everything.
export interface ResumeChatTurnOptions {
  apiBase: string;
  instanceId: string;
  chatId: string;
  messageId: string;
  afterSeq: number;
  onEvent: (event: ChatTurnEvent) => void;
  signal: AbortSignal;
  maxRetries?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  idleTimeoutMs?: number;
}

export async function resumeChatTurn(opts: ResumeChatTurnOptions): Promise<void> {
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const backoffBase = opts.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const backoffCap = opts.backoffCapMs ?? DEFAULT_BACKOFF_CAP_MS;
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

  let lastSeq = opts.afterSeq;

  // As in runChatTurn: count *consecutive* failures, reset on progress, so a
  // long in-flight turn we're tailing after a reload isn't dropped just
  // because it outlived the retry budget.
  let failures = 0;
  while (failures <= maxRetries) {
    if (opts.signal.aborted) return;
    let resp: Response;
    try {
      resp = await apiFetch(
        `${opts.apiBase}/api/instances/${opts.instanceId}/chats/${opts.chatId}/messages/${opts.messageId}/stream?afterSeq=${encodeURIComponent(String(lastSeq))}`,
        { signal: opts.signal },
      );
    } catch (err) {
      if (opts.signal.aborted) return;
      failures++;
      console.warn(
        `[chat] resume fetch failure ${failures}/${maxRetries + 1} for ${opts.messageId}:`,
        err,
      );
      await delay(backoffFor(failures, backoffBase, backoffCap), opts.signal);
      continue;
    }
    if (!resp.ok) {
      // 404 means the server has no record of this turn, so nothing to
      // resume. Surface as an error.
      if (resp.status === 404) {
        opts.onEvent({ kind: "error", message: "turn not found on server" });
        return;
      }
      failures++;
      await delay(backoffFor(failures, backoffBase, backoffCap), opts.signal);
      continue;
    }
    const seqBefore = lastSeq;
    try {
      const result = await streamFromResponse(
        resp,
        opts.messageId,
        lastSeq,
        opts.onEvent,
        opts.signal,
        idleTimeoutMs,
      );
      lastSeq = result.lastSeq;
      if (result.terminated) return;
    } catch (err) {
      if (opts.signal.aborted) return;
      // Body read errors during a resume (idle timeout, decoder
      // overflow, network drop, etc.) are recoverable, so we'll retry
      // the next iteration. Logging keeps the retry observable so a
      // pathologically broken backend doesn't hide behind the retry
      // budget.
      console.warn(
        `[chat] resume failure ${failures + 1}/${maxRetries + 1} for ${opts.messageId}:`,
        err,
      );
    }
    failures = lastSeq > seqBefore ? 0 : failures + 1;
    await delay(backoffFor(failures, backoffBase, backoffCap), opts.signal);
  }
  opts.onEvent({
    kind: "error",
    message: "lost connection to chat stream after multiple retries",
  });
}
