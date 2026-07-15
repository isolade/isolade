// Per-key async serialization: run each op for a key strictly after every
// previously-enqueued op for that key has settled, whatever its outcome.
// Ops for different keys run independently. Used wherever concurrent callers
// share one underlying resource that can only take one op at a time, such as a
// profile's titling VM lifecycle, or the warm titling session inside it.
export class KeyedQueue {
  private tails = new Map<string, Promise<void>>();

  /** Enqueue `fn` behind the key's in-flight ops. Returns `fn`'s own
   * result/rejection. The key's entry self-cleans once its queue drains, so an
   * idle key doesn't pin a settled promise in the map forever. */
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    // Store a settled-either-way tail so the next op chains cleanly even if
    // this one threw (and so the map never holds a rejected promise).
    const tail = next.then(
      () => {},
      () => {},
    );
    this.tails.set(key, tail);
    void tail.finally(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}
