import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createTestServer } from "./helpers";

// Terminal CRUD + WebSocket guard behaviour. These don't need a live VM: the
// HTTP handlers only touch the DB, and the socket handler validates the
// instance/terminal and closes before it ever reaches the sandbox. The
// command-streaming path (which does need a real VM + workspace image) is
// exercised by manual/integration runs, not here.
describe("terminal API", () => {
  let baseUrl: string;
  let wsUrl: string;
  let instanceId: string;
  let cleanup: () => Promise<void>;

  beforeEach(() => {
    const server = createTestServer();
    baseUrl = server.baseUrl;
    wsUrl = server.wsUrl;
    instanceId = server.seedInstance();
    cleanup = server.cleanup;
  });

  afterEach(async () => {
    await cleanup();
  });

  const createTerminal = () =>
    fetch(`${baseUrl}/api/instances/${instanceId}/terminals`, {
      method: "POST",
    });

  it("creates a terminal and returns 201", async () => {
    const res = await createTerminal();
    expect(res.status).toBe(201);
    const terminal = (await res.json()) as { id: string; instanceId: string };
    expect(terminal.id).toBeTruthy();
    expect(terminal.instanceId).toBe(instanceId);
  });

  it("returns 404 creating a terminal on an unknown instance", async () => {
    const res = await fetch(`${baseUrl}/api/instances/does-not-exist/terminals`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });

  it("lists and deletes terminals", async () => {
    const created = (await (await createTerminal()).json()) as { id: string };

    const list = (await (
      await fetch(`${baseUrl}/api/instances/${instanceId}/terminals`)
    ).json()) as unknown[];
    expect(list).toHaveLength(1);

    const del = await fetch(`${baseUrl}/api/instances/${instanceId}/terminals/${created.id}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(200);

    const after = (await (
      await fetch(`${baseUrl}/api/instances/${instanceId}/terminals`)
    ).json()) as unknown[];
    expect(after).toHaveLength(0);
  });

  const closeCode = (path: string) =>
    new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`${wsUrl}${path}`);
      const timer = setTimeout(() => reject(new Error("timeout waiting for close")), 5000);
      ws.onclose = (e) => {
        clearTimeout(timer);
        resolve(e.code);
      };
      ws.onerror = () => {}; // a close with a policy code can also surface as error
    });

  it("closes the socket with 1008 for an unknown instance", async () => {
    const code = await closeCode(`/api/instances/does-not-exist/terminals/whatever/socket`);
    expect(code).toBe(1008);
  });

  it("closes the socket with 1008 for an unknown terminal", async () => {
    const code = await closeCode(`/api/instances/${instanceId}/terminals/does-not-exist/socket`);
    expect(code).toBe(1008);
  });
});
