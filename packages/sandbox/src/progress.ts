// Progress reporting for the build log.
//
// A build spends most of its wall clock inside operations that say nothing:
// microsandbox's image ingest, a `copyFromHost` of a multi-GB context, a
// builder VM booting for the first time on this install. Silence is
// indistinguishable from a hang, and a build that looks hung is one people kill
// and retry, paying the whole cost again. These wrappers keep such a stretch
// talking, either about how far it has got or, when nothing can be measured,
// about how long it has been going.
//
// They live apart from builder.ts because they are pure, and that file imports
// the microsandbox SDK at module scope, so a test of the logic here would
// otherwise need the native runtime to load first.

export function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

// Elapsed time for the heartbeat lines. Seconds while it is seconds, then
// minutes, because "185s" is a number a reader has to convert before it means
// anything.
export function formatElapsed(ms: number): string {
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, "0")}s`;
}

// Yields `msg()` every `intervalMs` until `p` settles. Used to keep the SSE
// stream alive while we await opaque long operations (request-body spool,
// fs.copyFromHost, tar extract) that don't produce their own progress.
export async function* heartbeat<T>(
  p: Promise<T>,
  intervalMs: number,
  msg: () => string,
): AsyncGenerator<string> {
  let done = false;
  p.finally(() => {
    done = true;
  }).catch(() => {});
  while (!done) {
    await new Promise<void>((r) => setTimeout(r, intervalMs));
    if (done) break;
    yield msg();
  }
}

// Like heartbeat, but each tick runs an async `probe()` to discover the
// current byte count (e.g. via `stat` or `du` in the guest) and formats it
// with `fmt(bytes)`. Skips probe errors (transient ENOENT before the file
// appears, dropped exec channels), because they shouldn't kill the build.
export async function* progressBytes<T>(
  p: Promise<T>,
  intervalMs: number,
  probe: () => Promise<number>,
  fmt: (bytes: number) => string,
): AsyncGenerator<string> {
  let done = false;
  p.finally(() => {
    done = true;
  }).catch(() => {});
  while (!done) {
    await new Promise<void>((r) => setTimeout(r, intervalMs));
    if (done) break;
    try {
      const bytes = await probe();
      if (done) break;
      yield fmt(bytes);
    } catch {
      // Swallow probe failures, since they shouldn't abort the operation.
    }
  }
}

// Forwards `source` line for line, and emits `tick()` whenever it has gone
// `intervalMs` without producing one. The heartbeat above wraps an opaque
// promise; this wraps a generator that does speak, just not often enough to
// show that it is alive. A tick never displaces output: the moment a real line
// arrives it is yielded, and the clock starts again.
export async function* tickWhileQuiet(
  source: AsyncGenerator<string>,
  intervalMs: number,
  tick: () => string,
): AsyncGenerator<string> {
  const iterator = source[Symbol.asyncIterator]();
  let next = iterator.next();
  const QUIET = Symbol("quiet");
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const quiet = new Promise<typeof QUIET>((resolve) => {
        timer = setTimeout(() => resolve(QUIET), intervalMs);
      });
      const settled = await Promise.race([next, quiet]);
      clearTimeout(timer);
      if (settled === QUIET) {
        yield tick();
        continue;
      }
      if (settled.done) return;
      yield settled.value;
      next = iterator.next();
    }
  } finally {
    // A consumer that stops early (the SSE client disconnected) must not leave
    // the underlying process streaming into nothing.
    await iterator.return?.(undefined);
  }
}
