import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DEFAULT_ANTHROPIC_MODEL_ID } from "../src/contracts";
import { createTestServer } from "./helpers";

describe("chat API", () => {
  let baseUrl: string;
  let seedInstance: () => string;
  let cleanup: () => Promise<void>;

  beforeAll(() => {
    const server = createTestServer();
    baseUrl = server.baseUrl;
    seedInstance = server.seedInstance;
    cleanup = server.cleanup;
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
  });

  // ── messages ───────────────────────────────────────────────────────────────

  describe("GET /api/instances/:id/chats/:chatId/messages", () => {
    it("returns empty array for a new chat", async () => {
      const instanceId = seedInstance();
      const { id: chatId } = (await (
        await fetch(`${baseUrl}/api/instances/${instanceId}/chats`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: DEFAULT_ANTHROPIC_MODEL_ID }),
        })
      ).json()) as { id: string };

      const res = await fetch(`${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    });

    it("returns 404 for nonexistent chat", async () => {
      const instanceId = seedInstance();
      const res = await fetch(`${baseUrl}/api/instances/${instanceId}/chats/nonexistent/messages`);
      expect(res.status).toBe(404);
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
