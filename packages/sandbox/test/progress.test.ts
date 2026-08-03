import { describe, expect, it } from "bun:test";
import { formatElapsed, heartbeat, tickWhileQuiet } from "../src/progress";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function collect(gen: AsyncGenerator<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const line of gen) out.push(line);
  return out;
}

describe("formatElapsed", () => {
  it("counts seconds below a minute and minutes above it", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(5_400)).toBe("5s");
    expect(formatElapsed(59_400)).toBe("59s");
    expect(formatElapsed(60_000)).toBe("1m00s");
    expect(formatElapsed(185_000)).toBe("3m05s");
  });
});

describe("heartbeat", () => {
  it("ticks while the promise is pending and stops when it settles", async () => {
    const lines = await collect(heartbeat(sleep(70), 20, () => "tick"));
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(new Set(lines)).toEqual(new Set(["tick"]));
  });

  it("says nothing about work that finishes before the first tick", async () => {
    expect(await collect(heartbeat(sleep(1), 50, () => "tick"))).toEqual([]);
  });
});

describe("tickWhileQuiet", () => {
  it("forwards every line of a talkative source without ticking", async () => {
    async function* talkative() {
      yield "a";
      yield "b";
      yield "c";
    }
    expect(await collect(tickWhileQuiet(talkative(), 50, () => "tick"))).toEqual(["a", "b", "c"]);
  });

  it("ticks through a silence and keeps the lines around it in order", async () => {
    async function* quiet() {
      yield "before";
      await sleep(70);
      yield "after";
    }
    const lines = await collect(tickWhileQuiet(quiet(), 20, () => "tick"));
    expect(lines[0]).toBe("before");
    expect(lines.at(-1)).toBe("after");
    expect(lines.filter((l) => l === "tick").length).toBeGreaterThanOrEqual(2);
    // The real lines keep their order, whatever landed between them.
    expect(lines.filter((l) => l !== "tick")).toEqual(["before", "after"]);
  });

  it("propagates a source failure rather than ticking forever", async () => {
    async function* failing() {
      yield "start";
      await sleep(5);
      throw new Error("boom");
    }
    await expect(collect(tickWhileQuiet(failing(), 20, () => "tick"))).rejects.toThrow("boom");
  });

  it("closes the source when the consumer stops early", async () => {
    let closed = false;
    async function* endless() {
      try {
        for (;;) {
          yield "line";
          await sleep(5);
        }
      } finally {
        closed = true;
      }
    }
    const gen = tickWhileQuiet(endless(), 20, () => "tick");
    await gen.next();
    await gen.return(undefined);
    expect(closed).toBe(true);
  });
});
