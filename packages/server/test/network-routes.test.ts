import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { networkConfigSchema } from "../src/contracts";
import { createTestServer } from "./helpers";

// Read-only wiring check: confirms GET /api/network exists and returns a shape
// matching the shared schema. We deliberately don't POST here, since the real
// per-profile NetworkConfigStore writes the [network] table into the profile's
// config.toml, so a mutation would clobber the developer's actual config.
// Persistence is covered
// by network-config-store.test.ts and the rule mapping by sandbox vms.test.ts.
describe("network config routes", () => {
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

  it("GET /api/network returns a valid network-config shape", async () => {
    const res = await fetch(`${baseUrl}/api/network?profile=default`);
    expect(res.status).toBe(200);
    const parsed = networkConfigSchema.parse(await res.json());
    expect(["open", "allowlist"]).toContain(parsed.internet);
    expect(Array.isArray(parsed.allowedDomains)).toBe(true);
  });
});
