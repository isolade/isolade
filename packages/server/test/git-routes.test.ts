import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { gitConfigStatusSchema, signingKeysResultSchema } from "../src/contracts";
import { createTestServer } from "./helpers";

// Read-only wiring check: confirms the /api/git routes exist and return shapes
// matching the shared schemas, without mutating the real git config store (the
// identity/signing setters would write the [git] table into the profile's
// config.toml). Behavior is covered by git-config.test.ts.
describe("git config routes", () => {
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

  it("GET /api/git returns a valid git-config status shape", async () => {
    const res = await fetch(`${baseUrl}/api/git?profile=default`);
    expect(res.status).toBe(200);
    const parsed = gitConfigStatusSchema.parse(await res.json());
    expect(typeof parsed.signing.enabled).toBe("boolean");
    expect(typeof parsed.signing.configured).toBe("boolean");
  });

  it("GET /api/git/signing/keys with an unreachable socket reports not-reachable, no keys", async () => {
    const res = await fetch(
      `${baseUrl}/api/git/signing/keys?profile=default&socket=${encodeURIComponent("/nonexistent/agent.sock")}`,
    );
    expect(res.status).toBe(200);
    const parsed = signingKeysResultSchema.parse(await res.json());
    expect(parsed.reachable).toBe(false);
    expect(parsed.keys).toEqual([]);
  });
});
