import { describe, expect, it } from "bun:test";
import { proxyTtydWs } from "../src/vms";

const neverYield: AsyncIterable<never> = {
  [Symbol.asyncIterator]: () => ({
    next: () => new Promise<IteratorResult<never>>(() => {}),
  }),
};

describe("proxyTtydWs", () => {
  it("rejects when the WS handshake never completes", async () => {
    // A TCP listener that accepts but never answers the upgrade. This is the shape
    // of the msb relay forwarding to a guest port with no listener.
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data: () => {} },
    });

    try {
      await expect(
        proxyTtydWs(
          {
            url: `ws://127.0.0.1:${server.port}/ws`,
            rows: 24,
            cols: 80,
            stdin: neverYield,
            stdout: () => {},
            resize: neverYield,
          },
          250,
        ),
      ).rejects.toThrow(/handshake timed out after 250ms/);
    } finally {
      server.stop(true);
    }
  });
});
