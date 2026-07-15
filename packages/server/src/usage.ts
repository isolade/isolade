import type { AuthStore } from "./auth-store";
import type {
  UsageClaude,
  UsageCodex,
  UsageNamedWindow,
  UsageResultClaude,
  UsageResultCodex,
  UsageStats,
  UsageWindow,
} from "./contracts";

// Usage only ever reads credentials (from the profile store its caller passes),
// never writes them.
export type UsageAuthStore = Pick<AuthStore, "read">;
const CLAUDE_CODE_USER_AGENT = "claude-code/2.1.201";
const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";

/** Test hook: drop the per-provider usage caches between cases. */
export function __resetUsageCachesForTest(): void {
  resetUsageCaches();
}

function resetUsageCaches(): void {
  claudeBackoffUntilMs.clear();
  claudeCaches.clear();
  codexCaches.clear();
}

// ---------- Claude ----------

interface ClaudeOauthSecret {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
  subscriptionType?: string | null;
  rateLimitTier?: string | null;
}

export async function readClaudeOauthSecret(
  store: UsageAuthStore,
): Promise<ClaudeOauthSecret | null> {
  const raw = store.read("claude");
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw);
    const inner =
      parsed && typeof parsed === "object" && "claudeAiOauth" in parsed
        ? (parsed as { claudeAiOauth: ClaudeOauthSecret }).claudeAiOauth
        : (parsed as ClaudeOauthSecret);
    return inner ?? null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function pickString(obj: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function pickNestedString(obj: Record<string, unknown>, path: readonly string[]): string | null {
  let current: unknown = obj;
  for (const key of path) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return typeof current === "string" && current.trim() ? current.trim() : null;
}

// Anthropic returns each window as { utilization: number, resets_at: string }
// or null when the window isn't applicable to this account. Normalize to our
// UsageWindow shape, accepting a few casing variants for newer app payloads.
function parseAnthropicWindow(raw: unknown): UsageWindow | null {
  if (!isRecord(raw)) return null;
  const utilization =
    typeof raw.utilization === "number"
      ? raw.utilization
      : typeof raw.usedPercent === "number"
        ? raw.usedPercent
        : typeof raw.used_percent === "number"
          ? raw.used_percent
          : typeof raw.percent_used === "number"
            ? raw.percent_used
            : typeof raw.percent === "number"
              ? raw.percent
              : null;
  if (typeof utilization !== "number") return null;
  const resetsAtRaw =
    typeof raw.resets_at === "string" || typeof raw.resets_at === "number"
      ? raw.resets_at
      : typeof raw.resetsAt === "string" || typeof raw.resetsAt === "number"
        ? raw.resetsAt
        : typeof raw.reset_at === "string" || typeof raw.reset_at === "number"
          ? raw.reset_at
          : typeof raw.resetAt === "string" || typeof raw.resetAt === "number"
            ? raw.resetAt
            : null;
  const windowSeconds =
    typeof raw.window_seconds === "number"
      ? raw.window_seconds
      : typeof raw.windowSeconds === "number"
        ? raw.windowSeconds
        : null;
  const resetsAtStr = resetsAtRaw == null ? null : String(resetsAtRaw);
  const resetsAt = resetsAtStr ? new Date(resetsAtStr) : null;
  return {
    utilization,
    resetsAt: resetsAt && !Number.isNaN(resetsAt.getTime()) ? resetsAt : null,
    windowSeconds,
  };
}

function parseAnthropicWindowCandidate(raw: unknown): UsageWindow | null {
  const direct = parseAnthropicWindow(raw);
  if (direct) return direct;
  if (!isRecord(raw)) return null;
  for (const key of ["window", "usage", "limit", "rate_limit", "rateLimit"] as const) {
    const nested = parseAnthropicWindow(raw[key]);
    if (nested) return nested;
  }
  return null;
}

function labelFromId(id: string): string {
  return (
    id
      .replace(/^seven_day_?/, "")
      .replace(/^weekly_?/, "")
      .split(/[_\s-]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ") || "Weekly"
  );
}

function normalizeWeeklyWindowId(idOrLabel: string): string {
  const normalized = idOrLabel
    .trim()
    .toLowerCase()
    .replace(/^seven_day_?/, "")
    .replace(/^weekly_?/, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (normalized === "seven_day" || normalized === "all_models" || normalized === "all") {
    return "all";
  }
  return normalized || "weekly";
}

function pushWeeklyWindow(
  windows: UsageNamedWindow[],
  seen: Set<string>,
  idOrLabel: string,
  label: string | null,
  raw: unknown,
): void {
  const window = parseAnthropicWindowCandidate(raw);
  if (!window) return;
  const id = normalizeWeeklyWindowId(idOrLabel);
  if (seen.has(id)) return;
  seen.add(id);
  windows.push({
    id,
    label: label?.trim() || (id === "all" ? "All models" : labelFromId(idOrLabel)),
    window,
  });
}

function parseAnthropicWeeklyCollection(
  raw: unknown,
  windows: UsageNamedWindow[],
  seen: Set<string>,
): void {
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!isRecord(item)) continue;
      const group = pickString(item, ["group"]);
      const kind = pickString(item, ["kind"]);
      if (group && group !== "weekly" && !kind?.startsWith("weekly")) continue;
      const scopedLabel =
        pickNestedString(item, ["scope", "model", "display_name"]) ??
        pickNestedString(item, ["scope", "model", "name"]) ??
        pickNestedString(item, ["scope", "surface", "display_name"]) ??
        pickNestedString(item, ["scope", "surface", "name"]);
      const label =
        kind === "weekly_all"
          ? "All models"
          : (pickString(item, [
              "label",
              "name",
              "display_name",
              "displayName",
              "model_name",
              "modelName",
              "model",
              "title",
            ]) ?? scopedLabel);
      const id =
        pickNestedString(item, ["scope", "model", "id"]) ??
        pickNestedString(item, ["scope", "surface", "id"]) ??
        (kind === "weekly_scoped" ? scopedLabel : null) ??
        pickString(item, [
          "id",
          "key",
          "limit_id",
          "limitId",
          "model_id",
          "modelId",
          "model",
          "kind",
        ]) ??
        label;
      if (id) pushWeeklyWindow(windows, seen, id, label, item);
    }
    return;
  }

  if (!isRecord(raw)) return;
  for (const key of ["limits", "windows", "data", "items"] as const) {
    if (Array.isArray(raw[key])) {
      parseAnthropicWeeklyCollection(raw[key], windows, seen);
    }
  }
  for (const [key, value] of Object.entries(raw)) {
    if (["limits", "windows", "data", "items"].includes(key)) continue;
    if (!isRecord(value)) continue;
    const label = pickString(value, [
      "label",
      "name",
      "display_name",
      "displayName",
      "model_name",
      "modelName",
      "model",
      "title",
    ]);
    const id =
      pickString(value, ["id", "key", "limit_id", "limitId", "model_id", "modelId", "model"]) ??
      key;
    pushWeeklyWindow(windows, seen, id, label ?? labelFromId(key), value);
  }
}

function parseAnthropicWeeklyWindows(usageJson: Record<string, unknown>): UsageNamedWindow[] {
  const windows: UsageNamedWindow[] = [];
  const seen = new Set<string>();

  pushWeeklyWindow(windows, seen, "all", "All models", usageJson.seven_day);
  for (const key of Object.keys(usageJson).toSorted()) {
    if (!key.startsWith("seven_day_")) continue;
    pushWeeklyWindow(windows, seen, key, labelFromId(key), usageJson[key]);
  }

  for (const key of [
    "weekly_limits",
    "weeklyLimits",
    "weekly_windows",
    "weeklyWindows",
    "weekly_usage",
    "weeklyUsage",
  ] as const) {
    parseAnthropicWeeklyCollection(usageJson[key], windows, seen);
  }
  parseAnthropicWeeklyCollection(usageJson.limits, windows, seen);

  return windows;
}

function findWeeklyWindow(windows: UsageNamedWindow[], id: string): UsageWindow | null {
  return windows.find((window) => window.id === id)?.window ?? null;
}

function findLimitWindow(
  usageJson: Record<string, unknown>,
  matches: (item: Record<string, unknown>) => boolean,
): UsageWindow | null {
  if (!Array.isArray(usageJson.limits)) return null;
  for (const item of usageJson.limits) {
    if (!isRecord(item) || !matches(item)) continue;
    const window = parseAnthropicWindowCandidate(item);
    if (window) return window;
  }
  return null;
}

// 429 from Anthropic carries a `retry-after` (seconds). Tracking it here so
// the top-level cache can extend its TTL past the retry window. Otherwise
// repeated Refresh clicks would each pay another rejection round-trip.
const claudeBackoffUntilMs = new Map<string, number>();

async function fetchClaudeUsage(
  store: UsageAuthStore,
  cacheKey: string,
): Promise<UsageResultClaude> {
  const secret = await readClaudeOauthSecret(store);
  if (!secret?.accessToken) {
    return { ok: false, error: "Claude credentials not found" };
  }
  const backoffUntilMs = claudeBackoffUntilMs.get(cacheKey) ?? 0;
  if (Date.now() < backoffUntilMs) {
    const wait = Math.ceil((backoffUntilMs - Date.now()) / 1000);
    return {
      ok: false,
      error: `Anthropic usage endpoint rate-limited, retry in ${wait}s`,
    };
  }

  let usageJson: Record<string, unknown>;
  try {
    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${secret.accessToken}`,
        "anthropic-beta": CLAUDE_OAUTH_BETA,
        "User-Agent": CLAUDE_CODE_USER_AGENT,
      },
    });
    if (!res.ok) {
      if (res.status === 429) {
        // Anthropic's /oauth/usage 429 always sends `retry-after: 0` with no
        // other reset hint, so the header is useless. Fall back to a fixed
        // 60s backoff, but honor a positive hint if they ever start sending
        // one.
        const raw = res.headers.get("retry-after");
        const hinted = raw == null ? NaN : Number(raw);
        const seconds = Number.isFinite(hinted) && hinted > 0 ? hinted : 60;
        claudeBackoffUntilMs.set(cacheKey, Date.now() + seconds * 1000);
        return {
          ok: false,
          error: `Anthropic usage endpoint rate-limited, retry in ${seconds}s`,
        };
      }
      return {
        ok: false,
        error: `Anthropic /oauth/usage returned HTTP ${res.status}`,
      };
    }
    usageJson = (await res.json()) as Record<string, unknown>;
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Best-effort profile lookup so the UI can show which account this is for.
  // Failures here don't fail the whole call, since usage is the useful payload.
  let profileEmail: string | null = null;
  let organizationName: string | null = null;
  try {
    const res = await fetch("https://api.anthropic.com/api/oauth/profile", {
      headers: {
        Authorization: `Bearer ${secret.accessToken}`,
        "anthropic-beta": CLAUDE_OAUTH_BETA,
        "User-Agent": CLAUDE_CODE_USER_AGENT,
      },
    });
    if (res.ok) {
      const profile = (await res.json()) as {
        account?: { email?: string | null };
        organization?: { name?: string | null };
      };
      profileEmail = profile.account?.email ?? null;
      organizationName = profile.organization?.name ?? null;
    }
  } catch {}

  const extra = usageJson.extra_usage as
    | {
        is_enabled?: unknown;
        monthly_limit?: unknown;
        used_credits?: unknown;
        currency?: unknown;
      }
    | null
    | undefined;

  const weeklyWindows = parseAnthropicWeeklyWindows(usageJson);
  const data: UsageClaude = {
    account: {
      email: profileEmail,
      organizationName,
      rateLimitTier: secret.rateLimitTier ?? null,
      subscriptionType: secret.subscriptionType ?? null,
    },
    fiveHour:
      parseAnthropicWindowCandidate(usageJson.five_hour) ??
      parseAnthropicWindowCandidate(usageJson.current_session) ??
      parseAnthropicWindowCandidate(usageJson.currentSession) ??
      findLimitWindow(
        usageJson,
        (item) =>
          pickString(item, ["kind"]) === "session" || pickString(item, ["group"]) === "session",
      ),
    sevenDay:
      parseAnthropicWindowCandidate(usageJson.seven_day) ?? findWeeklyWindow(weeklyWindows, "all"),
    weeklyWindows,
    sevenDayOpus:
      parseAnthropicWindowCandidate(usageJson.seven_day_opus) ??
      findWeeklyWindow(weeklyWindows, "opus"),
    sevenDaySonnet:
      parseAnthropicWindowCandidate(usageJson.seven_day_sonnet) ??
      findWeeklyWindow(weeklyWindows, "sonnet"),
    extraUsage:
      extra && typeof extra === "object"
        ? {
            enabled: Boolean(extra.is_enabled),
            // /api/oauth/usage reports these amounts in minor currency units
            // (cents), e.g. 1234 = 12.34. The rest of the app works in major
            // units (matching costUsd / Claude's total_cost_usd), so normalize
            // at the boundary — the UI renders these with `.toFixed(2)`.
            monthlyLimit: typeof extra.monthly_limit === "number" ? extra.monthly_limit / 100 : 0,
            usedCredits: typeof extra.used_credits === "number" ? extra.used_credits / 100 : 0,
            currency: typeof extra.currency === "string" ? extra.currency : "USD",
          }
        : null,
  };
  return { ok: true, data };
}

// ---------- Codex ----------

type AppServerSend = (method: string, params: unknown) => Promise<unknown>;

interface AppServerRateLimitWindow {
  usedPercent?: unknown;
  windowDurationMins?: unknown;
  resetsAt?: unknown;
}

interface AppServerCredits {
  hasCredits?: unknown;
  unlimited?: unknown;
  balance?: unknown;
}

interface AppServerRateLimitSnapshot {
  primary?: AppServerRateLimitWindow | null;
  secondary?: AppServerRateLimitWindow | null;
  credits?: AppServerCredits | null;
  planType?: unknown;
  rateLimitReachedType?: unknown;
}

interface AppServerRateLimitsResponse {
  rateLimits?: AppServerRateLimitSnapshot | null;
  rateLimitsByLimitId?: Record<string, AppServerRateLimitSnapshot | null | undefined> | null;
}

interface AppServerAccountResponse {
  account?: {
    type?: unknown;
    email?: unknown;
    planType?: unknown;
  } | null;
}

function parseAppServerWindow(
  raw: AppServerRateLimitWindow | null | undefined,
): UsageWindow | null {
  if (!raw || typeof raw.usedPercent !== "number") return null;
  const resetsAt =
    typeof raw.resetsAt === "number"
      ? new Date(raw.resetsAt < 10_000_000_000 ? raw.resetsAt * 1000 : raw.resetsAt)
      : null;
  return {
    utilization: raw.usedPercent,
    resetsAt,
    windowSeconds: typeof raw.windowDurationMins === "number" ? raw.windowDurationMins * 60 : null,
  };
}

function pickCodexRateLimit(body: AppServerRateLimitsResponse): AppServerRateLimitSnapshot | null {
  return body.rateLimitsByLimitId?.codex ?? body.rateLimits ?? null;
}

export async function fetchCodexUsageFromAppServer(send: AppServerSend): Promise<UsageResultCodex> {
  try {
    const [rateLimitsRaw, accountRaw] = await Promise.all([
      send("account/rateLimits/read", undefined),
      send("account/read", {}),
    ]);
    const rateLimits = rateLimitsRaw as AppServerRateLimitsResponse;
    const account = accountRaw as AppServerAccountResponse;
    const snapshot = pickCodexRateLimit(rateLimits);
    if (!snapshot)
      return {
        ok: false,
        error: "Codex app-server returned no rate-limit snapshot",
      };

    const credits = snapshot.credits
      ? {
          hasCredits: Boolean(snapshot.credits.hasCredits),
          balance: snapshot.credits.balance == null ? null : String(snapshot.credits.balance),
          unlimited: Boolean(snapshot.credits.unlimited),
        }
      : null;
    const activeLimit =
      typeof snapshot.rateLimitReachedType === "string" ? snapshot.rateLimitReachedType : null;
    const chatgptAccount = account.account?.type === "chatgpt" ? account.account : null;
    const data: UsageCodex = {
      email: typeof chatgptAccount?.email === "string" ? chatgptAccount.email : null,
      planType:
        typeof snapshot.planType === "string"
          ? snapshot.planType
          : typeof chatgptAccount?.planType === "string"
            ? chatgptAccount.planType
            : null,
      activeLimit,
      primary: parseAppServerWindow(snapshot.primary),
      secondary: parseAppServerWindow(snapshot.secondary),
      credits,
    };
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function fetchCodexUsageUnavailable(store: UsageAuthStore): UsageResultCodex {
  return {
    ok: false,
    error: store.read("codex")
      ? "Codex usage requires a profile app-server"
      : "Codex credentials not found (sign in to Codex)",
  };
}

// ---------- Top-level ----------

// Both upstreams rate-limit their own usage endpoints separately from the
// user's chat quota. Anthropic returned 429 with `retry-after: 235` after
// only a handful of probe calls. The 5-hour and 7-day windows themselves
// move on the order of minutes, so we cache aggressively per-provider:
//   - SUCCESS_TTL: don't re-call upstream for this long after a good fetch.
//   - ERROR_TTL:   after a failure, wait this long before trying again.
//                  Anthropic 429s on /oauth/usage routinely arrive in
//                  bursts, so this stops a hot caller from re-probing every
//                  few seconds.
//   - STALE_FALLBACK_MAX: when a refresh fails, keep serving the last
//                  successful snapshot up to this old. The window
//                  utilization shown will be slightly stale but vastly
//                  better than blanking the panel for the duration of an
//                  Anthropic rate-limit episode (often minutes).
const SUCCESS_TTL_MS = 60_000;
const ERROR_TTL_MS = 10_000;
const STALE_FALLBACK_MAX_MS = 30 * 60_000;

interface ProviderCache<R extends { ok: boolean }> {
  // Most recently fetched result (success or error), with the time it
  // came back from upstream. Used to gate re-fetches via SUCCESS/ERROR TTL.
  latest: { result: R; fetchedAtMs: number } | null;
  // Most recent successful result. Preserved across failures so we can
  // serve it as a stale fallback while upstream is unhappy.
  lastSuccess: { result: Extract<R, { ok: true }>; fetchedAtMs: number } | null;
  // Deduplicate concurrent refreshes against the same upstream.
  inFlight: Promise<R> | null;
}

const claudeCaches = new Map<string, ProviderCache<UsageResultClaude>>();
const codexCaches = new Map<string, ProviderCache<UsageResultCodex>>();

function providerCache<R extends { ok: boolean }>(
  caches: Map<string, ProviderCache<R>>,
  key: string,
): ProviderCache<R> {
  let cache = caches.get(key);
  if (!cache) {
    cache = { latest: null, lastSuccess: null, inFlight: null };
    caches.set(key, cache);
  }
  return cache;
}

async function getCachedProvider<R extends { ok: boolean }>(
  cache: ProviderCache<R>,
  fetcher: () => Promise<R>,
): Promise<R> {
  const now = Date.now();
  // Within either TTL → no upstream call. For errors we still prefer to
  // return the stale-success fallback below over the cached error.
  if (cache.latest) {
    const age = now - cache.latest.fetchedAtMs;
    if (cache.latest.result.ok && age < SUCCESS_TTL_MS) {
      return cache.latest.result;
    }
    if (!cache.latest.result.ok && age < ERROR_TTL_MS) {
      return staleOr(cache, cache.latest.result, now);
    }
  }
  if (cache.inFlight) return cache.inFlight;
  cache.inFlight = (async () => {
    try {
      const result = await fetcher();
      cache.latest = { result, fetchedAtMs: now };
      if (result.ok) {
        cache.lastSuccess = {
          result: result as Extract<R, { ok: true }>,
          fetchedAtMs: now,
        };
        return result;
      }
      return staleOr(cache, result, now);
    } finally {
      cache.inFlight = null;
    }
  })();
  return cache.inFlight;
}

// Prefer the last-known-good result over the current error if it's recent
// enough to still be useful. Falls back to the error when no usable stale
// data exists (e.g. first-ever call, or we haven't succeeded in 30+ min).
function staleOr<R extends { ok: boolean }>(
  cache: ProviderCache<R>,
  errorResult: R,
  now: number,
): R {
  if (cache.lastSuccess && now - cache.lastSuccess.fetchedAtMs < STALE_FALLBACK_MAX_MS) {
    return cache.lastSuccess.result;
  }
  return errorResult;
}

export async function getUsageStats(opts: {
  authStore: UsageAuthStore;
  cacheKey?: string;
  fetchCodexUsage?: () => Promise<UsageResultCodex>;
}): Promise<UsageStats> {
  const store = opts.authStore;
  const cacheKey = opts.cacheKey ?? "__default__";
  const [claude, codex] = await Promise.all([
    getCachedProvider(providerCache(claudeCaches, cacheKey), () =>
      fetchClaudeUsage(store, cacheKey),
    ),
    getCachedProvider(
      providerCache(codexCaches, cacheKey),
      opts.fetchCodexUsage ?? (() => Promise.resolve(fetchCodexUsageUnavailable(store))),
    ),
  ]);
  // `aggregate` is filled in by the /api/usage route after this resolves. It
  // pulls from the chats table, which getUsageStats has no handle
  // on. Initialize to null so the type is satisfied.
  return { fetchedAtMs: Date.now(), claude, codex, aggregate: null };
}
