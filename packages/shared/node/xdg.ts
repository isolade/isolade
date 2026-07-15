import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

// XDG base-dir resolution, shared by the server and the sandbox sidecar (a
// separate process that owns $MSB_HOME and the buildkit cache, so it must
// resolve the exact same dirs). XDG env vars always win. Otherwise we use the
// Linux base-dir paths on EVERY platform, macOS included. We deliberately do
// not use ~/Library:
//   - state/data/config: ~/Library/Application Support would blow the 104-byte
//     sun_path limit for microsandbox's agent sockets under $MSB_HOME/run.
//   - cache: ~/Library/Caches auto-excludes from Time Machine, but it isn't
//     auto-purged for unregistered caches anyway, and one code path + a single
//     dot-dir footprint is worth more than the implicit exclusion. We mark the
//     cache and state roots non-backup explicitly via excludeFromBackup().
function xdgPath(envVar: string, fallback: readonly string[]): string {
  const fromEnv = process.env[envVar];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return join(homedir(), ...fallback);
}

/** User config (profiles, settings). Precious + portable → backed up. */
export function configDir(): string {
  return join(xdgPath("XDG_CONFIG_HOME", [".config"]), "isolade");
}

/** User content: the SQLite DB (chats, profiles). Precious → backed up. */
export function dataDir(): string {
  return join(xdgPath("XDG_DATA_HOME", [".local", "share"]), "isolade");
}

/**
 * Machine-local persistent state: $MSB_HOME (VM db, per-VM upper.ext4, the
 * image/layer cache that is the VMs' read-only rootfs). Survives restarts but
 * is not portable or precious (git is the source of truth for in-VM work), so
 * it is excludeFromBackup()'d, yet must NOT live in a cache dir, since running
 * VMs depend on it and it must never be auto/manually purged.
 */
export function stateDir(): string {
  return join(xdgPath("XDG_STATE_HOME", [".local", "state"]), "isolade");
}

/** Regenerable, purge-safe: buildkit disk, workspace caches, git checkouts. */
export function cacheDir(): string {
  return join(xdgPath("XDG_CACHE_HOME", [".cache"]), "isolade");
}

const BACKUP_EXCLUDE_XATTR = "com.apple.metadata:com_apple_backup_excludeItem";
// Binary plist for boolean `true`, exactly what NSURLIsExcludedFromBackupKey
// writes. Passed as hex to `xattr -wx`.
const BACKUP_EXCLUDE_VALUE_HEX =
  "62706c69737430300908000000000000000101000000000000000100000000000000000000000000000009";

/**
 * Exclude a directory (and its subtree, including files created later, since the
 * per-VM upper.ext4 under stateDir, the buildkit disk under cacheDir) from
 * Time Machine, by setting the backup-exclude xattr that
 * NSURLIsExcludedFromBackupKey uses (verified: `tmutil isexcluded` → [Excluded]).
 *
 * Uses /usr/bin/xattr by absolute path, deliberately:
 *   - `tmutil addexclusion` talks to backupd and BLOCKS when launched outside an
 *     interactive session, which hung server startup once.
 *   - a bare `xattr` may resolve to a broken Homebrew shim on PATH.
 * `xattr` is a thin setxattr(2) wrapper (no daemon) so it returns immediately.
 * The small timeout is just belt-and-suspenders. Best-effort, no admin,
 * macOS-only, and never blocks the startup path it's called from.
 */
export function excludeFromBackup(path: string): void {
  if (process.platform !== "darwin") return;
  try {
    execFileSync("/usr/bin/xattr", ["-wx", BACKUP_EXCLUDE_XATTR, BACKUP_EXCLUDE_VALUE_HEX, path], {
      timeout: 2000,
      stdio: "ignore",
    });
  } catch {
    // best-effort: a failed xattr just leaves the dir backed up
  }
}
