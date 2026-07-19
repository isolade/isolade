import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { UpdateStatus } from "./contracts";
import type { Db } from "./db";
import { isNestedInstance } from "./mount-map";
import { type LatestInfo, UpdateCheckStore } from "./update-check-store";

const UPDATE_URL = process.env.ISOLADE_UPDATE_URL || "https://isolade.com/api/update";
const FETCH_TIMEOUT_MS = 5000;
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

function appVersion(): string | null {
  const env = process.env.ISOLADE_APP_VERSION?.trim();
  return env ? env : sourceVersion();
}

// "<version>+dev" read from app/tauri.conf.json, for from-source runs with no
// launcher-set ISOLADE_APP_VERSION (bun run dev/start, tests). Memoized; null if
// the file can't be read (e.g. a compiled binary, where the env is always set).
let sourceVersionCache: string | null | undefined;
function sourceVersion(): string | null {
  if (sourceVersionCache === undefined) {
    try {
      const path = join(import.meta.dir, "../../../app/tauri.conf.json");
      const { version } = JSON.parse(readFileSync(path, "utf8")) as { version?: string };
      sourceVersionCache = version ? `${version}+dev` : null;
    } catch {
      sourceVersionCache = null;
    }
  }
  return sourceVersionCache;
}

function platform(): "macos" | "linux" | null {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "linux") return "linux";
  return null;
}

/** The processor architecture the app runs as: `arm64` or `x64`, the two we
 * ship. Under Rosetta an x64 build reports `x64` on Apple Silicon, which is
 * itself worth knowing (the user is on the emulated build). Sent so the update
 * endpoint can point at the right build and record the platform/arch split. */
function arch(): "arm64" | "x64" | "unknown" {
  if (process.arch === "arm64") return "arm64";
  if (process.arch === "x64") return "x64";
  return "unknown";
}

/** UTC calendar date as YYYY-MM-DD. All period boundaries use UTC so they never
 * depend on the machine's timezone, or shift when the user travels across one. */
export function utcDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** ISO-8601 week (Kalenderwoche) in UTC: {year, week}, where the week belongs to
 * the year of its Thursday. */
export function isoWeek(d: Date): { year: number; week: number } {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // move to this week's Thursday
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const fdNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - fdNum + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return { year: date.getUTCFullYear(), week };
}

const ALL_PERIODS = ["day", "week", "month", "year"];

/** Which calendar periods (in UTC) newly start at `now` relative to `lastChecked`
 * (the instant of the last successful check). Every period (day included) is
 * gated by the same "is it in a different one than last time?" test, so a check
 * within the same UTC day yields `[]` (a resolve-only check that counts nothing)
 * and there's no special case for "day". A null `lastChecked` (first ever) counts
 * as the start of every period. */
export function derivePeriods(lastChecked: Date | null, now: Date): string[] {
  if (!lastChecked) return [...ALL_PERIODS];
  if (utcDate(lastChecked) === utcDate(now)) return []; // same UTC day → nothing rolled over

  const lw = isoWeek(lastChecked);
  const tw = isoWeek(now);
  const periods = ["day"]; // the date differs, so the day rolled over
  if (lw.year !== tw.year || lw.week !== tw.week) periods.push("week");
  if (
    lastChecked.getUTCFullYear() !== now.getUTCFullYear() ||
    lastChecked.getUTCMonth() !== now.getUTCMonth()
  )
    periods.push("month");
  if (lastChecked.getUTCFullYear() !== now.getUTCFullYear()) periods.push("year");
  return periods;
}

/** True when `latest` is a strictly newer version than `current`. Compares the
 * numeric dotted core (a leading "v" and any -prerelease/+build suffix are
 * ignored), so "v1.2.0" vs "1.10.0" works and equal cores aren't "newer". */
export function isNewer(latest: string, current: string): boolean {
  const core = (v: string) =>
    (v.replace(/^v/, "").split(/[-+]/)[0] ?? "").split(".").map((n) => parseInt(n, 10) || 0);
  const a = core(latest);
  const b = core(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

// Returns null on any failure (unreachable, non-2xx, non-JSON), logging why so a
// silent "couldn't check" is diagnosable. Never throws.
async function fetchLatest(
  plat: string,
  periods: string[],
  from: string,
): Promise<LatestInfo | null> {
  const params = new URLSearchParams({ platform: plat, arch: arch(), from });
  if (periods.length) params.set("periods", periods.join(","));
  try {
    const res = await fetch(`${UPDATE_URL}?${params.toString()}`, {
      headers: { "user-agent": `isolade/${from}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[isolade] update check failed: HTTP ${res.status} from ${UPDATE_URL}`);
      return null;
    }
    const j = (await res.json()) as Record<string, unknown>;
    return {
      version: typeof j.version === "string" ? j.version : null,
      download: typeof j.download === "string" ? j.download : null,
      notes: typeof j.notes === "string" ? j.notes : null,
      changes: Array.isArray(j.changes)
        ? j.changes.filter((c): c is string => typeof c === "string").slice(0, 5)
        : [],
    };
  } catch (err) {
    console.warn(`[isolade] update check failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

function toStatus(
  current: string,
  latest: LatestInfo | null,
  checkedAt: number | null,
): UpdateStatus {
  const available = !!(latest?.version && isNewer(latest.version, current));
  return {
    current,
    available,
    latest: latest?.version ?? null,
    download: latest?.download ?? null,
    notes: latest?.notes ?? null,
    changes: latest?.changes ?? [],
    checkedAt,
  };
}

const DISABLED: UpdateStatus = {
  current: "unknown",
  available: false,
  latest: null,
  download: null,
  notes: null,
  changes: [],
  checkedAt: null,
};

export async function resolveAndMaybeCount(
  store: UpdateCheckStore,
  current: string,
  plat: string,
  now: Date = new Date(),
  nested: boolean = isNestedInstance(),
): Promise<UpdateStatus> {
  const state = store.read();
  const lastChecked = state.lastCheckedAt !== null ? new Date(state.lastCheckedAt) : null;
  const periods = nested ? [] : derivePeriods(lastChecked, now);

  const fetched = await fetchLatest(plat, periods, current); // never throws, null on failure
  if (!fetched) return toStatus(current, state.latest, state.lastCheckedAt);

  const checkedAt = now.getTime();
  store.write({ lastCheckedAt: checkedAt, latest: fetched });
  return toStatus(current, fetched, checkedAt);
}

// Last resolved status, kept warm so the UI answers instantly. The poller and
// the in-flight dedupe keep it fresh.
let lastStatus: UpdateStatus | null = null;
let inflight: Promise<UpdateStatus> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

// The DB-backed store, injected once at server construction. The state lives in
// isolade.db (app_state table), so the module can't own a store until the DB
// exists. createApp calls initUpdateChecks(db) before any check runs.
let store: UpdateCheckStore | null = null;

/** Wire the update check to the app database. Called once from createApp, before
 * startUpdateChecks / getUpdateStatus. Idempotent. */
export function initUpdateChecks(db: Db): void {
  store ??= new UpdateCheckStore(db);
}

function check(): Promise<UpdateStatus> {
  if (inflight) return inflight;
  const current = appVersion();
  const plat = platform();
  if (!current || !plat || !store) {
    lastStatus = current ? toStatus(current, null, null) : DISABLED;
    return Promise.resolve(lastStatus);
  }
  inflight = resolveAndMaybeCount(store, current, plat)
    .then((s) => {
      lastStatus = s;
      return s;
    })
    .catch((err) => {
      // Only persisting state can reject (DB errors). Network failures already
      // resolve to the previous status. Swallow it so the boot kick-off and the
      // hourly poller never surface an unhandled rejection.
      console.warn(`[isolade] update check failed: ${err instanceof Error ? err.message : err}`);
      return lastStatus ?? toStatus(current, null, null);
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

// Re-check hourly while the app is open: picks up a mid-session release and
// emits the next period's beacon once the calendar rolls over. Unref'd so it
// never keeps the process alive. No-op only if no version resolves.
function ensurePolling(): void {
  if (pollTimer || !appVersion() || !platform()) return;
  pollTimer = setInterval(() => void check(), CHECK_INTERVAL_MS);
  pollTimer.unref?.();
}

/** Boot-time kick-off, called when the server starts (index.ts): runs the
 * launch check now (counting whatever periods newly started) and begins the
 * hourly re-check. No-op only if no version resolves. */
export function startUpdateChecks(): void {
  ensurePolling();
  void check();
}

/** Current update status for the UI. `force` re-resolves now (the manual "Check
 * for updates" button). Otherwise the warm cached status is returned, falling
 * back to a first check. */
export function getUpdateStatus(force = false): Promise<UpdateStatus> {
  ensurePolling();
  if (!force && lastStatus) return Promise.resolve(lastStatus);
  return check();
}
