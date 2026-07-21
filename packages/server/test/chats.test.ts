import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { DEFAULT_ANTHROPIC_MODEL_ID } from "../src/contracts";
import { schema } from "../src/db";
import { createTestServer } from "./helpers";

describe("chat API", () => {
  let baseUrl: string;
  let seedInstance: () => string;
  let cleanup: () => Promise<void>;
  let chatManager: ReturnType<typeof createTestServer>["chatManager"];
  let db: ReturnType<typeof createTestServer>["db"];

  beforeAll(() => {
    const server = createTestServer();
    baseUrl = server.baseUrl;
    seedInstance = server.seedInstance;
    cleanup = server.cleanup;
    chatManager = server.chatManager;
    db = server.db;
  });

  afterAll(async () => {
    await cleanup();
  });

  // ── /api/chat/models ───────────────────────────────────────────────────────

  describe("GET /api/chat/models", () => {
    it("returns a non-empty list with id, name, provider", async () => {
      const res = await fetch(`${baseUrl}/api/chat/models`);
      expect(res.status).toBe(200);
      const { models } = (await res.json()) as {
        models: { id: string; name: string; provider: string }[];
      };
      expect(models.length).toBeGreaterThan(0);
      for (const m of models) {
        expect(m.id).toBeTruthy();
        expect(m.name).toBeTruthy();
        expect(["anthropic", "openai"]).toContain(m.provider);
      }
    });

    it("includes both anthropic and openai models from the static catalog", async () => {
      const { models } = (await (await fetch(`${baseUrl}/api/chat/models`)).json()) as {
        models: { provider: string }[];
      };
      expect(models.some((m) => m.provider === "anthropic")).toBe(true);
      expect(models.some((m) => m.provider === "openai")).toBe(true);
    });
  });

  // ── create chat ────────────────────────────────────────────────────────────

  describe("POST /api/instances/:id/chats", () => {
    it("creates a chat and returns 201", async () => {
      const instanceId = seedInstance();
      const res = await fetch(`${baseUrl}/api/instances/${instanceId}/chats`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: DEFAULT_ANTHROPIC_MODEL_ID }),
      });
      expect(res.status).toBe(201);
      const chat = (await res.json()) as {
        id: string;
        instanceId: string;
        model: string;
        provider: string;
      };
      expect(chat.id).toBeTruthy();
      expect(chat.instanceId).toBe(instanceId);
      expect(chat.model).toBe(DEFAULT_ANTHROPIC_MODEL_ID);
      expect(chat.provider).toBe("anthropic");
    });

    it("returns 400 for missing model", async () => {
      const instanceId = seedInstance();
      const res = await fetch(`${baseUrl}/api/instances/${instanceId}/chats`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 for unknown model", async () => {
      const instanceId = seedInstance();
      const res = await fetch(`${baseUrl}/api/instances/${instanceId}/chats`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-99-ultra" }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 404 for nonexistent instance", async () => {
      const res = await fetch(`${baseUrl}/api/instances/nonexistent/chats`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: DEFAULT_ANTHROPIC_MODEL_ID }),
      });
      expect(res.status).toBe(404);
    });
  });

  // ── list chats ─────────────────────────────────────────────────────────────

  describe("GET /api/instances/:id/chats", () => {
    it("returns chats for the instance", async () => {
      const instanceId = seedInstance();
      await fetch(`${baseUrl}/api/instances/${instanceId}/chats`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: DEFAULT_ANTHROPIC_MODEL_ID }),
      });
      await fetch(`${baseUrl}/api/instances/${instanceId}/chats`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-haiku-4-5-20251001" }),
      });

      const res = await fetch(`${baseUrl}/api/instances/${instanceId}/chats`);
      expect(res.status).toBe(200);
      const list = (await res.json()) as { id: string; instanceId: string }[];
      expect(list).toHaveLength(2);
      expect(list.every((c) => c.instanceId === instanceId)).toBe(true);
    });

    it("returns 404 for nonexistent instance", async () => {
      const res = await fetch(`${baseUrl}/api/instances/nonexistent/chats`);
      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/chats", () => {
    it("returns all chats across instances", async () => {
      const server2 = createTestServer();
      try {
        // Use a fresh server for an isolated count
        const id1 = server2.seedInstance();
        const id2 = server2.seedInstance();
        await fetch(`${server2.baseUrl}/api/instances/${id1}/chats`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: DEFAULT_ANTHROPIC_MODEL_ID }),
        });
        await fetch(`${server2.baseUrl}/api/instances/${id2}/chats`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "claude-haiku-4-5-20251001" }),
        });

        const res = await fetch(`${server2.baseUrl}/api/chats`);
        expect(res.status).toBe(200);
        const all = (await res.json()) as { id: string }[];
        expect(all).toHaveLength(2);
      } finally {
        await server2.cleanup();
      }
    });
  });

  // ── delete chat ────────────────────────────────────────────────────────────

  describe("DELETE /api/instances/:id/chats/:chatId", () => {
    it("deletes the chat and returns 200", async () => {
      const instanceId = seedInstance();
      const createRes = await fetch(`${baseUrl}/api/instances/${instanceId}/chats`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: DEFAULT_ANTHROPIC_MODEL_ID }),
      });
      const { id: chatId } = (await createRes.json()) as { id: string };

      const delRes = await fetch(`${baseUrl}/api/instances/${instanceId}/chats/${chatId}`, {
        method: "DELETE",
      });
      expect(delRes.status).toBe(200);

      // Verify messages endpoint returns 404
      const msgsRes = await fetch(
        `${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages`,
      );
      expect(msgsRes.status).toBe(404);
    });

    it("returns 404 for nonexistent chat", async () => {
      const instanceId = seedInstance();
      const res = await fetch(`${baseUrl}/api/instances/${instanceId}/chats/nonexistent`, {
        method: "DELETE",
      });
      expect(res.status).toBe(404);
    });

    it("does not expose a chat through another instance id", async () => {
      const ownerId = seedInstance();
      const otherId = seedInstance();
      const chat = chatManager.create(ownerId, DEFAULT_ANTHROPIC_MODEL_ID, "anthropic", "high");
      chatManager.addMessage(chat.id, "user", "private");

      for (const suffix of ["messages", "transcript", "events", "render?ids=unknown"]) {
        const response = await fetch(
          `${baseUrl}/api/instances/${otherId}/chats/${chat.id}/${suffix}`,
        );
        expect(response.status).toBe(404);
      }
      const deleteResponse = await fetch(`${baseUrl}/api/instances/${otherId}/chats/${chat.id}`, {
        method: "DELETE",
      });
      expect(deleteResponse.status).toBe(404);
      expect(chatManager.get(chat.id)).toBeDefined();
    });

    it("rejects a transcript cursor from another chat", async () => {
      const instanceId = seedInstance();
      const first = chatManager.create(instanceId, DEFAULT_ANTHROPIC_MODEL_ID, "anthropic", "high");
      const second = chatManager.create(
        instanceId,
        DEFAULT_ANTHROPIC_MODEL_ID,
        "anthropic",
        "high",
      );
      const foreign = chatManager.addMessage(second.id, "user", "foreign");
      const response = await fetch(
        `${baseUrl}/api/instances/${instanceId}/chats/${first.id}/transcript?before=${foreign.id}`,
      );
      expect(response.status).toBe(400);
    });
  });

  describe("bounded chat transcript", () => {
    it("returns a bounded transcript page and compact visible render chunks", async () => {
      const instanceId = seedInstance();
      const chat = chatManager.create(instanceId, DEFAULT_ANTHROPIC_MODEL_ID, "anthropic", "high");
      const user = chatManager.addMessage(chat.id, "user", "hello");
      const assistant = chatManager.addMessage(chat.id, "assistant", "done", {
        parentId: user.id,
      });
      chatManager.setActiveLeaf(chat.id, assistant.id);
      chatManager.appendEvent(chat.id, assistant.id, 0, "raw", {
        source: "claude",
        payload: { type: "cached" },
      });
      chatManager.appendEvent(chat.id, assistant.id, 1, "tool_call_start", {
        id: "tool-1",
        name: "Read",
      });
      chatManager.appendEvent(chat.id, assistant.id, 2, "tool_call_result", {
        id: "tool-1",
        output: "ok",
      });
      chatManager.appendEvent(chat.id, assistant.id, 3, "delta", "done");
      const transcriptRes = await fetch(
        `${baseUrl}/api/instances/${instanceId}/chats/${chat.id}/transcript?limit=1`,
      );
      expect(transcriptRes.status).toBe(200);
      const transcript = (await transcriptRes.json()) as {
        messages: { id: string }[];
        hasMore: boolean;
      };
      expect(transcript.messages.map((message) => message.id)).toEqual([assistant.id]);
      expect(transcript.hasMore).toBe(true);

      const plain = chatManager.addMessage(chat.id, "assistant", "plain", {
        parentId: assistant.id,
      });
      chatManager.appendEvent(chat.id, plain.id, 0, "delta", "plain");

      const renderRes = await fetch(
        `${baseUrl}/api/instances/${instanceId}/chats/${chat.id}/render?ids=${assistant.id},${plain.id}`,
      );
      expect(renderRes.status).toBe(200);
      const render = (await renderRes.json()) as {
        chunksByMessage: Record<string, { kind: string }[]>;
      };
      expect(render.chunksByMessage[assistant.id]?.map((chunk) => chunk.kind)).toEqual([
        "tool",
        "text",
      ]);
      expect(render.chunksByMessage[plain.id]).toEqual([]);
      expect(chatManager.getMessageRenders(chat.id, [assistant.id, plain.id])).toHaveLength(2);

      const debugRenderRes = await fetch(
        `${baseUrl}/api/instances/${instanceId}/chats/${chat.id}/render?debug=1&ids=${assistant.id}`,
      );
      const debugRender = (await debugRenderRes.json()) as {
        chunksByMessage: Record<string, { kind: string }[]>;
      };
      expect(debugRender.chunksByMessage[assistant.id]?.map((chunk) => chunk.kind)).toEqual([
        "raw",
        "tool",
        "text",
      ]);

      chatManager.beginInFlightTurn(chat.id, "running-message");
      chatManager.appendEvent(chat.id, "running-message", 0, "raw", {
        source: "claude",
        payload: { type: "live-debug" },
      });
      chatManager.appendEvent(chat.id, "running-message", 1, "delta", "partial");
      const inFlightRes = await fetch(
        `${baseUrl}/api/instances/${instanceId}/chats/${chat.id}/events/in-flight`,
      );
      expect(inFlightRes.status).toBe(200);
      const inFlight = (await inFlightRes.json()) as {
        messageId: string;
        lastSeq: number;
        chunks: { kind: string; text?: string }[];
      };
      expect(inFlight).toEqual({
        messageId: "running-message",
        lastSeq: 1,
        chunks: [{ kind: "text", text: "partial" }],
      });

      const debugInFlightRes = await fetch(
        `${baseUrl}/api/instances/${instanceId}/chats/${chat.id}/events/in-flight?debug=1`,
      );
      const debugInFlight = (await debugInFlightRes.json()) as {
        chunks: { kind: string }[];
      };
      expect(debugInFlight.chunks.map((chunk) => chunk.kind)).toEqual(["raw", "text"]);

      const inFlightRenderResponse = await fetch(
        `${baseUrl}/api/instances/${instanceId}/chats/${chat.id}/render?ids=running-message`,
      );
      const inFlightRender = (await inFlightRenderResponse.json()) as {
        chunksByMessage: Record<string, { kind: string; text?: string }[]>;
      };
      expect(inFlightRender.chunksByMessage["running-message"]).toEqual([
        { kind: "text", text: "partial" },
      ]);
    });

    it("does not cache user, unknown, or another chat's message ids", async () => {
      const instanceId = seedInstance();
      const chat = chatManager.create(instanceId, DEFAULT_ANTHROPIC_MODEL_ID, "anthropic", "high");
      const user = chatManager.addMessage(chat.id, "user", "hello");
      const otherChat = chatManager.create(
        instanceId,
        DEFAULT_ANTHROPIC_MODEL_ID,
        "anthropic",
        "high",
      );
      const otherAssistant = chatManager.addMessage(otherChat.id, "assistant", "done");
      chatManager.saveMessageRender(otherChat.id, otherAssistant.id, [
        { kind: "tool", id: "tool-1", name: "Read", status: "done", output: "ok" },
      ]);
      const before = chatManager.getMessageRenders(otherChat.id, [otherAssistant.id])[0]!;
      const unknownId = crypto.randomUUID();

      const response = await fetch(
        `${baseUrl}/api/instances/${instanceId}/chats/${chat.id}/render?ids=${otherAssistant.id},${user.id},${unknownId}`,
      );
      expect(response.status).toBe(200);
      const render = (await response.json()) as {
        chunksByMessage: Record<string, { kind: string }[]>;
      };

      expect(render.chunksByMessage).toEqual({
        [otherAssistant.id]: [],
        [user.id]: [],
        [unknownId]: [],
      });
      expect(chatManager.getMessageRenders(otherChat.id, [otherAssistant.id])[0]).toEqual(before);
      expect(chatManager.getMessageRenders(chat.id, [user.id, unknownId])).toHaveLength(0);
    });

    it("bounds multi-megabyte tool payloads in transcript pages and loads full details on demand", async () => {
      const instanceId = seedInstance();
      const chat = chatManager.create(instanceId, DEFAULT_ANTHROPIC_MODEL_ID, "anthropic", "high");
      const user = chatManager.addMessage(chat.id, "user", "run it");
      const assistant = chatManager.addMessage(chat.id, "assistant", "finished", {
        parentId: user.id,
      });
      chatManager.setActiveLeaf(chat.id, assistant.id);
      const largeInput = { command: "x".repeat(1_500_000) };
      const largeOutput = "y".repeat(2_000_000);
      chatManager.appendEvent(chat.id, assistant.id, 0, "tool_call_start", {
        id: "large-tool",
        name: "Bash",
      });
      chatManager.appendEvent(chat.id, assistant.id, 1, "tool_call_input", {
        id: "large-tool",
        input: largeInput,
      });
      chatManager.appendEvent(chat.id, assistant.id, 2, "tool_call_result", {
        id: "large-tool",
        output: largeOutput,
      });
      chatManager.appendEvent(chat.id, assistant.id, 3, "tool_call_start", {
        id: "sibling-tool",
        name: "Read",
      });
      chatManager.appendEvent(chat.id, assistant.id, 4, "tool_call_input", {
        id: "sibling-tool",
        input: { file_path: "/workspace/sibling.txt" },
      });

      const transcriptResponse = await fetch(
        `${baseUrl}/api/instances/${instanceId}/chats/${chat.id}/transcript`,
      );
      const transcriptBody = await transcriptResponse.text();
      expect(transcriptResponse.status).toBe(200);
      expect(transcriptBody.length).toBeLessThan(20_000);
      const transcript = JSON.parse(transcriptBody) as {
        chunksByMessage: Record<
          string,
          {
            kind: string;
            summary?: string;
            input?: unknown;
            output?: string;
            detailsAvailable?: boolean;
          }[]
        >;
      };
      const preview = transcript.chunksByMessage[assistant.id]?.[0];
      expect(preview?.detailsAvailable).toBe(true);
      expect(preview?.summary).toStartWith("x");
      expect(preview?.summary?.length).toBeLessThan(600);
      expect(JSON.stringify(preview?.input).length).toBeLessThan(1_200);
      expect(preview?.output?.length).toBeLessThan(2_100);

      const detailResponse = await fetch(
        `${baseUrl}/api/instances/${instanceId}/chats/${chat.id}/render?ids=${assistant.id}`,
      );
      const details = (await detailResponse.json()) as {
        chunksByMessage: Record<string, { input?: unknown; output?: string }[]>;
      };
      const full = details.chunksByMessage[assistant.id]?.[0];
      expect(full?.input).toEqual(largeInput);
      expect(full?.output).toBe(largeOutput);

      const focusedResponse = await fetch(
        `${baseUrl}/api/instances/${instanceId}/chats/${chat.id}/render?ids=${assistant.id}&toolId=large-tool`,
      );
      const focused = (await focusedResponse.json()) as {
        chunksByMessage: Record<string, { id?: string; input?: unknown; output?: string }[]>;
      };
      expect(focused.chunksByMessage[assistant.id]).toHaveLength(1);
      expect(focused.chunksByMessage[assistant.id]?.[0]).toMatchObject({
        id: "large-tool",
        input: largeInput,
        output: largeOutput,
      });
    });

    it("lazily heals bounded tool previews written before summaries", async () => {
      const instanceId = seedInstance();
      const chat = chatManager.create(instanceId, DEFAULT_ANTHROPIC_MODEL_ID, "anthropic", "high");
      const assistant = chatManager.addMessage(chat.id, "assistant", "finished");
      chatManager.setActiveLeaf(chat.id, assistant.id);
      chatManager.saveMessageRender(chat.id, assistant.id, [
        {
          kind: "tool",
          id: "legacy-tool",
          name: "Shell",
          input: { command: `echo legacy ${"x".repeat(2_000)}` },
          status: "done",
        },
      ]);
      const legacyPreview = [
        {
          kind: "tool",
          id: "legacy-tool",
          name: "Shell",
          input: `${"x".repeat(1_024)}…`,
          status: "done",
          detailsAvailable: true,
        },
      ];
      db.update(schema.chatMessageRenders)
        .set({ previewChunks: JSON.stringify(legacyPreview) })
        .where(eq(schema.chatMessageRenders.messageId, assistant.id))
        .run();

      const response = await fetch(
        `${baseUrl}/api/instances/${instanceId}/chats/${chat.id}/transcript`,
      );
      const transcript = (await response.json()) as {
        chunksByMessage: Record<string, { summary?: string }[]>;
      };
      expect(transcript.chunksByMessage[assistant.id]?.[0]?.summary).toStartWith("echo legacy ");
      const healed = JSON.parse(
        chatManager.getMessageRenders(chat.id, [assistant.id])[0]!.previewChunks,
      ) as { summary?: string }[];
      expect(healed[0]?.summary).toStartWith("echo legacy ");
    });
  });

  describe("POST /api/instances/:id/chats/:chatId/messages", () => {
    it("returns 404 for nonexistent instance", async () => {
      const res = await fetch(`${baseUrl}/api/instances/nonexistent/chats/any/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "hello" }),
      });
      expect(res.status).toBe(404);
    });

    it("returns 404 for nonexistent chat", async () => {
      const instanceId = seedInstance();
      const res = await fetch(`${baseUrl}/api/instances/${instanceId}/chats/nonexistent/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "hello" }),
      });
      expect(res.status).toBe(404);
    });

    it("returns 400 when content is missing", async () => {
      const instanceId = seedInstance();
      const { id: chatId } = (await (
        await fetch(`${baseUrl}/api/instances/${instanceId}/chats`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: DEFAULT_ANTHROPIC_MODEL_ID }),
        })
      ).json()) as { id: string };

      const res = await fetch(`${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });
  });

  // ── instance deletion cascade ──────────────────────────────────────────────

  describe("instance deletion cascade", () => {
    it("deleting an instance removes its chats and messages", async () => {
      const server2 = createTestServer();
      try {
        const instanceId = server2.seedInstance();

        // Create two chats
        const c1 = (await (
          await fetch(`${server2.baseUrl}/api/instances/${instanceId}/chats`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: DEFAULT_ANTHROPIC_MODEL_ID }),
          })
        ).json()) as { id: string };
        const c2 = (await (
          await fetch(`${server2.baseUrl}/api/instances/${instanceId}/chats`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: "claude-haiku-4-5-20251001" }),
          })
        ).json()) as { id: string };

        // Seed a message directly via chatManager
        server2.chatManager.addMessage(c1.id, "user", "hello");
        server2.chatManager.addMessage(c1.id, "assistant", "hi");

        // Verify they exist
        expect(server2.chatManager.list(instanceId)).toHaveLength(2);
        expect(server2.chatManager.getMessages(c1.id)).toHaveLength(2);

        // Delete the instance (no real VM to destroy, so sandboxClient.destroyVm will fail silently)
        await fetch(`${server2.baseUrl}/api/instances/${instanceId}`, {
          method: "DELETE",
        });

        // Chats and messages should be gone
        expect(server2.chatManager.list(instanceId)).toHaveLength(0);
        expect(server2.chatManager.getMessages(c1.id)).toHaveLength(0);
        expect(server2.chatManager.getMessages(c2.id)).toHaveLength(0);
      } finally {
        await server2.cleanup();
      }
    });
  });
});
