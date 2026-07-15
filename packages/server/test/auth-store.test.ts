import { describe, expect, it } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore, parseAuthFreshness, parseExpiresAt } from "../src/auth-store";

function tempStore(): AuthStore {
  const dir = mkdtempSync(join(tmpdir(), "gc-auth-"));
  return new AuthStore(dir);
}

function jwtWithExp(expSeconds: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url");
  return `header.${payload}.sig`;
}

describe("AuthStore", () => {
  it("reads null until a credential is stored, then the stored blob", () => {
    const store = tempStore();
    expect(store.read("claude")).toBeNull();
    expect(store.has("claude")).toBe(false);

    store.write("claude", "from-store");
    expect(store.read("claude")).toBe("from-store");
    expect(store.has("claude")).toBe(true);
  });

  it("never reads from the host: unset providers read null", () => {
    const store = tempStore();
    expect(store.read("codex")).toBeNull();
    expect(store.has("codex")).toBe(false);
    expect(store.read("claude")).toBeNull();
    expect(store.has("claude")).toBe(false);
  });

  it("writes credential files with 0600 perms", () => {
    const store = tempStore();
    store.write("codex", "{}");
    const mode = statSync(store.path("codex")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("removes a stored credential", () => {
    const store = tempStore();
    store.write("claude", "from-store");
    expect(store.has("claude")).toBe(true);
    expect(store.remove("claude")).toBe(true);
    expect(store.has("claude")).toBe(false);
    // Removing a non-existent file is a no-op (false), not an error.
    expect(store.remove("claude")).toBe(false);
  });

  it("parses claude expiry (ms field) and codex expiry (JWT exp seconds)", () => {
    expect(
      parseExpiresAt("claude", JSON.stringify({ claudeAiOauth: { expiresAt: 1_700_000_000_000 } })),
    ).toBe(1_700_000_000_000);

    expect(
      parseExpiresAt(
        "codex",
        JSON.stringify({ tokens: { access_token: jwtWithExp(1_700_000_000) } }),
      ),
    ).toBe(1_700_000_000_000);
  });

  it("parses codex last_refresh as a freshness tie-breaker", () => {
    const lastRefresh = "2026-07-05T12:00:00.123456789Z";
    expect(
      parseAuthFreshness(
        "codex",
        JSON.stringify({
          tokens: { access_token: jwtWithExp(1_700_000_000) },
          last_refresh: lastRefresh,
        }),
      ),
    ).toEqual({
      expiresAt: 1_700_000_000_000,
      refreshedAt: Date.parse(lastRefresh),
    });
  });

  it("returns null expiry for unparseable or missing data", () => {
    expect(parseExpiresAt("claude", "not json")).toBeNull();
    expect(parseExpiresAt("claude", JSON.stringify({}))).toBeNull();
    expect(parseExpiresAt("codex", JSON.stringify({ tokens: {} }))).toBeNull();
  });
});
