import { afterEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import type { ChatRenderChunk } from "../src/contracts";
import { DEFAULT_ANTHROPIC_MODEL_ID } from "../src/contracts";
import { schema } from "../src/db";
import type { SandboxApi } from "../src/sandbox-client";
import { createTestServer } from "./helpers";

// The whole path, end to end: an assistant reply that cites a file as a
// markdown image, through the collector on the delta stream, out of the VM,
// into the store, onto the turn's render, and back out of the byte endpoint the
// browser will point an <img> at.

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 3),
]);

/** A sandbox that answers the read snippet from an in-memory filesystem. Every
 * other call is a no-op: teardown reaches for destroyVm, and nothing else in
 * this path touches a VM. */
function sandboxServing(files: Record<string, Buffer>): SandboxApi {
  return new Proxy(
    {
      async exec(_vmId: string, command: string) {
        // Both capture snippets: a local read probes with `[ -f … ]`, a remote
        // fetch passes its URL to curl after `--`. Keyed the same way here, so
        // one table covers files and URLs alike.
        const fetched = command.match(/-- '([^']*)'/)?.[1];
        const path = fetched ?? command.match(/\[ -f '([^']*)' \]/)?.[1];
        const bytes = path === undefined ? undefined : files[path];
        if (!bytes) return { stdout: "", stderr: "", exitCode: fetched ? 4 : 2 };
        return { stdout: bytes.toString("base64"), stderr: "", exitCode: 0 };
      },
    },
    {
      get: (target, property, receiver) =>
        property in target
          ? Reflect.get(target, property, receiver)
          : () => Promise.resolve(undefined),
    },
  ) as unknown as SandboxApi;
}

/** A backend that streams a fixed reply one small delta at a time, so the
 * scanner really does have to reassemble a reference split across them. */
function backendStreaming(reply: string) {
  return {
    sendMessage: async (opts: { onDelta: (text: string) => void }) => {
      for (const piece of reply.match(/[\s\S]{1,7}/g) ?? []) opts.onDelta(piece);
      return { content: reply };
    },
    probeContext: async () => ({ available: false as const, reason: "fake" }),
    generateTitle: async () => null,
  };
}

type TestServer = ReturnType<typeof createTestServer>;
let cleanup: (() => Promise<void>) | null = null;

afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

async function runTurn(reply: string, files: Record<string, Buffer>) {
  const server: TestServer = createTestServer({
    sandbox: sandboxServing(files),
    backendForTest: backendStreaming(reply) as unknown as NonNullable<
      Parameters<typeof createTestServer>[0] extends infer T
        ? T extends { backendForTest?: infer B }
          ? B
          : never
        : never
    >,
    hubOptions: { idleCancelMs: 30_000, evictionMs: 30_000 },
  });
  cleanup = server.cleanup;
  const instanceId = server.seedInstance();
  const chatResponse = await fetch(`${server.baseUrl}/api/instances/${instanceId}/chats`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: DEFAULT_ANTHROPIC_MODEL_ID }),
  });
  const { id: chatId } = (await chatResponse.json()) as { id: string };
  const turn = await fetch(
    `${server.baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "show me the chart" }),
    },
  );
  await turn.text();

  const transcript = await fetch(
    `${server.baseUrl}/api/instances/${instanceId}/chats/${chatId}/transcript`,
  );
  const page = (await transcript.json()) as {
    messages: { id: string; chatId: string; role: string; content: string }[];
    chunksByMessage: Record<string, ChatRenderChunk[]>;
  };
  const assistant = page.messages.find((message) => message.role === "assistant");
  const chunks = assistant ? (page.chunksByMessage[assistant.id] ?? []) : [];
  return { server, instanceId, assistant, chunks };
}

describe("an assistant reply that shows an image", () => {
  it("captures the file it cited and carries it on the committed turn", async () => {
    const { server, instanceId, assistant, chunks } = await runTurn(
      "Rendered it: ![the chart](/workspace/out/chart.png) — the spike is at noon.",
      { "/workspace/out/chart.png": PNG },
    );

    const images = chunks.filter((chunk) => chunk.kind === "image");
    expect(images).toHaveLength(1);
    const image = images[0];
    if (image?.kind !== "image") throw new Error("expected an image chunk");
    // Keyed by the destination as written, which is what the renderer matches.
    expect(image.sourcePath).toBe("/workspace/out/chart.png");
    expect(image.mediaType).toBe("image/png");
    expect(image.size).toBe(PNG.length);

    // The message text is untouched: the model's own words are the transcript,
    // and the snapshot is only how the `![](…)` in them gets resolved.
    expect(assistant?.content).toContain("![the chart](/workspace/out/chart.png)");

    // And the bytes are actually servable, which is what the <img> will do.
    const served = await fetch(`${server.baseUrl}/api/instances/${instanceId}/uploads/${image.id}`);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await served.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it("re-reads a path shown twice, so each mention keeps its own bytes", async () => {
    // The agent shows a screenshot, fixes the bug, overwrites the file, and
    // shows it again, all in one reply. Both mentions must survive with what
    // they were written about, which is only possible because each occurrence
    // is read at the moment it is written.
    const rebuilt = Buffer.concat([PNG, Buffer.from("after the fix")]);
    const files: Record<string, Buffer> = { "/workspace/shot.png": PNG };
    const before = "The bug: ![bug](/workspace/shot.png)";
    const reply = `${before}\n\nFixed: ![fixed](/workspace/shot.png)`;

    const server: TestServer = createTestServer({
      sandbox: sandboxServing(files),
      // Overwrite the file the instant the first mention has been read, exactly
      // as a tool call between the two sentences would.
      backendForTest: {
        sendMessage: async (opts: { onDelta: (text: string) => void }) => {
          opts.onDelta(before);
          await new Promise((resolve) => setTimeout(resolve, 20));
          files["/workspace/shot.png"] = rebuilt;
          opts.onDelta(reply.slice(before.length));
          return { content: reply };
        },
        probeContext: async () => ({ available: false as const, reason: "fake" }),
        generateTitle: async () => null,
      } as unknown as NonNullable<
        Parameters<typeof createTestServer>[0] extends infer T
          ? T extends { backendForTest?: infer B }
            ? B
            : never
          : never
      >,
      hubOptions: { idleCancelMs: 30_000, evictionMs: 30_000 },
    });
    cleanup = server.cleanup;
    const instanceId = server.seedInstance();
    const chatResponse = await fetch(`${server.baseUrl}/api/instances/${instanceId}/chats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: DEFAULT_ANTHROPIC_MODEL_ID }),
    });
    const { id: chatId } = (await chatResponse.json()) as { id: string };
    const turn = await fetch(
      `${server.baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "fix it" }),
      },
    );
    await turn.text();

    const transcript = await fetch(
      `${server.baseUrl}/api/instances/${instanceId}/chats/${chatId}/transcript`,
    );
    const page = (await transcript.json()) as {
      messages: { id: string; role: string }[];
      chunksByMessage: Record<string, ChatRenderChunk[]>;
    };
    const assistant = page.messages.find((message) => message.role === "assistant");
    const images = (page.chunksByMessage[assistant?.id ?? ""] ?? []).filter(
      (chunk) => chunk.kind === "image",
    );
    expect(images).toHaveLength(2);
    const [first, second] = images as [
      Extract<ChatRenderChunk, { kind: "image" }>,
      Extract<ChatRenderChunk, { kind: "image" }>,
    ];
    expect(first.offset).toBe(reply.indexOf("!["));
    expect(second.offset).toBe(reply.lastIndexOf("!["));
    expect(second.id).not.toBe(first.id);

    // And each id really serves the bytes that were there at its moment.
    const bytesOf = async (id: string | undefined) =>
      Buffer.from(
        await (
          await fetch(`${server.baseUrl}/api/instances/${instanceId}/uploads/${id}`)
        ).arrayBuffer(),
      );
    expect((await bytesOf(first.id)).equals(PNG)).toBe(true);
    expect((await bytesOf(second.id)).equals(rebuilt)).toBe(true);
  });

  it("keeps the image when the render is rebuilt from the event log alone", async () => {
    const { server, instanceId, assistant } = await runTurn(
      "Rendered it: ![the chart](/workspace/out/chart.png)",
      { "/workspace/out/chart.png": PNG },
    );
    if (!assistant) throw new Error("expected an assistant message");

    // Drop the stored projection, as a chat from a build that predates this
    // would have. The rebuild has only the persisted events to work from, and a
    // turn that is otherwise pure text must still be recognized as carrying
    // structure worth rendering.
    server.db
      .delete(schema.chatMessageRenders)
      .where(eq(schema.chatMessageRenders.messageId, assistant.id))
      .run();

    const transcript = await fetch(
      `${server.baseUrl}/api/instances/${instanceId}/chats/${assistant.chatId}/transcript`,
    );
    const page = (await transcript.json()) as {
      chunksByMessage: Record<string, ChatRenderChunk[]>;
    };
    const rebuilt = (page.chunksByMessage[assistant.id] ?? []).filter(
      (chunk) => chunk.kind === "image",
    );
    expect(rebuilt).toHaveLength(1);
  });

  it("records why a reference it could not read has no picture", async () => {
    const { assistant, chunks } = await runTurn(
      "I could not produce it: ![missing](/workspace/nope.png)",
      {},
    );
    const images = chunks.filter((chunk) => chunk.kind === "image");
    expect(images).toHaveLength(1);
    // A failure is committed like a snapshot, so the reason survives a reload
    // and the chip can say "file not found" instead of only the caption.
    expect(images[0]).toMatchObject({
      sourcePath: "/workspace/nope.png",
      error: "missing",
    });
    expect(images[0] && "id" in images[0] ? images[0].id : undefined).toBeUndefined();
    // And the reply itself is still exactly what the model wrote.
    expect(assistant?.content).toContain("![missing](/workspace/nope.png)");
  });

  it("fetches a remote image through the VM and serves it from here", async () => {
    // The browser never touches the remote host: the guest fetches under the
    // profile's network policy, and the transcript points at our own bytes.
    const { server, instanceId, chunks } = await runTurn(
      "From the web: ![logo](https://example.com/logo.png)",
      { "https://example.com/logo.png": PNG },
    );
    const images = chunks.filter((chunk) => chunk.kind === "image");
    expect(images).toHaveLength(1);
    const image = images[0];
    if (image?.kind !== "image") throw new Error("expected an image chunk");
    // Keyed by the URL as written, which is what the renderer matches.
    expect(image.sourcePath).toBe("https://example.com/logo.png");
    expect(image.mediaType).toBe("image/png");
    expect(image.filename).toBe("logo.png");

    const served = await fetch(`${server.baseUrl}/api/instances/${instanceId}/uploads/${image.id}`);
    expect(Buffer.from(await served.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it("says so when a remote image could not be fetched", async () => {
    const { chunks } = await runTurn("From the web: ![logo](https://example.com/gone.png)", {});
    const images = chunks.filter((chunk) => chunk.kind === "image");
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ error: "unreachable" });
  });
});
