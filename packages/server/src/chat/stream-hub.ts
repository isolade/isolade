import type { ChatManager } from "../chats";
import { applyChatRenderEvent, boundChatRenderChunks, type ChatRenderChunk } from "../contracts";

// One event published during an assistant turn. `seq` is monotonic and
// per-turn (starts at 0). The wire form duplicates the seq into the SSE
// `id:` line so the client can resume from `Last-Event-ID` if it
// disconnects mid-stream.
export interface StreamEvent {
  seq: number;
  type: string;
  payload: unknown;
}

type ResumeMetaEvent = StreamEvent & {
  type: "usage" | "title" | "context_compacted";
};

const RESUME_META_TYPES = new Set<ResumeMetaEvent["type"]>(["usage", "title", "context_compacted"]);

// Signals delivered to subscribers after the producer settles.
export type StreamSignal =
  | { kind: "event"; event: StreamEvent }
  | { kind: "done" }
  | { kind: "error"; message: string };

export type Subscriber = (signal: StreamSignal) => void;

interface Turn {
  chatId: string;
  messageId: string;
  nextSeq: number;
  discarded: boolean;
  // Maintained as events publish, so an atomic resume snapshot clones compact
  // state instead of replaying every token emitted so far.
  renderChunks: ChatRenderChunk[];
  renderToolIndex: Map<string, number>;
  // Latest authoritative UI metadata for reconnect snapshots. Keeping one
  // event per type makes snapshot creation independent of token count.
  resumeMetaEvents: Map<ResumeMetaEvent["type"], ResumeMetaEvent>;
  subscribers: Set<Subscriber>;
  status: "running" | "done" | { error: string };
  // Producer's cancel token. Aborted when the last subscriber leaves and
  // the grace timer expires, or on explicit cancel().
  cancelController: AbortController;
  // Bounded lifetime without a subscriber. Hidden chats and accidental
  // disconnects share this one policy, while Stop and deletion cancel now.
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
  // Full compact state produced by events that were durably published.
  renderChunks: () => ChatRenderChunk[];
}

export interface SubscribeResult {
  unsubscribe: () => void;
}

export interface TurnRenderSnapshot {
  messageId: string;
  lastSeq: number;
  chunks: ChatRenderChunk[];
  status: "running" | "done" | "error";
  error?: string;
  metaEvents: ResumeMetaEvent[];
}

export interface SnapshotSubscribeResult extends SubscribeResult {
  snapshot: TurnRenderSnapshot;
}

export interface HubOptions {
  // After the last subscriber detaches, how long to wait before
  // cancelling the producer. The client disconnects its stream whenever
  // the chat view unmounts (not just on reload), so this window also has
  // to span "user switched to another chat and came back", and a turn the
  // user left running is expected to keep going and complete in the
  // background (the sidebar's working/unread indicators depend on it). So
  // it's deliberately generous (default 6h). It is NOT the primary
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

const DEFAULT_IDLE_CANCEL_MS = 6 * 60 * 60_000;
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

  hasForChat(chatId: string, messageId: string): boolean {
    return this.turns.get(messageId)?.chatId === chatId;
  }

  renderChunksForChat(
    chatId: string,
    messageId: string,
    includeDebug: boolean,
  ): ChatRenderChunk[] | null {
    const turn = this.turns.get(messageId);
    if (!turn || turn.chatId !== chatId) return null;
    return turn.renderChunks
      .filter((chunk) => includeDebug || (chunk.kind !== "thinking" && chunk.kind !== "raw"))
      .map((chunk) => ({ ...chunk }));
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
      nextSeq: 0,
      discarded: false,
      renderChunks: [],
      renderToolIndex: new Map(),
      resumeMetaEvents: new Map(),
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
      renderChunks: () => turn.renderChunks.map((chunk) => ({ ...chunk })),
    };

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

  // Atomically capture the current compact render and register for only later
  // events. publish() and this method are synchronous, so no event can land
  // between the snapshot boundary and subscriber registration.
  subscribeSnapshot(
    chatId: string,
    messageId: string,
    includeDebug: boolean,
    cb: Subscriber,
  ): SnapshotSubscribeResult | null {
    const turn = this.turns.get(messageId);
    if (!turn || turn.chatId !== chatId) return null;
    const snapshot = this.snapshot(turn, includeDebug);
    this.clearGraceTimer(turn);
    if (turn.status !== "running") {
      return { snapshot, unsubscribe: () => {} };
    }
    const filteredSubscriber: Subscriber = (signal) => {
      if (signal.kind !== "event") {
        cb(signal);
        return;
      }
      const event = projectStreamEvent(signal.event, includeDebug);
      if (event) cb({ kind: "event", event });
    };
    turn.subscribers.add(filteredSubscriber);
    return {
      snapshot,
      unsubscribe: () => {
        turn.subscribers.delete(filteredSubscriber);
        if (turn.subscribers.size === 0 && turn.status === "running") {
          this.armGraceTimer(turn);
        }
      },
    };
  }

  // Read-only compact snapshot for the one-request transcript endpoint. Since
  // both this method and publish() are synchronous, the route can pass the
  // result into its synchronous SQLite transaction without a token event
  // interleaving between the two operations.
  snapshotForChat(
    chatId: string,
    messageId: string,
    includeDebug: boolean,
  ): TurnRenderSnapshot | null {
    const turn = this.turns.get(messageId);
    if (!turn || turn.chatId !== chatId) return null;
    return this.snapshot(turn, includeDebug);
  }

  private snapshot(turn: Turn, includeDebug: boolean): TurnRenderSnapshot {
    const full = turn.renderChunks.map((chunk) => ({ ...chunk }));
    const visible = includeDebug
      ? full
      : full.filter((chunk) => chunk.kind !== "thinking" && chunk.kind !== "raw");
    const status =
      turn.status === "running" ? "running" : turn.status === "done" ? "done" : "error";
    return {
      messageId: turn.messageId,
      lastSeq: turn.nextSeq - 1,
      chunks: boundChatRenderChunks(visible),
      metaEvents: [...turn.resumeMetaEvents.values()].toSorted((a, b) => a.seq - b.seq),
      status,
      ...(typeof turn.status === "object" ? { error: turn.status.error } : {}),
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
        turn.discarded = true;
        if (turn.status === "running") turn.cancelController.abort();
        for (const sub of [...turn.subscribers]) {
          try {
            sub({ kind: "error", message: "turn cancelled" });
          } catch {}
        }
        turn.subscribers.clear();
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
    if (turn.discarded) throw new Error("turn cancelled");
    const seq = turn.nextSeq;
    // Persist first so DB ordering exactly matches in-memory ordering.
    // A persistence failure aborts the turn before fan-out because exposing
    // an event that cannot be replayed would make reconnect correctness
    // impossible.
    try {
      this.chatManager.appendEvent(turn.chatId, turn.messageId, seq, type, payload);
    } catch (err) {
      console.warn(
        `[stream-hub] appendEvent failed (chat=${turn.chatId} msg=${turn.messageId} seq=${seq} type=${type}):`,
        err,
      );
      // Continuing after a persistence gap makes reconnect correctness
      // impossible and can turn one transient error into an unbounded memory
      // buffer. Abort the producer and let its normal partial-finalize path
      // persist the compact message projection transactionally.
      turn.cancelController.abort();
      throw err;
    }
    turn.nextSeq += 1;
    const event: StreamEvent = { seq, type, payload };
    if (RESUME_META_TYPES.has(type as ResumeMetaEvent["type"])) {
      const metaEvent = event as ResumeMetaEvent;
      turn.resumeMetaEvents.set(metaEvent.type, metaEvent);
    }
    applyChatRenderEvent(turn.renderChunks, turn.renderToolIndex, type, payload);
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
    if (turn.discarded) return;
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

export function projectStreamEvent(event: StreamEvent, includeDebug: boolean): StreamEvent | null {
  if (!includeDebug && (event.type === "thinking" || event.type === "raw")) return null;
  if (event.type !== "tool_call_input" && event.type !== "tool_call_result") return event;
  const payload = event.payload as Record<string, unknown> | null;
  if (!payload || typeof payload !== "object") return event;
  const placeholder: ChatRenderChunk =
    event.type === "tool_call_input"
      ? {
          kind: "tool",
          id: typeof payload.id === "string" ? payload.id : "",
          name: "tool",
          input: payload.input,
          status: "running",
        }
      : {
          kind: "tool",
          id: typeof payload.id === "string" ? payload.id : "",
          name: "tool",
          output: typeof payload.output === "string" ? payload.output : undefined,
          isError: payload.isError === true,
          status: "done",
        };
  const bounded = boundChatRenderChunks([placeholder])[0];
  if (!bounded || bounded.kind !== "tool") return event;
  return {
    ...event,
    payload: {
      ...payload,
      ...(event.type === "tool_call_input"
        ? { input: bounded.input, summary: bounded.summary }
        : { output: bounded.output }),
      ...(bounded.detailsAvailable ? { detailsAvailable: true } : {}),
    },
  };
}
