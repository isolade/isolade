import type { ChatManager } from "../chats";

// One event published during an assistant turn. `seq` is monotonic and
// per-turn (starts at 0). The wire form duplicates the seq into the SSE
// `id:` line so the client can resume from `Last-Event-ID` if it
// disconnects mid-stream.
export interface StreamEvent {
  seq: number;
  type: string;
  payload: unknown;
}

// Signals delivered to subscribers after the producer settles.
export type StreamSignal =
  | { kind: "event"; event: StreamEvent }
  | { kind: "done" }
  | { kind: "error"; message: string };

export type Subscriber = (signal: StreamSignal) => void;

interface Turn {
  chatId: string;
  messageId: string;
  // In-memory event buffer for cheap mid-turn replay. Identical to the
  // chat_events rows we persist alongside. We keep both so a server-side
  // restart still recovers turns from disk.
  events: StreamEvent[];
  subscribers: Set<Subscriber>;
  status: "running" | "done" | { error: string };
  // Producer's cancel token. Aborted when the last subscriber leaves and
  // the grace timer expires, or on explicit cancel().
  cancelController: AbortController;
  // Holds a no-subscriber grace timer. Cleared when a new subscriber
  // attaches. Fires the producer's cancel after `idleCancelMs` if nobody
  // ever shows up.
  graceTimer: ReturnType<typeof setTimeout> | null;
  // Eviction timer scheduled after the producer settles. Keeps the turn
  // in memory for a short window so a slow reconnect can still tail the
  // in-memory buffer instead of falling back to the DB.
  evictionTimer: ReturnType<typeof setTimeout> | null;
}

export interface StartTurnOptions {
  chatId: string;
  messageId: string;
  // Called once with the producer api. The promise resolves on success,
  // rejects on producer error. The producer should not catch its own
  // errors and turn them into events. Let them propagate and the hub
  // will emit an `error` signal.
  run: (api: ProducerApi) => Promise<void>;
}

export interface ProducerApi {
  // Cancellation signal for the producer. The producer should pass this
  // to anything cancellable (HTTP requests to the sandbox, etc).
  signal: AbortSignal;
  // Persist + fan out an event. Returns the assigned seq.
  publish: (type: string, payload: unknown) => number;
}

export interface SubscribeResult {
  unsubscribe: () => void;
}

export interface HubOptions {
  // After the last subscriber detaches, how long to wait before
  // cancelling the producer. The client disconnects its stream whenever
  // the chat view unmounts (not just on reload), so this window also has
  // to span "user switched to another chat and came back", and a turn the
  // user left running is expected to keep going and complete in the
  // background (the sidebar's working/unread indicators depend on it). So
  // it's deliberately generous (default 10m). It is NOT the primary
  // abandonment backstop: in the desktop app the API server is a sidecar
  // the launcher reaps on exit (see parent-watchdog), and an explicit Stop
  // cancels immediately. This timer only reaps turns orphaned in a plain
  // browser/dev session, where running to natural completion is harmless.
  idleCancelMs?: number;
  // How long a settled turn stays in memory before falling back to the
  // DB-only replay path. Default 5 minutes, long enough that even a
  // sleepy reconnect tails the warm buffer.
  evictionMs?: number;
}

const DEFAULT_IDLE_CANCEL_MS = 10 * 60_000;
const DEFAULT_EVICTION_MS = 5 * 60_000;

// In-memory pub/sub for in-flight chat turns. The POST handler that
// starts a turn registers it here. The SSE response itself is just a
// subscriber. Reconnects/multi-tab open additional subscribers.
//
// Persistence remains authoritative. Every publish() writes to
// chat_events first, then fans out. On server restart turns are gone
// from memory. Resume requests fall back to DB replay only.
export class ChatStreamHub {
  private turns = new Map<string, Turn>();
  private readonly idleCancelMs: number;
  private readonly evictionMs: number;

  constructor(
    private readonly chatManager: ChatManager,
    opts: HubOptions = {},
  ) {
    this.idleCancelMs = opts.idleCancelMs ?? DEFAULT_IDLE_CANCEL_MS;
    this.evictionMs = opts.evictionMs ?? DEFAULT_EVICTION_MS;
  }

  // True if a turn for this messageId is currently in memory (running
  // or recently settled). Used by the resume endpoint to decide between
  // hub-tail vs DB-only replay.
  has(messageId: string): boolean {
    return this.turns.has(messageId);
  }

  // Convenience for clients/UI that want to know if anything is currently
  // streaming in a chat without knowing the messageId. Returns the most
  // recent in-flight turn's messageId, if any.
  inFlightFor(chatId: string): string | null {
    for (const turn of this.turns.values()) {
      if (turn.chatId === chatId && turn.status === "running") {
        return turn.messageId;
      }
    }
    return null;
  }

  // The set of instance ids with at least one assistant turn streaming right
  // now. Drives the sidebar's per-instance "working" indicator. Settled turns
  // lingering in memory for reconnect-tailing are excluded, so only `running`.
  // The chat→instance mapping is resolved through the chat manager (a cheap
  // primary-key lookup) so a turn only needs to carry its chatId.
  activeInstanceIds(): Set<string> {
    const ids = new Set<string>();
    for (const turn of this.turns.values()) {
      if (turn.status !== "running") continue;
      const chat = this.chatManager.get(turn.chatId);
      if (chat) ids.add(chat.instanceId);
    }
    return ids;
  }

  // Start a new turn. Throws synchronously if a turn with the same
  // messageId is already registered. The producer runs asynchronously,
  // callers typically subscribe before awaiting any producer events.
  startTurn(opts: StartTurnOptions): void {
    if (this.turns.has(opts.messageId)) {
      throw new Error(`turn already running for messageId ${opts.messageId}`);
    }
    const turn: Turn = {
      chatId: opts.chatId,
      messageId: opts.messageId,
      events: [],
      subscribers: new Set(),
      status: "running",
      cancelController: new AbortController(),
      graceTimer: null,
      evictionTimer: null,
    };
    this.turns.set(opts.messageId, turn);

    const api: ProducerApi = {
      signal: turn.cancelController.signal,
      publish: (type, payload) => this.publish(turn, type, payload),
    };

    // Write a marker row to chat_events the instant the turn is
    // registered, BEFORE the producer fires. Without it there's a
    // window between startTurn() and the producer's first publish()
    // (CLI spawn / RPC handshake, easily hundreds of ms) where the
    // table is empty for this messageId. A client that reconnects in
    // that window sees the chat with a user message but no events,
    // can't detect the in-flight assistant turn, and just sits idle.
    //
    // We bypass publish() because:
    //   - the in-memory turn.events stays clean (producer seqs start at 0),
    //   - there are no subscribers yet to fan out to, and
    //   - seq=-1 is naturally filtered out by getEventsForMessage's
    //     `seq > afterSeq` default, so resume replay never re-emits it.
    // The client's listChatEvents (which returns every row) sees the
    // marker and detects the in-flight turn from the messageId alone.
    try {
      this.chatManager.appendEvent(opts.chatId, opts.messageId, -1, "turn_started", null);
    } catch (err) {
      console.warn(
        `[stream-hub] failed to write turn_started marker (chat=${opts.chatId} msg=${opts.messageId}):`,
        err,
      );
    }

    // Kick off the producer. We deliberately don't await, since subscribers
    // attach before the producer makes any progress.
    void (async () => {
      try {
        await opts.run(api);
        this.settle(turn, { kind: "done" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.settle(turn, { kind: "error", message });
      }
    })();

    // Start the grace timer immediately. If a subscriber attaches before
    // it fires (the POST handler that started us, or a reconnect), the
    // timer is cleared.
    this.armGraceTimer(turn);
  }

  // Attach a subscriber that wants events with seq > afterSeq. The
  // callback is invoked synchronously for replay, then asynchronously
  // for live events. Returns null if the turn isn't in memory, so the caller
  // should fall back to DB-only replay.
  subscribe(messageId: string, afterSeq: number, cb: Subscriber): SubscribeResult | null {
    const turn = this.turns.get(messageId);
    if (!turn) return null;

    // Replay buffered events the caller hasn't seen.
    for (const ev of turn.events) {
      if (ev.seq > afterSeq) cb({ kind: "event", event: ev });
    }

    // If the turn already settled, emit the terminal signal and don't
    // bother adding to the subscribers set.
    if (turn.status === "done") {
      cb({ kind: "done" });
      return { unsubscribe: () => {} };
    }
    if (typeof turn.status === "object") {
      cb({ kind: "error", message: turn.status.error });
      return { unsubscribe: () => {} };
    }

    turn.subscribers.add(cb);
    this.clearGraceTimer(turn);

    return {
      unsubscribe: () => {
        turn.subscribers.delete(cb);
        // No subscribers left and the turn is still running, so start the
        // grace timer. If nobody reconnects, the producer gets cancelled.
        if (turn.subscribers.size === 0 && turn.status === "running") {
          this.armGraceTimer(turn);
        }
      },
    };
  }

  // Explicit cancel, used by the Stop button (DELETE endpoint). The
  // producer's AbortSignal fires, and the producer is expected to translate
  // that into a cancelled CLI subprocess. The hub then emits the same
  // signal it would emit for any producer error (cancellation surfaces
  // as `error` with message "cancelled" by convention).
  //
  // Returns true only when we actually aborted a running producer.
  // A settled-but-not-yet-evicted turn returns false so the HTTP layer
  // can surface 404 honestly: "there is no in-flight turn to cancel."
  cancel(messageId: string): boolean {
    const turn = this.turns.get(messageId);
    if (!turn) return false;
    if (turn.status !== "running") return false;
    turn.cancelController.abort();
    return true;
  }

  // Tear down everything for a chat. Used by chat-delete and
  // instance-delete cascades so a deleted-while-streaming turn doesn't
  // linger and try to write to a DB row that no longer exists.
  cancelForChat(chatId: string): void {
    for (const turn of this.turns.values()) {
      if (turn.chatId === chatId) {
        if (turn.status === "running") turn.cancelController.abort();
        this.evictNow(turn);
      }
    }
  }

  // Test seam: wait for all currently-running turns to settle. Avoids
  // setTimeout(0) hacks in tests.
  async drain(): Promise<void> {
    const waits: Promise<void>[] = [];
    for (const turn of this.turns.values()) {
      if (turn.status === "running") {
        waits.push(
          new Promise<void>((resolve) => {
            const sub: Subscriber = (sig) => {
              if (sig.kind === "done" || sig.kind === "error") {
                turn.subscribers.delete(sub);
                resolve();
              }
            };
            turn.subscribers.add(sub);
          }),
        );
      }
    }
    await Promise.all(waits);
  }

  private publish(turn: Turn, type: string, payload: unknown): number {
    const seq = turn.events.length;
    // Persist first so DB ordering exactly matches in-memory ordering.
    // If persistence throws we still fan out. The live client sees the
    // event, even though a future reconnect via the DB-only replay path
    // will be missing it. We don't crash the turn over a transient
    // sqlite hiccup, but the warn includes enough context (chat,
    // message, seq, type) to make the gap diagnosable from logs alone.
    try {
      this.chatManager.appendEvent(turn.chatId, turn.messageId, seq, type, payload);
    } catch (err) {
      console.warn(
        `[stream-hub] appendEvent failed (chat=${turn.chatId} msg=${turn.messageId} seq=${seq} type=${type}):`,
        err,
      );
    }
    const event: StreamEvent = { seq, type, payload };
    turn.events.push(event);
    for (const sub of [...turn.subscribers]) {
      try {
        sub({ kind: "event", event });
      } catch (err) {
        // A subscriber threw, most likely a programming error in the
        // pump-side code that translates signals to SSE frames. We
        // can't unwind the publish (other subscribers already
        // succeeded), so log loudly with context and continue.
        console.warn(
          `[stream-hub] subscriber threw on event (chat=${turn.chatId} msg=${turn.messageId} seq=${seq} type=${type}):`,
          err,
        );
      }
    }
    return seq;
  }

  private settle(turn: Turn, signal: { kind: "done" } | { kind: "error"; message: string }): void {
    if (turn.status !== "running") return;
    turn.status = signal.kind === "done" ? "done" : { error: signal.message };
    for (const sub of [...turn.subscribers]) {
      try {
        sub(signal);
      } catch (err) {
        console.warn(
          `[stream-hub] subscriber threw on settle (chat=${turn.chatId} msg=${turn.messageId} kind=${signal.kind}):`,
          err,
        );
      }
    }
    this.clearGraceTimer(turn);
    // Keep the turn around for a bit so a delayed reconnect can still
    // tail the in-memory replay rather than re-reading the DB.
    turn.evictionTimer = setTimeout(() => this.evictNow(turn), this.evictionMs);
  }

  private armGraceTimer(turn: Turn): void {
    this.clearGraceTimer(turn);
    turn.graceTimer = setTimeout(() => {
      // No subscriber re-attached in the grace window. Cancel the
      // producer. settle() will eventually fire and emit the error
      // signal, but only any latecomer attached after cancel sees it.
      if (turn.status === "running") {
        turn.cancelController.abort();
      }
    }, this.idleCancelMs);
  }

  private clearGraceTimer(turn: Turn): void {
    if (turn.graceTimer) {
      clearTimeout(turn.graceTimer);
      turn.graceTimer = null;
    }
  }

  private evictNow(turn: Turn): void {
    if (turn.evictionTimer) {
      clearTimeout(turn.evictionTimer);
      turn.evictionTimer = null;
    }
    this.clearGraceTimer(turn);
    if (this.turns.get(turn.messageId) === turn) {
      this.turns.delete(turn.messageId);
    }
  }
}
