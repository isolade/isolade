import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Agent (Claude / Codex) login credentials live as plain files, written only by
// isolade's own in-app login flow (see auth-login.ts) into a per-profile auth
// dir (dataDir()/profiles/<id>/auth, see profiles.ts). They are NEVER sourced
// from the host — not the macOS keychain, not ~/.codex — so isolade signs in
// independently of any host CLI, and each profile holds exactly the credential
// the user logged into it with. Files (rather than a keychain) are also required
// because they have to be bind-mounted into agent VMs (you can't bind-mount a
// keychain entry). This mirrors the on-disk approach used for workspace secret
// values (see secrets-store.ts).
//
// Each provider keeps its credential at the path its CLI natively expects inside
// the mount, so the in-VM symlink/seed lands it where claude/codex look:
//
//   <auth>/claude/.credentials.json   (claudeAiOauth blob)
//   <auth>/codex/auth.json            ({ tokens: { ... } })
//
// dataDir() is ~/.local/share/isolade (XDG data, never git-tracked), so the
// long-lived refresh tokens here don't risk landing in a dotfiles repo the way
// ~/.config/isolade would.
export type Provider = "claude" | "codex";

const REL_PATH: Record<Provider, string> = {
  claude: "claude/.credentials.json",
  codex: "codex/auth.json",
};

export class AuthStore {
  // `baseDir` is always a profile's auth dir (ProfileManager.auth); there is no
  // global default, so auth is profile-scoped by construction.
  constructor(private baseDir: string) {}

  /** Absolute path to a provider's credential file (whether or not it exists).
   * This is the file bind-mounted into agent VMs. */
  path(provider: Provider): string {
    return join(this.baseDir, REL_PATH[provider]);
  }

  /** The auth directory bind-mounted (read/write) into agent VMs. */
  dir(): string {
    return this.baseDir;
  }

  /** Ensure the auth directory exists so it can be bind-mounted even before any
   * provider has been logged in (an empty mount is harmless). */
  ensureDir(): void {
    mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
  }

  /** Raw credential blob from the profile's own store, or null if the profile
   * hasn't signed in. Never consults the host: isolade only trusts credentials
   * it obtained through its own in-app login. */
  read(provider: Provider): string | null {
    const p = this.path(provider);
    if (!existsSync(p)) return null;
    try {
      return readFileSync(p, "utf-8");
    } catch {
      return null;
    }
  }

  /** Whether a credential is stored for this provider — i.e. the profile has
   * signed in and there's a file to bind-mount into its VMs. */
  has(provider: Provider): boolean {
    return existsSync(this.path(provider));
  }

  /** Writes a credential into the store with restrictive perms (dir 0700,
   * file 0600). Written only by the in-app login harvest (see auth-login.ts). */
  write(provider: Provider, content: string): void {
    const p = this.path(provider);
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
    writeFileSync(p, content, { mode: 0o600 });
  }

  /** Delete a provider's stored credential file (i.e. sign out). Returns true
   * if one existed. Running agent VMs notice the missing store entry on their
   * next watcher tick and drop their local copy too (see chooseSyncSide), so
   * sign-out propagates everywhere instead of being resurrected. */
  remove(provider: Provider): boolean {
    const p = this.path(provider);
    try {
      if (existsSync(p)) {
        rmSync(p);
        return true;
      }
    } catch {
      // fall through
    }
    return false;
  }
}

export interface AuthFreshness {
  expiresAt: number | null;
  refreshedAt: number | null;
}

/** Best-effort freshness markers from a raw credential blob.
 * claude stores claudeAiOauth.expiresAt (already ms). codex carries a JWT in
 * tokens.access_token whose `exp` (seconds) we decode, plus `last_refresh`
 * written by codex when it refreshes and persists tokens. */
export function parseAuthFreshness(provider: Provider, raw: string): AuthFreshness {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (provider === "claude") {
      const oauth = obj.claudeAiOauth as { expiresAt?: unknown } | undefined;
      const v = oauth?.expiresAt ?? (obj.expiresAt as unknown);
      return {
        expiresAt: typeof v === "number" ? v : null,
        refreshedAt: null,
      };
    }
    const tokens = obj.tokens as { access_token?: unknown } | undefined;
    const jwt = tokens?.access_token;
    let expiresAt: number | null = null;
    if (typeof jwt === "string") {
      const payload = jwt.split(".")[1];
      if (payload) {
        const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8")) as {
          exp?: unknown;
        };
        expiresAt = typeof decoded.exp === "number" ? decoded.exp * 1000 : null;
      }
    }
    const lastRefresh = obj.last_refresh;
    const refreshedAt = typeof lastRefresh === "string" ? Date.parse(lastRefresh) : NaN;
    return {
      expiresAt,
      refreshedAt: Number.isFinite(refreshedAt) ? refreshedAt : null,
    };
  } catch {
    return { expiresAt: null, refreshedAt: null };
  }
}

/** Best-effort access-token expiry (epoch ms) from a raw credential blob.
 * Returns null when it can't be determined, and callers treat that as "unknown". */
export function parseExpiresAt(provider: Provider, raw: string): number | null {
  return parseAuthFreshness(provider, raw).expiresAt;
}
