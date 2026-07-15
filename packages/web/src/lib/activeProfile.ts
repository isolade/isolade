import { listProfiles } from "./api";

// The active profile is a per-WINDOW concern, owned by the client (the server
// holds no "active profile"). We store it in sessionStorage, which is scoped to
// a single browsing context, so each Tauri window (and each browser tab) gets its
// own value automatically, with no window-label bookkeeping, and it survives a
// reload (so the switch-then-reload flow works). It's cleared when the window
// closes, so we ALSO mirror the choice into a localStorage "last used" hint:
// that's shared across windows and survives app restarts, giving a freshly
// opened window a sensible default (your last profile) instead of resetting.
//
// Multi-window with different profiles falls out of this for free: open a second
// window, it has its own sessionStorage → its own active profile.
const SESSION_KEY = "isolade.activeProfile";
const LAST_KEY = "isolade.activeProfile.last";
const CLIENT_KEY = "isolade.clientId";

// A stable id for THIS window, used so the server can reference-count which
// profiles are in use (and keep their warm titling VMs alive). Per-window like
// the active profile itself: sessionStorage gives each Tauri window / browser
// tab its own id that survives a reload. Falls back to an in-memory id if
// storage is unavailable (then it's stable for the page's lifetime, which is
// all the server needs between activate and deactivate).
let memoClientId: string | null = null;
export function getClientId(): string {
  if (memoClientId) return memoClientId;
  try {
    let id = window.sessionStorage.getItem(CLIENT_KEY);
    if (!id) {
      id = crypto.randomUUID();
      window.sessionStorage.setItem(CLIENT_KEY, id);
    }
    memoClientId = id;
  } catch {
    memoClientId = crypto.randomUUID();
  }
  return memoClientId;
}

export function getStoredProfileId(): string | null {
  try {
    return window.sessionStorage.getItem(SESSION_KEY) ?? window.localStorage.getItem(LAST_KEY);
  } catch {
    return null;
  }
}

export function setStoredProfileId(id: string | null): void {
  try {
    if (id) {
      window.sessionStorage.setItem(SESSION_KEY, id);
      window.localStorage.setItem(LAST_KEY, id); // default for future windows / restarts
    } else {
      window.sessionStorage.removeItem(SESSION_KEY);
    }
  } catch {
    // storage unavailable, so fall back to in-memory-only (lost on reload)
  }
}

// Resolve this window's active profile: the stored selection if it still names a
// real profile, else the first profile. Persists the resolution so later reads
// (and other components in this window) are stable. Returns null only when no
// profiles exist at all.
export async function resolveActiveProfileId(): Promise<string | null> {
  let profiles;
  try {
    profiles = await listProfiles();
  } catch {
    return getStoredProfileId();
  }
  if (profiles.length === 0) return null;
  const stored = getStoredProfileId();
  const chosen = profiles.find((p) => p.id === stored) ?? profiles[0];
  if (!chosen) return null;
  setStoredProfileId(chosen.id);
  return chosen.id;
}
