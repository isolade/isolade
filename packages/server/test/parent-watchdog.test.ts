import { describe, expect, it } from "bun:test";
import { watchParentDeath } from "../src/parent-watchdog";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("watchParentDeath", () => {
  it("fires when the parent dies (ppid reparented)", async () => {
    let ppid = 100;
    let fired = 0;
    const stop = watchParentDeath({
      onParentDeath: () => fired++,
      pollMs: 5,
      getPpid: () => ppid,
    });
    await tick(25);
    expect(fired).toBe(0); // stable parent → no teardown

    ppid = 1; // parent gone → kernel reparents us to launchd
    await tick(25);
    expect(fired).toBe(1);
    stop();
  });

  it("fires at most once even if ppid keeps changing", async () => {
    let ppid = 100;
    let fired = 0;
    const stop = watchParentDeath({
      onParentDeath: () => fired++,
      pollMs: 5,
      getPpid: () => ppid,
    });
    ppid = 1;
    await tick(15);
    ppid = 2;
    await tick(15);
    expect(fired).toBe(1);
    stop();
  });

  it("stop() halts the poll so it never fires afterwards", async () => {
    let ppid = 100;
    let fired = 0;
    const stop = watchParentDeath({
      onParentDeath: () => fired++,
      pollMs: 5,
      getPpid: () => ppid,
    });
    stop();
    ppid = 1;
    await tick(25);
    expect(fired).toBe(0);
  });

  it("an unusable watch fd doesn't throw or spuriously fire, and the poll still works", async () => {
    let ppid = 100;
    let fired = 0;
    const stop = watchParentDeath({
      onParentDeath: () => fired++,
      pollMs: 5,
      getPpid: () => ppid,
      watchFd: 2_000_000_000, // not an open fd
    });
    await tick(25);
    expect(fired).toBe(0); // error on the fd must not look like a death

    ppid = 1;
    await tick(25);
    expect(fired).toBe(1); // fallback poll still detects the reparent
    stop();
  });

  it("EOF on the watched fd fires the watchdog", async () => {
    // The production fd is a pipe whose write end the parent holds. When the
    // parent dies the OS closes it and our read end hits EOF. node:fs exposes
    // no pipe(2), so we exercise the same 'end' wiring with an empty temp-file
    // fd, which reaches EOF immediately on read.
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = path.join(os.tmpdir(), `isolade-watchdog-${Date.now()}.tmp`);
    fs.writeFileSync(tmp, ""); // empty → read stream hits EOF right away
    const fd = fs.openSync(tmp, "r");

    let fired = 0;
    const stop = watchParentDeath({
      onParentDeath: () => fired++,
      pollMs: 10_000, // keep the poll out of the way, since we want the fd path
      getPpid: () => 100,
      watchFd: fd,
    });
    await tick(40);
    expect(fired).toBe(1); // EOF on the watched fd → teardown
    stop();
    try {
      fs.unlinkSync(tmp);
    } catch {
      // already gone (autoClose closed the fd, and unlink is best-effort cleanup)
    }
  });
});
