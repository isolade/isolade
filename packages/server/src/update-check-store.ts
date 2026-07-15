import { eq } from "drizzle-orm";
import type { Db } from "./db";
import { appState } from "./db/schema";

// What the update check stores. `lastCheckedAt` is the timestamp of the last
// successful check: it's shown in the UI as "last checked", and its calendar
// date is also what gates counting (the day/week/month/year period beacons fire
// only when that date rolls over), so no analytics-specific state ever touches
// the device (see update-check.ts). `latest` caches the last result so the UI
// answers without another call.
//
// It lives as a single JSON row in the app_state table (key "update-check") of
// isolade.db. It used to be a sibling update-check.json under dataDir(); it was
// folded into the DB (migration 5) so this disposable, machine-local state stops
// being a stray file. It is deliberately not in ~/.config, so it never lands in
// a dotfiles repo either way.

const KEY = "update-check";

export interface LatestInfo {
  version: string | null;
  download: string | null;
  notes: string | null;
  changes: string[];
}

export interface UpdateCheckState {
  /** Epoch ms of the last *successful* check, or null if none yet. Shown as
   * "last checked". Its UTC calendar date gates counting to once per UTC day. */
  lastCheckedAt: number | null;
  /** Cached result of the last successful check. */
  latest: LatestInfo | null;
}

const DEFAULT: UpdateCheckState = { lastCheckedAt: null, latest: null };

function normalizeLatest(value: unknown): LatestInfo | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  return {
    version: typeof v.version === "string" ? v.version : null,
    download: typeof v.download === "string" ? v.download : null,
    notes: typeof v.notes === "string" ? v.notes : null,
    changes: Array.isArray(v.changes)
      ? v.changes.filter((c): c is string => typeof c === "string")
      : [],
  };
}

export class UpdateCheckStore {
  constructor(private db: Db) {}

  /** Current state. Never throws: an absent / corrupt row reads as "never
   * checked", so the next launch simply checks again. */
  read(): UpdateCheckState {
    const row = this.db.select().from(appState).where(eq(appState.key, KEY)).get();
    if (!row) return { ...DEFAULT };
    try {
      const parsed = JSON.parse(row.value) as Record<string, unknown>;
      return {
        lastCheckedAt: typeof parsed.lastCheckedAt === "number" ? parsed.lastCheckedAt : null,
        latest: normalizeLatest(parsed.latest),
      };
    } catch {
      return { ...DEFAULT };
    }
  }

  write(state: UpdateCheckState): void {
    const value = JSON.stringify(state);
    this.db
      .insert(appState)
      .values({ key: KEY, value })
      .onConflictDoUpdate({ target: appState.key, set: { value } })
      .run();
  }
}
