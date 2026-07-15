/**
 * End-to-end chat tests that run claude -p inside a real microsandbox VM.
 * Requires: local registry + isolade/dev:latest image pushed to it (see
 * images/dev/build.sh).
 * Each test is slow (VM + LLM round-trip), so it uses a 120s timeout.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DEFAULT_ANTHROPIC_MODEL_ID, DEFAULT_OPENAI_MODEL_ID } from "../src/contracts";
import { createTestServer } from "./helpers";

async function parseSSE(
  res: Response,
): Promise<{ deltas: string[]; done: boolean; error: string | null }> {
  const deltas: string[] = [];
  let done = false;
  let error: string | null = null;

  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let currentEvent = "";

  while (true) {
    const { done: readerDone, value } = await reader.read();
    if (readerDone) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop()!;

    for (const line of lines) {
      if (line.startsWith("event: ")) {
        currentEvent = line.slice(7).trim();
      } else if (line.startsWith("data: ")) {
        const data = line.slice(6);
        if (currentEvent === "delta") deltas.push(data);
        else if (currentEvent === "done") done = true;
        else if (currentEvent === "error") error = data;
        currentEvent = "";
      }
    }
  }

  return { deltas, done, error };
}

async function sendMessage(baseUrl: string, instanceId: string, chatId: string, content: string) {
  const res = await fetch(`${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  expect(res.status).toBe(200);
  return parseSSE(res);
}

describe.skipIf(!process.env.RUN_INTEGRATION)("chat end-to-end (requires VM)", () => {
  let baseUrl: string;
  let chatManager: ReturnType<typeof createTestServer>["chatManager"];
  let cleanup: () => Promise<void>;
  let instanceId: string;

  beforeAll(async () => {
    const server = createTestServer();
    baseUrl = server.baseUrl;
    chatManager = server.chatManager;
    cleanup = server.cleanup;

    const res = await fetch(`${baseUrl}/api/instances`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "chat-e2e" }),
    });
    expect(res.status).toBe(201);
    instanceId = ((await res.json()) as { id: string }).id;
  }, 120_000);

  afterAll(async () => {
    if (instanceId) {
      await fetch(`${baseUrl}/api/instances/${instanceId}`, {
        method: "DELETE",
      });
    }
    await cleanup();
  });

  it("streams delta events and a done event for a simple message", async () => {
    const { id: chatId } = (await (
      await fetch(`${baseUrl}/api/instances/${instanceId}/chats`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: DEFAULT_ANTHROPIC_MODEL_ID }),
      })
    ).json()) as { id: string };

    const { deltas, done, error } = await sendMessage(
      baseUrl,
      instanceId,
      chatId,
      'Reply with exactly the word "pong" and nothing else.',
    );

    expect(error).toBeNull();
    expect(done).toBe(true);
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.join("").toLowerCase()).toContain("pong");
  }, 120_000);

  it("persists user and assistant messages to the DB", async () => {
    const { id: chatId } = (await (
      await fetch(`${baseUrl}/api/instances/${instanceId}/chats`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: DEFAULT_ANTHROPIC_MODEL_ID }),
      })
    ).json()) as { id: string };

    await sendMessage(baseUrl, instanceId, chatId, 'Say "ack" and nothing else.');

    const msgs = chatManager.getMessages(chatId);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.role).toBe("user");
    expect(msgs[0]!.content).toBe('Say "ack" and nothing else.');
    expect(msgs[1]!.role).toBe("assistant");
    expect(msgs[1]!.content.toLowerCase()).toContain("ack");
  }, 120_000);

  it("stores claude session ID after first message", async () => {
    const { id: chatId } = (await (
      await fetch(`${baseUrl}/api/instances/${instanceId}/chats`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: DEFAULT_ANTHROPIC_MODEL_ID }),
      })
    ).json()) as { id: string };

    await sendMessage(baseUrl, instanceId, chatId, "Say ok.");

    const chat = chatManager.get(chatId);
    expect(chat?.claudeSessionId).toBeTruthy();
  }, 120_000);

  it("carries context across turns via --resume", async () => {
    const { id: chatId } = (await (
      await fetch(`${baseUrl}/api/instances/${instanceId}/chats`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: DEFAULT_ANTHROPIC_MODEL_ID }),
      })
    ).json()) as { id: string };

    // Turn 1: plant a secret
    await sendMessage(
      baseUrl,
      instanceId,
      chatId,
      "My secret number is 7331. Acknowledge with just 'got it'.",
    );

    // Turn 2: verify context was retained
    const { deltas, error } = await sendMessage(
      baseUrl,
      instanceId,
      chatId,
      "What is my secret number? Reply with only the number.",
    );

    expect(error).toBeNull();
    expect(deltas.join("")).toContain("7331");
  }, 120_000);

  it("message history is returned from GET endpoint after chatting", async () => {
    const { id: chatId } = (await (
      await fetch(`${baseUrl}/api/instances/${instanceId}/chats`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: DEFAULT_ANTHROPIC_MODEL_ID }),
      })
    ).json()) as { id: string };

    await sendMessage(baseUrl, instanceId, chatId, 'Say "ready".');

    const res = await fetch(`${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages`);
    expect(res.status).toBe(200);
    const msgs = (await res.json()) as { role: string; content: string }[];
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.role).toBe("user");
    expect(msgs[1]!.role).toBe("assistant");
    expect(msgs[1]!.content.toLowerCase()).toContain("ready");
  }, 120_000);
});

describe.skipIf(!process.env.RUN_INTEGRATION)(
  "codex chat end-to-end (requires VM + codex auth)",
  () => {
    let baseUrl: string;
    let chatManager: ReturnType<typeof createTestServer>["chatManager"];
    let cleanup: () => Promise<void>;
    let instanceId: string;

    beforeAll(async () => {
      const server = createTestServer();
      baseUrl = server.baseUrl;
      chatManager = server.chatManager;
      cleanup = server.cleanup;

      const res = await fetch(`${baseUrl}/api/instances`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "codex-e2e" }),
      });
      expect(res.status).toBe(201);
      instanceId = ((await res.json()) as { id: string }).id;
    }, 120_000);

    afterAll(async () => {
      if (instanceId) {
        await fetch(`${baseUrl}/api/instances/${instanceId}`, {
          method: "DELETE",
        });
      }
      await cleanup();
    });

    it("returns a response to a simple message", async () => {
      const { id: chatId } = (await (
        await fetch(`${baseUrl}/api/instances/${instanceId}/chats`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: DEFAULT_OPENAI_MODEL_ID }),
        })
      ).json()) as { id: string };

      const { deltas, done, error } = await sendMessage(
        baseUrl,
        instanceId,
        chatId,
        'Reply with exactly the word "pong" and nothing else.',
      );

      expect(error).toBeNull();
      expect(done).toBe(true);
      expect(deltas.join("").toLowerCase()).toContain("pong");
    }, 120_000);

    it("persists user and assistant messages to the DB", async () => {
      const { id: chatId } = (await (
        await fetch(`${baseUrl}/api/instances/${instanceId}/chats`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: DEFAULT_OPENAI_MODEL_ID }),
        })
      ).json()) as { id: string };

      await sendMessage(baseUrl, instanceId, chatId, 'Say "ack" and nothing else.');

      const msgs = chatManager.getMessages(chatId);
      expect(msgs).toHaveLength(2);
      expect(msgs[0]!.role).toBe("user");
      expect(msgs[1]!.role).toBe("assistant");
      expect(msgs[1]!.content.toLowerCase()).toContain("ack");
    }, 120_000);

    it("stores codex thread ID after first message", async () => {
      const { id: chatId } = (await (
        await fetch(`${baseUrl}/api/instances/${instanceId}/chats`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: DEFAULT_OPENAI_MODEL_ID }),
        })
      ).json()) as { id: string };

      await sendMessage(baseUrl, instanceId, chatId, "Say ok.");

      const chat = chatManager.get(chatId);
      expect(chat?.codexThreadId).toBeTruthy();
    }, 120_000);

    it("carries context across turns via thread resume", async () => {
      const { id: chatId } = (await (
        await fetch(`${baseUrl}/api/instances/${instanceId}/chats`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: DEFAULT_OPENAI_MODEL_ID }),
        })
      ).json()) as { id: string };

      await sendMessage(
        baseUrl,
        instanceId,
        chatId,
        "My lucky number is 9182. Acknowledge with just 'got it'.",
      );

      const { deltas, error } = await sendMessage(
        baseUrl,
        instanceId,
        chatId,
        "What is my lucky number? Reply with only the number.",
      );

      expect(error).toBeNull();
      expect(deltas.join("")).toContain("9182");
    }, 120_000);
  },
);
