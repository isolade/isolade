import { afterEach, describe, expect, it } from "bun:test";
import { scheduleIdleWork } from "../src/lib/idle-work-queue";

const originalWindow = globalThis.window;

afterEach(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow,
    writable: true,
  });
});

describe("scheduleIdleWork", () => {
  it("waits for one hidden hydration to finish before starting the next", async () => {
    const idleCallbacks: Array<() => void> = [];
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        requestIdleCallback(callback: () => void) {
          idleCallbacks.push(callback);
          return idleCallbacks.length;
        },
      },
      writable: true,
    });

    const started: number[] = [];
    let releaseFirst: () => void = () => {};
    scheduleIdleWork(
      () =>
        new Promise<void>((resolve) => {
          started.push(1);
          releaseFirst = resolve;
        }),
    );
    scheduleIdleWork(() => {
      started.push(2);
    });

    expect(idleCallbacks).toHaveLength(1);
    idleCallbacks.shift()?.();
    await Promise.resolve();
    expect(started).toEqual([1]);
    expect(idleCallbacks).toHaveLength(0);

    releaseFirst();
    await Promise.resolve();
    await Promise.resolve();
    expect(idleCallbacks).toHaveLength(1);
    idleCallbacks.shift()?.();
    await Promise.resolve();
    expect(started).toEqual([1, 2]);
  });

  it("skips a hidden chat that is promoted before its idle turn", async () => {
    const idleCallbacks: Array<() => void> = [];
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        requestIdleCallback(callback: () => void) {
          idleCallbacks.push(callback);
          return idleCallbacks.length;
        },
      },
      writable: true,
    });

    const started: string[] = [];
    const cancel = scheduleIdleWork(() => {
      started.push("hidden");
    });
    cancel();
    idleCallbacks.shift()?.();
    await Promise.resolve();
    expect(started).toEqual([]);
  });
});
