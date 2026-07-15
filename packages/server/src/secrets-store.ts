import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { profileSecretsPath } from "./profiles";

// User-entered workspace secret values live as a 0600 JSON file per profile
// (dataDir()/profiles/<id>/secrets.json), the same on-disk, filesystem-perms
// (+ FileVault at rest) protection the agent OAuth credentials already use (see
// auth-store.ts), NOT the OS keychain.
//
// Why not the OS keychain (the previous Bun.secrets backend): on macOS the login
// keychain gates each item on an ACL *partition list* that, for code without an
// Apple Team ID (our self-signed, non-notarized build) pins access by the
// binary's cdhash. Every rebuild or app update changes the cdhash, so macOS
// re-prompts for the keychain password each time. A stable code-signing identity
// fixes the trusted-application *requirement* but not the partition list, so the
// prompt recurs regardless. A file store has no such gate. It also works on a
// headless Linux box (no libsecret daemon needed) and keeps the protection of
// these values consistent with the more-sensitive auth tokens next to them.
//
// Keying is per-profile: a value belongs to a profile (the identity), not to
// each environment, so two profiles that both declare GH_TOKEN hold independent
// values while every environment within a profile shares it. On disk that's a
// flat { [env]: value } map with the profile id as the directory.
//
// Values never touch config files, the database, logs, or API responses. The
// only places a value flows are (1) into this store from the Settings UI and
// (2) out of it at VM-create time, straight into the sandbox secret
// registration (see instances.ts).
type SecretMap = Record<string, string>;

export class SecretsStore {
  // `resolvePath` is injectable so tests point at a temp dir instead of the real
  // data dir, mirroring AuthStore's `baseDir` seam.
  constructor(private resolvePath: (profileId: string) => string = profileSecretsPath) {}

  private read(profileId: string): SecretMap {
    const path = this.resolvePath(profileId);
    if (!existsSync(path)) return {};
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
      return parsed && typeof parsed === "object" ? (parsed as SecretMap) : {};
    } catch (err) {
      // A corrupt/unreadable file degrades to "no secrets" rather than failing
      // VM creation, the same forgiving behaviour the keychain backend had for
      // a missing keyring daemon.
      console.warn(
        `[secrets-store] read failed for ${profileId}; treating as unset: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return {};
    }
  }

  private write(profileId: string, map: SecretMap): void {
    const path = this.resolvePath(profileId);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify(map, null, 2)}\n`, { mode: 0o600 });
  }

  /** Returns the stored value for a profile's secret, or null if none is set. */
  async get(profileId: string, env: string): Promise<string | null> {
    return this.read(profileId)[env] ?? null;
  }

  /** Whether a value is currently stored. Never returns the value itself. */
  async has(profileId: string, env: string): Promise<boolean> {
    return (await this.get(profileId, env)) !== null;
  }

  /** Stores (or overwrites) a profile secret value. */
  async set(profileId: string, env: string, value: string): Promise<void> {
    const map = this.read(profileId);
    map[env] = value;
    this.write(profileId, map);
  }

  /** Removes a stored value. Returns true if something was deleted. */
  async delete(profileId: string, env: string): Promise<boolean> {
    const map = this.read(profileId);
    if (!(env in map)) return false;
    delete map[env];
    this.write(profileId, map);
    return true;
  }
}
