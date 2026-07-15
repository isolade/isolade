import { type Provider, parseAuthFreshness } from "./auth-store";
import type { SandboxApi } from "./sandbox-client";

// Guest mount point for the host auth dir (a profile's dataDir()/auth). The
// in-VM auth-sync watcher reconciles the CLIs' VM-local credential files
// against the files under here, so a refresh in one VM propagates to the host
// and every other live VM of the same profile. Kept off $HOME so it doesn't
// collide with the CLIs' own dirs. Every VM that runs an agent CLI (instance
// VMs and the per-profile titling VM) bind-mounts the profile's auth dir here.
export const AUTH_MOUNT = "/run/isolade-auth";
const AUTH_SYNC_SCRIPT_PATH = "/tmp/isolade-auth-sync.cjs";

// Seed a VM's local credential files from the bind-mounted auth dir and start
// the continuous auth-sync watcher. Idempotent: kills any prior watcher first
// so restarts/resyncs don't stack duplicates. Best-effort, since an unauthenticated
// agent is a valid state (no login yet), so a failure here must never block the
// caller (create / restart / attach / titling-VM warmup). Shared by
// InstanceManager and TitleVmManager.
export async function seedVmAuth(sandboxClient: SandboxApi, vmId: string): Promise<void> {
  try {
    const script = buildAuthSyncScript(AUTH_MOUNT);
    await sandboxClient.writeFile(vmId, AUTH_SYNC_SCRIPT_PATH, Buffer.from(script, "utf8"));
    await sandboxClient.exec(vmId, `sh -c 'pkill -f ${AUTH_SYNC_SCRIPT_PATH} 2>/dev/null; true'`);
    // One-shot reconcile seeds $HOME/.claude & ~/.codex from the mount before
    // any agent turn, then launch the continuous watcher detached.
    await sandboxClient.exec(vmId, `node ${AUTH_SYNC_SCRIPT_PATH} --once`);
    await sandboxClient.exec(
      vmId,
      `sh -c 'nohup node ${AUTH_SYNC_SCRIPT_PATH} > /tmp/isolade-auth-sync.out 2>&1 &'`,
    );
  } catch (err) {
    console.warn(`[agent-auth ${vmId}] setup failed (agent runs unauthenticated):`, err);
  }
}

// The agent VMs each keep a VM-local copy of the credential file (where the
// claude/codex CLI reads & writes it) plus a bind-mount of the host auth dir.
// A small watcher process inside the VM keeps the two in sync so that:
//   - a refresh the in-VM CLI performs propagates OUT to the host (and thence
//     to every other live VM), and
//   - a refresh another VM performed propagates IN before the next turn.
//
// Both sides hold the same JSON shape the CLI writes, so "which copy is newer"
// is decided by provider-specific freshness markers. Claude has an explicit
// access-token expiry. Codex has the access-token JWT expiry plus `last_refresh`,
// which matters when refresh token rotation updates auth.json without changing
// the access-token expiry. This module owns that decision as a pure function so
// it's directly testable. The watcher script below embeds the same rule for
// execution inside the guest.

export type SyncSide = "local" | "mount" | "delete-local" | "none";

/** Decide what the watcher should do. The mount (the store) is AUTHORITATIVE
 * for existence: a credential only lives in a VM because the store seeded it,
 * so if the store entry is gone (the user signed out) the VM-local copy must be
 * deleted too, never pushed back up, which would resurrect the logged-out
 * credential. When both sides exist it's a refresh race: newer expiry wins,
 * then newer refresh timestamp wins (`null` = unparseable, loses to any real
 * value, and ties no-op). */
export function chooseSyncSide(
  local: {
    exists: boolean;
    expiresAt: number | null;
    refreshedAt?: number | null;
  },
  mount: {
    exists: boolean;
    expiresAt: number | null;
    refreshedAt?: number | null;
  },
): SyncSide {
  if (!local.exists && !mount.exists) return "none";
  if (local.exists && !mount.exists) return "delete-local";
  if (!local.exists && mount.exists) return "mount";
  const l = local.expiresAt ?? -Infinity;
  const m = mount.expiresAt ?? -Infinity;
  if (l > m) return "local";
  if (m > l) return "mount";
  const lr = local.refreshedAt ?? -Infinity;
  const mr = mount.refreshedAt ?? -Infinity;
  if (lr > mr) return "local";
  if (mr > lr) return "mount";
  return "none";
}

/** Convenience wrapper that parses raw blobs first. Used by tests and the
 * watcher alike. A null blob means the file is absent. */
export function chooseSyncSideFromRaw(
  provider: Provider,
  localRaw: string | null,
  mountRaw: string | null,
): SyncSide {
  const localFreshness =
    localRaw == null
      ? { expiresAt: null, refreshedAt: null }
      : parseAuthFreshness(provider, localRaw);
  const mountFreshness =
    mountRaw == null
      ? { expiresAt: null, refreshedAt: null }
      : parseAuthFreshness(provider, mountRaw);
  return chooseSyncSide(
    { exists: localRaw != null, ...localFreshness },
    { exists: mountRaw != null, ...mountFreshness },
  );
}

// Per-provider paths relative to (HOME, mountBase) inside the guest. Kept in
// sync with AuthStore's REL_PATH and the CLIs' native locations.
const PROVIDER_PATHS: Record<Provider, { localRel: string; mountRel: string }> = {
  claude: {
    localRel: ".claude/.credentials.json",
    mountRel: "claude/.credentials.json",
  },
  codex: { localRel: ".codex/auth.json", mountRel: "codex/auth.json" },
};

// Self-contained CommonJS watcher injected into each agent VM and launched with
// `node`. No imports beyond Node core so it runs against the agent image's
// nodejs without a build step. The server writes this to the guest and starts
// it detached. It polls every pollMs and reconciles each provider pair using
// the same freshness rule as chooseSyncSide above. Writes are in-place
// (writeFileSync truncates) so a write to the bind-mounted path lands on the
// host inode and propagates. A write to the local path is picked up by the CLI
// on its next read (claude: per-turn, codex: on 401 reload). Run with `--once`
// it performs a single reconcile and exits, used to seed VM-local files from
// the mount before the first agent turn. `mountBase` is the guest bind-mount of
// the host auth dir, and local paths resolve against $HOME at runtime.
export function buildAuthSyncScript(
  mountBase: string,
  opts: { pollMs?: number; logPath?: string } = {},
): string {
  const config = {
    mountBase,
    providers: PROVIDER_PATHS,
    pollMs: opts.pollMs ?? 2000,
    logPath: opts.logPath ?? "/tmp/isolade-auth-sync.log",
  };
  return `'use strict';
const fs = require('fs');
const path = require('path');
const CFG = ${JSON.stringify(config)};
const HOME = process.env.HOME || require('os').homedir();
const PAIRS = Object.keys(CFG.providers).map((provider) => ({
  provider,
  local: path.join(HOME, CFG.providers[provider].localRel),
  mount: path.join(CFG.mountBase, CFG.providers[provider].mountRel),
}));

function readOrNull(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }
function log(m) { try { fs.appendFileSync(CFG.logPath, '[' + new Date().toISOString() + '] ' + m + '\\n'); } catch {} }

function freshness(provider, raw) {
  try {
    const o = JSON.parse(raw);
    if (provider === 'claude') {
      const v = (o.claudeAiOauth && o.claudeAiOauth.expiresAt) != null ? o.claudeAiOauth.expiresAt : o.expiresAt;
      return { expiresAt: typeof v === 'number' ? v : null, refreshedAt: null };
    }
    const jwt = o.tokens && o.tokens.access_token;
    let expiresAt = null;
    if (typeof jwt === 'string') {
      const part = jwt.split('.')[1];
      if (part) {
        const exp = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')).exp;
        expiresAt = typeof exp === 'number' ? exp * 1000 : null;
      }
    }
    const refreshedAt = typeof o.last_refresh === 'string' ? Date.parse(o.last_refresh) : NaN;
    return { expiresAt, refreshedAt: Number.isFinite(refreshedAt) ? refreshedAt : null };
  } catch { return { expiresAt: null, refreshedAt: null }; }
}

function choose(provider, localRaw, mountRaw) {
  const le = localRaw != null, me = mountRaw != null;
  if (!le && !me) return 'none';
  if (le && !me) return 'delete-local'; // store entry gone (logout) → drop the VM copy
  if (!le && me) return 'mount';
  const l = freshness(provider, localRaw); const m = freshness(provider, mountRaw);
  const lv = l.expiresAt == null ? -Infinity : l.expiresAt; const mv = m.expiresAt == null ? -Infinity : m.expiresAt;
  if (lv > mv) return 'local';
  if (mv > lv) return 'mount';
  const lr = l.refreshedAt == null ? -Infinity : l.refreshedAt; const mr = m.refreshedAt == null ? -Infinity : m.refreshedAt;
  if (lr > mr) return 'local';
  if (mr > lr) return 'mount';
  return 'none';
}

function writeInPlace(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data, { mode: 0o600 });
}

function tick() {
  for (const pair of PAIRS) {
    try {
      const localRaw = readOrNull(pair.local);
      const mountRaw = readOrNull(pair.mount);
      const side = choose(pair.provider, localRaw, mountRaw);
      if (side === 'local' && localRaw != null && localRaw !== mountRaw) {
        writeInPlace(pair.mount, localRaw);
        log('pushed ' + pair.provider + ' local -> mount');
      } else if (side === 'mount' && mountRaw != null && mountRaw !== localRaw) {
        writeInPlace(pair.local, mountRaw);
        log('pulled ' + pair.provider + ' mount -> local');
      } else if (side === 'delete-local') {
        try { fs.rmSync(pair.local); } catch (e) {}
        log('removed ' + pair.provider + ' local (signed out)');
      }
    } catch (e) { log('error ' + pair.provider + ': ' + (e && e.message || e)); }
  }
}

if (process.argv.includes('--once')) {
  tick();
} else {
  log('auth-sync started, ' + PAIRS.length + ' pair(s)');
  tick();
  setInterval(tick, CFG.pollMs);
}
`;
}
