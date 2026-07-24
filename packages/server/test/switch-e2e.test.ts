/**
 * End-to-end cross-provider switch, against a real microsandbox VM. Like the
 * other chat-e2e suites this needs a VM and, for the Codex leg, Codex auth in
 * the profile, so it is gated on RUN_INTEGRATION.
 *
 * It guards the regression where activating a Claude→Codex switch disposed the
 * chat's live Claude process right as the Codex app-server was starting, which
 * churned the VM's exec-streams and wedged the Codex turn (the "three dancing
 * dots forever" symptom). The fix only retires the Claude process when the
 * target is Claude.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DEFAULT_ANTHROPIC_MODEL_ID, DEFAULT_OPENAI_MODEL_ID } from "../src/contracts";
import { createTestServer } from "./helpers";

async function parseSSE(res: Response): Promise<{
  deltas: string[];
  done: boolean;
  error: string | null;
}> {
  const deltas: string[] = [];
  let done = false;
  let error: string | null = null;
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let currentEvent = "";
  while (true) {
    const { done: rd, value } = await reader.read();
    if (rd) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop()!;
    for (const line of lines) {
      if (line.startsWith("event: ")) currentEvent = line.slice(7).trim();
      else if (line.startsWith("data: ")) {
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

async function send(baseUrl: string, instanceId: string, chatId: string, content: string) {
  const res = await fetch(`${baseUrl}/api/instances/${instanceId}/chats/${chatId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  expect(res.status).toBe(200);
  return parseSSE(res);
}

describe.skipIf(!process.env.RUN_INTEGRATION)("cross-provider switch e2e (requires VM)", () => {
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
      body: JSON.stringify({ profile: process.env.SWITCH_PROFILE || "isolade" }),
    });
    expect(res.status).toBe(201);
    instanceId = ((await res.json()) as { id: string }).id;
  }, 180_000);

  afterAll(async () => {
    if (instanceId) {
      await fetch(`${baseUrl}/api/instances/${instanceId}`, { method: "DELETE" });
    }
    await cleanup();
  });

  it("switches Claude → Codex and carries context", async () => {
    const { id: chatId } = (await (
      await fetch(`${baseUrl}/api/instances/${instanceId}/chats`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: DEFAULT_ANTHROPIC_MODEL_ID }),
      })
    ).json()) as { id: string };

    // Turn 1 on Claude: plant a fact.
    const first = await send(
      baseUrl,
      instanceId,
      chatId,
      "My secret number is 7331. Reply with just 'ok'.",
    );
    expect(first.error).toBeNull();
    expect(first.done).toBe(true);

    // Select a Codex model → records a pending switch, still on Claude.
    const patch = await fetch(`${baseUrl}/api/instances/${instanceId}/chats/${chatId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: DEFAULT_OPENAI_MODEL_ID }),
    });
    const patched = (await patch.json()) as { provider: string; pendingSwitch?: unknown };
    expect(patched.provider).toBe("anthropic");
    expect(patched.pendingSwitch).toBeDefined();

    // Turn 2 activates the switch on Codex and must recall the number from the
    // handoff. Critically, it must NOT hang: it either answers or surfaces a
    // real provider error well within the turn timeout.
    const second = await send(
      baseUrl,
      instanceId,
      chatId,
      "What is my secret number? Reply with only the number.",
    );
    expect(second.error).toBeNull();
    expect(second.done).toBe(true);
    expect(second.deltas.join("")).toContain("7331");

    const after = chatManager.get(chatId)!;
    expect(after.provider).toBe("openai");
    expect(after.model).toBe(DEFAULT_OPENAI_MODEL_ID);
  }, 180_000);
});
