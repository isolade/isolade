import { createReadStream } from "node:fs";

// Tear our process subtree down when the launching process dies, *including*
// when it dies by SIGKILL or crash, where it gets no chance to signal us.
//
// The sidecar runs in its own process group (the Tauri app sets that up so its
// graceful-quit handler can `killpg` the whole tree at once). The side effect:
// a SIGINT to the launching terminal's foreground group never reaches us, and a
// SIGKILL/crash of the app runs none of its cleanup, so without this watchdog
// the sidecar and its msb VM children are orphaned to launchd and collide with
// the next launch. macOS has no `PR_SET_PDEATHSIG`, so we detect the parent's
// death from in here instead, two ways (whichever fires first):
//
//   1. A watch fd handed down by the launcher via ISOLADE_PARENT_WATCH_FD. The
//      parent holds the write end open for its whole life. When it dies the OS
//      closes every fd it owned, our inherited read end hits EOF, and we react
//      at once. This is exactly how microsandbox watches *us* (its
//      `--parent-watch-fd`). We mirror it one level up.
//   2. A `process.ppid` reparent poll, as a universal fallback for launches
//      that hand us no fd (the dev script, a bare `bun run`). When the parent
//      dies the kernel reparents us (to launchd / a subreaper), so ppid changes
//      from the value captured at startup.
//
// `onParentDeath` runs at most once. Callers wire it to the same graceful
// shutdown their signal handlers use, so the VMs still get their pre-stop sync.

export interface ParentWatchdogOptions {
  onParentDeath: () => void;
  // ppid poll cadence. VM teardown isn't latency-critical (a second is fine),
  // and the fd path handles the immediate case when it's wired.
  pollMs?: number;
  // Test seams. Default to the real process.
  getPpid?: () => number;
  watchFd?: number;
}

export function watchParentDeath(opts: ParentWatchdogOptions): () => void {
  const pollMs = opts.pollMs ?? 1000;
  const getPpid = opts.getPpid ?? (() => process.ppid);

  let fired = false;
  const cleanups: Array<() => void> = [];
  const stop = () => {
    while (cleanups.length) {
      try {
        cleanups.pop()!();
      } catch {
        // best-effort teardown of our own watchers
      }
    }
  };
  const trigger = (why: string) => {
    if (fired) return;
    fired = true;
    console.log(`[isolade] launching process gone (${why}); tearing down`);
    stop();
    opts.onParentDeath();
  };

  // 1. Inherited watch fd → EOF on parent death.
  const fd =
    opts.watchFd ??
    (process.env.ISOLADE_PARENT_WATCH_FD != null
      ? Number(process.env.ISOLADE_PARENT_WATCH_FD)
      : undefined);
  if (fd != null && Number.isInteger(fd) && fd >= 0) {
    try {
      // `path` is ignored when `fd` is given. autoClose so we release the fd
      // when the stream ends. Flowing mode (the empty data handler) is what
      // lets 'end' fire on EOF, since the pipe never actually carries bytes.
      const stream = createReadStream("", { fd, autoClose: true });
      // Only a true EOF ('end') means the parent closed the write end, i.e.
      // died. A bad/closed fd emits 'error' (then a teardown 'close'), so guard so
      // that path can't masquerade as a death. We just fall back to the ppid
      // poll. We deliberately don't trigger on 'close' for the same reason.
      let fdErrored = false;
      stream.on("data", () => {});
      stream.on("end", () => {
        if (!fdErrored) trigger("watch fd reached EOF");
      });
      stream.on("error", (err) => {
        fdErrored = true;
        console.warn("[isolade] parent watch fd unusable, relying on ppid poll:", err);
      });
      cleanups.push(() => stream.destroy());
    } catch (err) {
      console.warn("[isolade] could not attach parent watch fd:", err);
    }
  }

  // 2. ppid reparent poll (always on as the universal backstop).
  const initialPpid = getPpid();
  const timer = setInterval(() => {
    const ppid = getPpid();
    if (ppid !== initialPpid) {
      trigger(`reparented (ppid ${initialPpid} -> ${ppid})`);
    }
  }, pollMs);
  // Don't let the poll alone keep the process alive.
  (timer as { unref?: () => void }).unref?.();
  cleanups.push(() => clearInterval(timer));

  return stop;
}
