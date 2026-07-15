import { describe, expect, it } from "bun:test";
import { KeyedQueue } from "../src/keyed-queue";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("KeyedQueue", () => {
  it("serializes ops for the same key in submission order", async () => {
    const q = new KeyedQueue();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => {
      releaseFirst = r;
    });

    const first = q.run("k", async () => {
      order.push("first:start");
      await gate;
      order.push("first:end");
    });
    const second = q.run("k", async () => {
      order.push("second");
    });

    await tick();
    expect(order).toEqual(["first:start"]); // second is queued, not running
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  it("runs different keys independently", async () => {
    const q = new KeyedQueue();
    const order: string[] = [];
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => {
      releaseA = r;
    });

    const a = q.run("a", async () => {
      await gateA;
      order.push("a");
    });
    const b = q.run("b", async () => {
      order.push("b");
    });

    await b;
    expect(order).toEqual(["b"]); // b didn't wait for a
    releaseA();
    await a;
    expect(order).toEqual(["b", "a"]);
  });

  it("keeps the queue usable after a rejected op and propagates the rejection", async () => {
    const q = new KeyedQueue();
    const boom = q.run("k", async () => {
      throw new Error("boom");
    });
    await expect(boom).rejects.toThrow("boom");
    // The failure must not poison the chain for the next op.
    await expect(q.run("k", async () => "ok")).resolves.toBe("ok");
  });

  it("returns each op's own result", async () => {
    const q = new KeyedQueue();
    const [x, y] = await Promise.all([q.run("k", async () => 1), q.run("k", async () => 2)]);
    expect(x).toBe(1);
    expect(y).toBe(2);
  });
});
