import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createTestServer } from "./helpers";

describe("health endpoint", () => {
  let baseUrl: string;
  let cleanup: () => Promise<void>;

  beforeAll(() => {
    const server = createTestServer();
    baseUrl = server.baseUrl;
    cleanup = server.cleanup;
  });

  afterAll(async () => {
    await cleanup();
  });

  it("returns ok", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data).toEqual({ status: "ok" });
  });
});
