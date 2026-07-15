// A push-based async-iterable queue. Several isolade transports drive a
// consumer that pulls with `for await` (an exec stream's stdin, a PTY's
// stdin/resize feed, a JSON-RPC pipe) while the producer pushes items at
// arbitrary times, whereas a normal generator can only *pull*, which is the wrong
// shape for that. This is the one implementation all of them share.
//
// The iterator stays parked between pushes and only completes once `end()` is
// called, which is what lets a single exec stream span many turns: keeping
// the stream open keeps the guest process alive, and ending it sends EOF so the
// process drains and exits.
export class PushQueue<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private wake: (() => void) | null = null;
  private ended = false;

  // Enqueue an item for the consumer. No-op once ended, so a late write after
  // the consumer has been told to shut down is silently dropped rather than
  // throwing into a fire-and-forget caller.
  push(item: T): void {
    if (this.ended) return;
    this.queue.push(item);
    const w = this.wake;
    this.wake = null;
    w?.();
  }

  // Signal end-of-input. The consumer drains any queued items, then the
  // iterator completes (→ EOF downstream). Idempotent.
  end(): void {
    if (this.ended) return;
    this.ended = true;
    const w = this.wake;
    this.wake = null;
    w?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (;;) {
      while (this.queue.length > 0) yield this.queue.shift()!;
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}
