import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Server } from "bun";
import { SandboxClient } from "../src/sandbox-client";

// Per-connection data attached at upgrade time so the websocket handler knows
// which close scenario to drive (selected by the vmId in the request path).
// `stdin` accumulates received binary frames for the echo-stdin scenario.
interface WsData {
  vmId: string;
  stdin: Buffer[];
}

// A stand-in for the sandbox's exec-stream WebSocket endpoint. The behaviour
// is selected by the vmId in the path so each test drives a different close
// scenario without spinning up its own server.
let server: Server<WsData>;
let client: SandboxClient;

const emptyStdin: AsyncIterable<Buffer> = {
  async *[Symbol.asyncIterator]() {},
};

beforeAll(() => {
  server = Bun.serve<WsData>({
    port: 0,
    fetch(req, srv) {
      const vmId = new URL(req.url).pathname.split("/")[2] ?? "";
      if (srv.upgrade(req, { data: { vmId, stdin: [] } })) return;
      return new Response("expected websocket", { status: 400 });
    },
    websocket: {
      open(ws) {
        const { vmId } = ws.data;
        switch (vmId) {
          case "clean-exit":
            // Send the terminal message and leave the socket open. The
            // client settles on the message, and racing a close() against the
            // send can drop the frame before it flushes (which is exactly the
            // premature-close case, tested separately).
            ws.send(JSON.stringify({ type: "exit", exitCode: 3 }));
            break;
          case "error-msg":
            ws.send(JSON.stringify({ type: "error", message: "boom" }));
            break;
          case "premature-close":
            // Drop the socket with no exit/error message, a mid-command
            // disconnect (sandbox crash, network blip).
            ws.close(1006);
            break;
          // "echo-stdin" replies in message() once stdin EOF arrives.
        }
      },
      message(ws, msg) {
        if (ws.data.vmId !== "echo-stdin") return;
        if (typeof msg === "string") {
          // The client signals EOF with a JSON control frame. Echo the
          // accumulated stdin back as stdout, then report a clean exit.
          try {
            if ((JSON.parse(msg) as { type?: string }).type === "stdin_eof") {
              ws.send(Buffer.concat(ws.data.stdin));
              ws.send(JSON.stringify({ type: "exit", exitCode: 0 }));
            }
          } catch {}
          return;
        }
        ws.data.stdin.push(Buffer.from(msg));
      },
    },
  });
  client = new SandboxClient(`http://localhost:${server.port}`);
});

afterAll(() => {
  server.stop(true);
});

describe("SandboxClient.execStream close handling", () => {
  it("resolves with the reported exit code on a clean exit", async () => {
    const result = await client.execStream("clean-exit", "true", {
      stdin: emptyStdin,
      stdout: () => {},
    });
    expect(result.exitCode).toBe(3);
  });

  it("rejects when the sandbox sends an error message", async () => {
    await expect(
      client.execStream("error-msg", "true", {
        stdin: emptyStdin,
        stdout: () => {},
      }),
    ).rejects.toThrow("boom");
  });

  it("rejects (not resolves 0) when the socket closes before completion", async () => {
    // The bug this guards: resolving exitCode 0 here would make the claude
    // backend treat a truncated turn as a successful one.
    await expect(
      client.execStream("premature-close", "true", {
        stdin: emptyStdin,
        stdout: () => {},
      }),
    ).rejects.toThrow(/closed before the command finished/);
  });

  it("rejects with AbortError when the signal is already aborted", async () => {
    await expect(
      client.execStream("clean-exit", "true", {
        stdin: emptyStdin,
        stdout: () => {},
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow();
  });

  it("streams stdin to the server and signals EOF (how claude -p gets its prompt)", async () => {
    const parts = ["hello ", "from ", "stdin"];
    const stdin: AsyncIterable<Buffer> = {
      async *[Symbol.asyncIterator]() {
        for (const p of parts) yield Buffer.from(p);
      },
    };
    const out: Buffer[] = [];
    const { exitCode } = await client.execStream("echo-stdin", "cat", {
      stdin,
      stdout: (chunk) => out.push(chunk),
    });
    // The server echoes back exactly what it received over stdin, proving the
    // frames arrived and the stdin_eof control frame triggered completion.
    expect(Buffer.concat(out).toString("utf8")).toBe("hello from stdin");
    expect(exitCode).toBe(0);
  });
});
