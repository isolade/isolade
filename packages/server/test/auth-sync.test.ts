import { describe, expect, it } from "bun:test";
import { buildAuthSyncScript, chooseSyncSide, chooseSyncSideFromRaw } from "../src/auth-sync";

const claudeBlob = (expiresAt: number) =>
  JSON.stringify({
    claudeAiOauth: { accessToken: "a", refreshToken: "r", expiresAt },
  });

function codexBlob(expSeconds: number, lastRefresh?: string): string {
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url");
  return JSON.stringify({
    tokens: { access_token: `h.${payload}.s`, refresh_token: "r" },
    ...(lastRefresh ? { last_refresh: lastRefresh } : {}),
  });
}

describe("chooseSyncSide", () => {
  it("leaves both-absent and both-equal alone", () => {
    expect(
      chooseSyncSide({ exists: false, expiresAt: null }, { exists: false, expiresAt: null }),
    ).toBe("none");
    expect(chooseSyncSide({ exists: true, expiresAt: 100 }, { exists: true, expiresAt: 100 })).toBe(
      "none",
    );
  });

  it("a missing store entry (logout) deletes the local copy, never resurrects it", () => {
    expect(
      chooseSyncSide({ exists: true, expiresAt: 100 }, { exists: false, expiresAt: null }),
    ).toBe("delete-local");
  });

  it("seeds a VM-local copy from the store when local is missing", () => {
    expect(
      chooseSyncSide({ exists: false, expiresAt: null }, { exists: true, expiresAt: 100 }),
    ).toBe("mount");
  });

  it("higher expiry wins", () => {
    expect(chooseSyncSide({ exists: true, expiresAt: 200 }, { exists: true, expiresAt: 100 })).toBe(
      "local",
    );
    expect(chooseSyncSide({ exists: true, expiresAt: 100 }, { exists: true, expiresAt: 200 })).toBe(
      "mount",
    );
  });

  it("uses refresh timestamp as the tie-breaker", () => {
    expect(
      chooseSyncSide(
        { exists: true, expiresAt: 100, refreshedAt: 200 },
        { exists: true, expiresAt: 100, refreshedAt: 100 },
      ),
    ).toBe("local");
    expect(
      chooseSyncSide(
        { exists: true, expiresAt: 100, refreshedAt: 100 },
        { exists: true, expiresAt: 100, refreshedAt: 200 },
      ),
    ).toBe("mount");
  });

  it("a real expiry beats an unparseable one", () => {
    expect(
      chooseSyncSide({ exists: true, expiresAt: null }, { exists: true, expiresAt: 100 }),
    ).toBe("mount");
    expect(
      chooseSyncSide({ exists: true, expiresAt: 100 }, { exists: true, expiresAt: null }),
    ).toBe("local");
    // both unparseable but present → leave alone, don't thrash
    expect(
      chooseSyncSide({ exists: true, expiresAt: null }, { exists: true, expiresAt: null }),
    ).toBe("none");
  });
});

describe("chooseSyncSideFromRaw", () => {
  it("decides claude refresh propagation by expiry", () => {
    expect(chooseSyncSideFromRaw("claude", claudeBlob(2000), claudeBlob(1000))).toBe("local");
    expect(chooseSyncSideFromRaw("claude", claudeBlob(1000), claudeBlob(2000))).toBe("mount");
  });

  it("decides codex refresh propagation by JWT exp", () => {
    expect(chooseSyncSideFromRaw("codex", codexBlob(2000), codexBlob(1000))).toBe("local");
    expect(chooseSyncSideFromRaw("codex", codexBlob(1000), codexBlob(2000))).toBe("mount");
  });

  it("decides codex refresh propagation by last_refresh when JWT exp ties", () => {
    expect(
      chooseSyncSideFromRaw(
        "codex",
        codexBlob(2000, "2026-07-05T12:00:01.000000000Z"),
        codexBlob(2000, "2026-07-05T12:00:00.000000000Z"),
      ),
    ).toBe("local");
    expect(
      chooseSyncSideFromRaw(
        "codex",
        codexBlob(2000, "2026-07-05T12:00:00.000000000Z"),
        codexBlob(2000, "2026-07-05T12:00:01.000000000Z"),
      ),
    ).toBe("mount");
  });

  it("treats a null blob as absent", () => {
    expect(chooseSyncSideFromRaw("claude", claudeBlob(1000), null)).toBe("delete-local");
    expect(chooseSyncSideFromRaw("claude", null, claudeBlob(1000))).toBe("mount");
    expect(chooseSyncSideFromRaw("claude", null, null)).toBe("none");
  });
});

describe("buildAuthSyncScript", () => {
  it("embeds the mount base + provider paths and is syntactically valid JS", () => {
    const script = buildAuthSyncScript("/run/isolade-auth", { pollMs: 1234 });
    expect(script).toContain("/run/isolade-auth");
    expect(script).toContain(".claude/.credentials.json");
    expect(script).toContain(".codex/auth.json");
    expect(script).toContain("1234");
    expect(script).toContain("last_refresh");
    // Carries the logout-propagation path (delete the VM-local copy).
    expect(script).toContain("delete-local");
    expect(script).toContain("rmSync");
    // Throws if the generated source has a syntax error.
    expect(() => new Function(script)).not.toThrow();
  });
});
