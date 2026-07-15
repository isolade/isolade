import { describe, expect, it } from "bun:test";
import { PushQueue } from "../src/push-queue";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

async function collect(q: PushQueue<Buffer>, into: string[]): Promise<void> {
  for await (const chunk of q) into.push(chunk.toString("utf8"));
}

describe("PushQueue", () => {
  it("yields pushed items in order, then completes on end()", async () => {
    const q = new PushQueue<Buffer>();
    const got: string[] = [];
    const consumer = collect(q, got);
    q.push(Buffer.from("a"));
    q.push(Buffer.from("b"));
    await tick();
    q.end();
    await consumer;
    expect(got).toEqual(["a", "b"]);
  });

  it("drains items buffered before iteration starts", async () => {
    const q = new PushQueue<Buffer>();
    q.push(Buffer.from("a"));
    q.push(Buffer.from("b"));
    q.end();
    const got: string[] = [];
    await collect(q, got);
    expect(got).toEqual(["a", "b"]);
  });

  it("parks between pushes and stays open until end()", async () => {
    const q = new PushQueue<Buffer>();
    const got: string[] = [];
    let done = false;
    const consumer = collect(q, got).then(() => {
      done = true;
    });

    await tick();
    expect(got).toEqual([]);
    expect(done).toBe(false);

    q.push(Buffer.from("x"));
    await tick();
    expect(got).toEqual(["x"]);
    expect(done).toBe(false); // still open, which is what keeps a process alive

    q.end();
    await consumer;
    expect(done).toBe(true);
  });

  it("ignores pushes after end()", async () => {
    const q = new PushQueue<Buffer>();
    const got: string[] = [];
    const consumer = collect(q, got);
    q.push(Buffer.from("a"));
    await tick();
    q.end();
    q.push(Buffer.from("late"));
    await consumer;
    expect(got).toEqual(["a"]);
  });

  it("carries non-Buffer element types", async () => {
    const q = new PushQueue<[number, number]>();
    q.push([24, 80]);
    q.push([50, 132]);
    q.end();
    const got: Array<[number, number]> = [];
    for await (const v of q) got.push(v);
    expect(got).toEqual([
      [24, 80],
      [50, 132],
    ]);
  });
});
