import { homedir } from "node:os";
import { join } from "node:path";

// Nested-mode mount translation (isolade within isolade).
//
// When the inner isolade (running inside an `expose_sandbox` dev VM) creates
// an agent VM through the SHARED host sandbox, every volume hostPath it emits
// is a path in ITS OWN guest filesystem — which means nothing to the host's
// microsandbox runtime. The paths that CAN work are the ones backed by a host
// directory already bind-mounted into the dev VM (its profile cache mounts and
// the seed mount): for those, the guest path has a host-side twin.
//
// At dev-VM create, the host injects that mapping as env:
//
//   ISOLADE_CLIENT_ID  = <the dev VM's instance id> (sandbox client identity)
//   ISOLADE_MOUNT_MAP  = JSON [{ guestPath, hostPath }, ...] — the dev VM's
//                        own volumes, verbatim.
//
// The inner's HTTP SandboxClient translates each emitted volume hostPath
// through this map before it goes on the wire (longest matching mount wins),
// and DROPS, with a loud warning, any volume that no mount backs — the host
// side could only bind a nonexistent host path. The presence of the map is
// also the "am I nested?" signal; nothing else in the inner behaves
// differently.
//
// Mount-map guestPaths may be `~/`-, `$HOME/`- or absolute-rooted (they're the
// profile's cache mount declarations plus absolute isolade mounts). They are
// resolved against THIS process's HOME: the inner server runs in the same
// image (and as the same user) whose runtime HOME microsandbox resolved the
// mounts against when the dev VM was created.

export interface MountMapEntry {
  guestPath: string;
  hostPath: string;
}

export const MOUNT_MAP_ENV = "ISOLADE_MOUNT_MAP";
export const CLIENT_ID_ENV = "ISOLADE_CLIENT_ID";

/** Whether this server runs nested inside an `expose_sandbox` dev VM: the host
 * injects the client identity at VM create, and nothing else sets it. */
export function isNestedInstance(): boolean {
  return !!process.env[CLIENT_ID_ENV];
}

/** Parse the injected mount map, or null when absent/invalid (not nested). */
export function parseMountMap(raw: string | undefined): MountMapEntry[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    const entries: MountMapEntry[] = [];
    for (const item of parsed) {
      const e = item as { guestPath?: unknown; hostPath?: unknown };
      if (typeof e.guestPath !== "string" || typeof e.hostPath !== "string") return null;
      entries.push({ guestPath: e.guestPath, hostPath: e.hostPath });
    }
    return entries;
  } catch {
    return null;
  }
}

/** `~/x`, `$HOME/x`, or absolute → absolute, against this process's HOME.
 * Mirrors resolveGuestHomePath in the sandbox (which resolves the same strings
 * against the image's runtime HOME when the mount is created). */
export function resolveAgainstHome(input: string, home: string = homedir()): string {
  if (input === "~" || input === "$HOME") return home;
  if (input.startsWith("~/")) return join(home, input.slice(2));
  if (input.startsWith("$HOME/")) return join(home, input.slice("$HOME/".length));
  return input;
}

/** Translate a guest-local absolute path to its host backing path, or null when
 * no mount covers it. Longest matching mount wins so nested mounts resolve to
 * the most specific backing dir. */
export function translateHostPath(
  map: readonly MountMapEntry[],
  path: string,
  home: string = homedir(),
): string | null {
  let best: { base: string; hostPath: string } | null = null;
  for (const entry of map) {
    const base = resolveAgainstHome(entry.guestPath, home).replace(/\/+$/, "");
    if (path !== base && !path.startsWith(`${base}/`)) continue;
    if (!best || base.length > best.base.length) best = { base, hostPath: entry.hostPath };
  }
  if (!best) return null;
  const remainder = path.slice(best.base.length).replace(/^\/+/, "");
  return remainder ? join(best.hostPath, remainder) : best.hostPath;
}
