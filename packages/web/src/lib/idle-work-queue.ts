type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
};

interface QueueEntry {
  cancelled: boolean;
  run: () => Promise<void> | void;
}

const queue: QueueEntry[] = [];
let scheduled = false;

function scheduleNext(): void {
  if (scheduled || queue.length === 0) return;
  scheduled = true;
  const idleWindow = window as IdleWindow;
  const drainOne = () => {
    let entry: QueueEntry | undefined;
    while ((entry = queue.shift())) {
      if (!entry.cancelled) break;
    }
    void Promise.resolve(entry && !entry.cancelled ? entry.run() : undefined).finally(() => {
      scheduled = false;
      scheduleNext();
    });
  };
  if (idleWindow.requestIdleCallback) {
    idleWindow.requestIdleCallback(drainOne, { timeout: 2_000 });
  } else {
    window.setTimeout(drainOne, 250);
  }
}

/** Serialize hidden-chat hydration into one bounded task per idle callback. */
export function scheduleIdleWork(run: () => Promise<void> | void): () => void {
  const entry: QueueEntry = { cancelled: false, run };
  queue.push(entry);
  scheduleNext();
  return () => {
    entry.cancelled = true;
  };
}
