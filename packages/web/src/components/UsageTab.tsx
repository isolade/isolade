import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCost, formatTokens } from "@/lib/format";
import { getUsageHistory, getUsageStats } from "../lib/api";
import type {
  AggregateTotals,
  AggregateTotalsBucket,
  UsageClaude,
  UsageCodex,
  UsageDay,
  UsageNamedWindow,
  UsageStats,
  UsageWindow,
} from "../lib/contracts";
import UsageHeatmap from "./UsageHeatmap";

function formatUtilization(util: number): string {
  return `${util.toFixed(1)}%`;
}

function formatResetsIn(resetsAt: Date | null): string {
  if (!resetsAt) return "N/A";
  const ms = resetsAt.getTime() - Date.now();
  if (ms <= 0) return "now";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function Bar({ utilization }: { utilization: number }) {
  const filled = Math.max(0, Math.min(100, utilization));
  // The bar shows usage (not remaining), so a high number = bad. Colors
  // shift past common danger thresholds so users notice without having to
  // read the percentage.
  const color = filled >= 90 ? "bg-red-500" : filled >= 70 ? "bg-amber-500" : "bg-emerald-500";
  return (
    <div className="h-3 bg-muted rounded overflow-hidden">
      <div className={`${color} h-full transition-all`} style={{ width: `${filled}%` }} />
    </div>
  );
}

function WindowRow({
  label,
  window,
  unavailableLabel = "not applicable",
}: {
  label: string;
  window: UsageWindow | null;
  unavailableLabel?: string;
}) {
  if (!window) {
    return (
      <div className="flex flex-col gap-1 py-2 border-b border-border last:border-0">
        <div className="flex items-baseline justify-between text-sm">
          <span>{label}</span>
          <span className="text-xs text-muted-foreground">{unavailableLabel}</span>
        </div>
      </div>
    );
  }
  const resetsAt =
    window.resetsAt instanceof Date
      ? window.resetsAt
      : window.resetsAt
        ? new Date(window.resetsAt)
        : null;
  return (
    <div className="flex flex-col gap-1 py-2 border-b border-border last:border-0">
      <div className="flex items-baseline justify-between text-sm">
        <span>{label}</span>
        <span className="font-mono tabular-nums text-xs">
          {formatUtilization(window.utilization)}
        </span>
      </div>
      <Bar utilization={window.utilization} />
      <div className="text-xs text-muted-foreground">
        resets in {formatResetsIn(resetsAt)}
        {resetsAt && (
          <span className="ml-2 text-muted-foreground/70">({resetsAt.toLocaleString()})</span>
        )}
      </div>
    </div>
  );
}

// Lifetime token + cost totals, summed from every persisted chat row.
// Layout mirrors the existing window cards: card header, then a small
// grid with per-provider breakdowns plus a grand-total column. Cost gets
// the prominent slot because it's the number users actually care about.
function LifetimeCard({ aggregate }: { aggregate: AggregateTotals }) {
  return (
    <Card className="gap-3 py-4">
      <CardHeader className="px-4 [.border-b]:pb-0">
        <CardTitle className="text-sm">Lifetime (API-equivalent)</CardTitle>
        <CardAction className="text-xs text-muted-foreground font-normal">
          across {aggregate.total.chats} chat
          {aggregate.total.chats === 1 ? "" : "s"}
        </CardAction>
      </CardHeader>
      <CardContent className="px-4">
        <div className="text-2xl font-mono tabular-nums">{formatCost(aggregate.total.costUsd)}</div>
        <div className="mt-3 grid grid-cols-3 gap-3 text-xs">
          <LifetimeColumn label="Anthropic" bucket={aggregate.anthropic} />
          <LifetimeColumn label="OpenAI" bucket={aggregate.openai} />
          <LifetimeColumn label="Total" bucket={aggregate.total} emphasized />
        </div>
      </CardContent>
    </Card>
  );
}

function LifetimeColumn({
  label,
  bucket,
  emphasized,
}: {
  label: string;
  bucket: AggregateTotalsBucket;
  emphasized?: boolean;
}) {
  const cls = emphasized ? "text-foreground" : "text-muted-foreground";
  const share = bucket.subscriptionShare;
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`font-mono tabular-nums ${cls}`}>{formatCost(bucket.costUsd)}</div>
      <div className="text-muted-foreground/80 space-y-0.5">
        <Row k="input" v={bucket.inputTokens} />
        <Row k="cached" v={bucket.cachedInputTokens} />
        {bucket.cacheCreationInputTokens > 0 && (
          <Row k="cache write" v={bucket.cacheCreationInputTokens} />
        )}
        <Row k="output" v={bucket.outputTokens} />
        {bucket.reasoningOutputTokens > 0 && <Row k="reasoning" v={bucket.reasoningOutputTokens} />}
      </div>
      {share && (share.fiveHourPct != null || share.sevenDayPct != null) && (
        <div className="mt-1 pt-1 border-t border-border/50 text-muted-foreground/80 space-y-0.5">
          <div className="text-[10px] uppercase tracking-wider">Subscription</div>
          {share.fiveHourPct != null && <ShareRow k="5h window" v={share.fiveHourPct} />}
          {share.sevenDayPct != null && <ShareRow k="7d window" v={share.sevenDayPct} />}
        </div>
      )}
    </div>
  );
}

function ShareRow({ k, v }: { k: string; v: number }) {
  return (
    <div className="flex justify-between gap-2">
      <span>{k}</span>
      <span className="font-mono tabular-nums">{v.toFixed(2)}%</span>
    </div>
  );
}

function Row({ k, v }: { k: string; v: number }) {
  return (
    <div className="flex justify-between gap-2">
      <span>{k}</span>
      <span className="font-mono tabular-nums">{formatTokens(v)}</span>
    </div>
  );
}

function ClaudeCard({ result }: { result: UsageStats["claude"] }) {
  return (
    <Card className="gap-3 py-4">
      <CardHeader className="px-4 [.border-b]:pb-0">
        <CardTitle className="text-sm">Claude</CardTitle>
        {result.ok && result.data.account?.email && (
          <CardAction className="text-xs text-muted-foreground font-normal">
            {result.data.account.email}
            {result.data.account.organizationName && (
              <span className="ml-2 text-muted-foreground/70">
                · {result.data.account.organizationName}
              </span>
            )}
            {result.data.account.subscriptionType && (
              <span className="ml-2 text-muted-foreground/70">
                · {result.data.account.subscriptionType}
              </span>
            )}
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="px-4">
        {result.ok ? (
          <ClaudeBody data={result.data} />
        ) : (
          <div className="text-sm text-destructive">{result.error}</div>
        )}
      </CardContent>
    </Card>
  );
}

function ClaudeBody({ data }: { data: UsageClaude }) {
  const fallbackWeeklyWindows: UsageNamedWindow[] = [
    data.sevenDay ? { id: "all", label: "All models", window: data.sevenDay } : null,
    data.sevenDayOpus ? { id: "opus", label: "Opus", window: data.sevenDayOpus } : null,
    data.sevenDaySonnet ? { id: "sonnet", label: "Sonnet", window: data.sevenDaySonnet } : null,
  ].filter((window): window is UsageNamedWindow => window != null);
  const weeklyWindows = data.weeklyWindows.length > 0 ? data.weeklyWindows : fallbackWeeklyWindows;
  return (
    <div className="flex flex-col">
      <WindowRow
        label="Current session"
        window={data.fiveHour}
        unavailableLabel="starts when a message is sent"
      />
      {weeklyWindows.map((entry) => (
        <WindowRow key={entry.id} label={`Weekly · ${entry.label}`} window={entry.window} />
      ))}
      {data.extraUsage && (
        <div className="mt-3 pt-3 border-t border-border text-xs text-muted-foreground space-y-1">
          <div className="flex justify-between">
            <span>Extra usage</span>
            <span>{data.extraUsage.enabled ? "enabled" : "disabled"}</span>
          </div>
          <div className="flex justify-between">
            <span>Used credits</span>
            <span className="font-mono tabular-nums">
              {data.extraUsage.usedCredits.toFixed(2)} {data.extraUsage.currency}
            </span>
          </div>
          <div className="flex justify-between">
            <span>Monthly limit</span>
            <span className="font-mono tabular-nums">
              {data.extraUsage.monthlyLimit.toFixed(2)} {data.extraUsage.currency}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function CodexCard({ result }: { result: UsageStats["codex"] }) {
  return (
    <Card className="gap-3 py-4">
      <CardHeader className="px-4 [.border-b]:pb-0">
        <CardTitle className="text-sm">Codex</CardTitle>
        {result.ok && (result.data.email || result.data.planType || result.data.activeLimit) && (
          <CardAction className="text-xs text-muted-foreground font-normal">
            {result.data.email ?? result.data.planType ?? "N/A"}
            {result.data.email && result.data.planType && (
              <span className="ml-2 text-muted-foreground/70">· {result.data.planType}</span>
            )}
            {result.data.activeLimit && (
              <span className="ml-2 text-muted-foreground/70">· {result.data.activeLimit}</span>
            )}
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="px-4">
        {result.ok ? (
          <CodexBody data={result.data} />
        ) : (
          <div className="text-sm text-destructive">{result.error}</div>
        )}
      </CardContent>
    </Card>
  );
}

function CodexBody({ data }: { data: UsageCodex }) {
  return (
    <div className="flex flex-col">
      <WindowRow label="5-hour window" window={data.primary} />
      <WindowRow label="Weekly" window={data.secondary} />
      {data.credits && (
        <div className="mt-3 pt-3 border-t border-border text-xs text-muted-foreground space-y-1">
          <div className="flex justify-between">
            <span>Credits</span>
            <span>
              {data.credits.unlimited
                ? "unlimited"
                : data.credits.hasCredits
                  ? "available"
                  : "none"}
            </span>
          </div>
          {data.credits.balance && (
            <div className="flex justify-between">
              <span>Balance</span>
              <span className="font-mono tabular-nums">{data.credits.balance}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Persisted daily spend, drawn as a GitHub-style contribution graph. Lives in
// its own card above the live rate-limit panels. It's the "over time" view,
// where those are "right now".
function HistoryCard({ days }: { days: UsageDay[] }) {
  return (
    <Card className="gap-3 py-4">
      <CardHeader className="px-4 [.border-b]:pb-0">
        <CardTitle className="text-sm">Usage over time</CardTitle>
        <CardAction className="text-xs text-muted-foreground font-normal">
          API-equivalent, per day
        </CardAction>
      </CardHeader>
      <CardContent className="px-4">
        {days.length > 0 ? (
          <UsageHeatmap days={days} />
        ) : (
          <div className="py-6 text-center text-sm text-muted-foreground">
            No usage recorded yet. Your daily activity will appear here.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function UsageTab({ activeProfileId }: { activeProfileId: string | null }) {
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [history, setHistory] = useState<UsageDay[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!activeProfileId) return;
    setLoading(true);
    // The live rate-limit stats and the local history series are independent,
    // so a failure or slow upstream on one shouldn't blank the other.
    const [statsResult, historyResult] = await Promise.allSettled([
      getUsageStats(activeProfileId),
      getUsageHistory(activeProfileId),
    ]);
    if (statsResult.status === "fulfilled") {
      setStats(statsResult.value);
      setError(null);
    } else {
      setError(
        statsResult.reason instanceof Error
          ? statsResult.reason.message
          : String(statsResult.reason),
      );
    }
    if (historyResult.status === "fulfilled") {
      setHistory(historyResult.value.days);
    }
    setLoading(false);
  }, [activeProfileId]);

  useEffect(() => {
    setStats(null);
    setHistory(null);
    setError(null);
    void load();
  }, [load]);

  if (!activeProfileId) {
    return <div className="p-6 text-sm text-muted-foreground">No profile selected.</div>;
  }

  if (error && !stats) {
    return (
      <div className="p-6 text-sm text-destructive">
        Failed to load usage: {error}
        <div className="mt-3">
          <Button size="sm" variant="outline" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      </div>
    );
  }
  if (!stats) {
    return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  }

  const fetchedAt = new Date(stats.fetchedAtMs);

  return (
    <div className="h-full overflow-auto p-4 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          Fetched {fetchedAt.toLocaleTimeString()}
          {loading && <span className="ml-2">refreshing…</span>}
        </div>
        <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
          Refresh
        </Button>
      </div>
      {history && <HistoryCard days={history} />}
      {stats.aggregate && <LifetimeCard aggregate={stats.aggregate} />}
      <div className="grid gap-4 grid-cols-1 lg:grid-cols-2">
        <ClaudeCard result={stats.claude} />
        <CodexCard result={stats.codex} />
      </div>
    </div>
  );
}
