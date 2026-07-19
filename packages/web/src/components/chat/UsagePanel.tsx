// The composer bar's usage surfaces: the context-pressure bar under the
// model picker, and the token/cost/subscription breakdowns shown in the
// picker dropdown. Data comes from Chat.tsx's UsageState (persisted-row
// seed + live SSE usage events).
import { formatTokens } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ContextBreakdown } from "../../lib/contracts";
import type { SubscriptionShare, UsageState } from "./chunks";

// Rich token-usage breakdown shown both in the composer-bar tooltip and inside
// the model-picker dropdown. The denominator prefers the provider-reported
// value (codex sends it on every usage update) and falls back to the catalog
// entry. The numerator is the most recent turn's input + cached input, the
// size of the prompt packed into the model on the last turn, which is the
// most faithful "context pressure" signal we can show without per-block
// tokenization.
export function ContextDetail({
  usage,
  catalogWindow,
}: {
  usage: UsageState;
  catalogWindow?: number;
}) {
  const window = usage.modelContextWindow ?? catalogWindow;
  const usedNow =
    usage.last.inputTokens + usage.last.cachedInputTokens + usage.last.cacheCreationInputTokens;
  const pct = window ? Math.min(100, (usedNow / window) * 100) : null;
  return (
    <div className="space-y-1 font-mono text-xs">
      <div className="font-sans text-[10px] uppercase tracking-wider text-muted-foreground">
        Context
      </div>
      <div className="flex justify-between gap-4">
        <span className="text-muted-foreground">used</span>
        <span className="tabular-nums">
          {formatTokens(usedNow)}
          {window ? ` / ${formatTokens(window)}` : ""}
          {pct != null ? ` · ${pct.toFixed(0)}%` : ""}
        </span>
      </div>
      {usage.compacted && <div className="text-amber-500/80 text-[10px]">thread compacted</div>}
      <div className="font-sans text-[10px] uppercase tracking-wider text-muted-foreground pt-1">
        Last turn
      </div>
      <UsageRow label="input" n={usage.last.inputTokens} />
      <UsageRow label="cached" n={usage.last.cachedInputTokens} />
      {usage.last.cacheCreationInputTokens > 0 && (
        <UsageRow label="cache write" n={usage.last.cacheCreationInputTokens} />
      )}
      <UsageRow label="output" n={usage.last.outputTokens} />
      {usage.last.reasoningOutputTokens > 0 && (
        <UsageRow label="reasoning" n={usage.last.reasoningOutputTokens} />
      )}
      <div className="font-sans text-[10px] uppercase tracking-wider text-muted-foreground pt-1">
        Total
      </div>
      <UsageRow label="all turns" n={usage.total.totalTokens} />
      {usage.costUsd != null && (
        <UsageRow label="cost" n={usage.costUsd} suffix="$" precision={4} />
      )}
      {usage.subscriptionShare && <SubscriptionShareRows share={usage.subscriptionShare} />}
    </div>
  );
}

// Renders the per-chat subscription-window share under the existing
// Context/Last/Total breakdown. Numbers are deliberately labeled as
// "approximate". See subscription-share.ts on the server for the
// underlying math and its caveats.
function SubscriptionShareRows({ share }: { share: SubscriptionShare }) {
  const showFiveHour = share.fiveHourPct != null;
  const showSevenDay = share.sevenDayPct != null;
  if (!showFiveHour && !showSevenDay) return null;
  return (
    <>
      <div className="font-sans text-[10px] uppercase tracking-wider text-muted-foreground pt-1">
        Subscription
      </div>
      {showFiveHour && <ShareRow label="5h window" chatPct={share.fiveHourPct!} />}
      {showSevenDay && <ShareRow label="7d window" chatPct={share.sevenDayPct!} />}
    </>
  );
}

function ShareRow({ label, chatPct }: { label: string; chatPct: number }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">{chatPct.toFixed(2)}%</span>
    </div>
  );
}

// Per-category breakdown from Claude's structured `get_context_usage`
// response. Anthropic-only. Codex chats render the unavailable hint. Each row
// mirrors a category reported by the live CLI process.
export function ContextBreakdownDetail({
  breakdown,
  loading,
  error,
  onLoad,
}: {
  breakdown: ContextBreakdown | null;
  loading: boolean;
  error: string | null;
  onLoad: () => void;
}) {
  if (loading) {
    return (
      <div className="font-mono text-[10px] text-muted-foreground">Loading context breakdown…</div>
    );
  }
  if (error) {
    return (
      <button
        type="button"
        onClick={onLoad}
        className="font-mono text-[10px] text-destructive/80 hover:text-destructive text-left"
      >
        Context breakdown: {error} (retry)
      </button>
    );
  }
  if (!breakdown) {
    return (
      <button
        type="button"
        onClick={onLoad}
        className="font-mono text-[10px] text-muted-foreground hover:text-foreground text-left"
      >
        Show context breakdown
      </button>
    );
  }
  if (!breakdown.available) {
    return (
      <div className="font-mono text-[10px] text-muted-foreground">
        Breakdown unavailable ({breakdown.reason}).
      </div>
    );
  }
  return (
    <div className="space-y-1 font-mono text-xs">
      <div className="font-sans text-[10px] uppercase tracking-wider text-muted-foreground">
        Breakdown
      </div>
      {breakdown.categories
        .filter((c) => {
          const name = c.name.toLowerCase();
          return name !== "free space" && name !== "autocompact buffer";
        })
        .map((c) => (
          <div key={c.name} className="flex justify-between gap-4">
            <span className="text-muted-foreground">{c.name.toLowerCase()}</span>
            <span className="tabular-nums">{formatTokens(c.tokens)}</span>
          </div>
        ))}
    </div>
  );
}

// Thin context-pressure bar that sits underneath the model selector in the
// composer toolbar. The detailed breakdown lives in the model-picker dropdown.
export function ContextBar({
  usage,
  catalogWindow,
}: {
  usage: UsageState | null;
  catalogWindow?: number;
}) {
  const window = usage?.modelContextWindow ?? catalogWindow;
  const usedNow = usage
    ? usage.last.inputTokens + usage.last.cachedInputTokens + usage.last.cacheCreationInputTokens
    : 0;
  const pct = window ? Math.min(100, (usedNow / window) * 100) : null;
  const color =
    pct == null
      ? "bg-muted-foreground/40"
      : pct >= 90
        ? "bg-red-500"
        : pct >= 75
          ? "bg-amber-500"
          : "bg-muted-foreground/60";
  return (
    <div className="h-0.5 mt-0.5 bg-muted rounded-full overflow-hidden pointer-events-none">
      <div
        className={cn("h-full transition-[width] duration-200", color)}
        style={{ width: `${pct ?? 0}%` }}
      />
    </div>
  );
}

function UsageRow({
  label,
  n,
  suffix,
  precision,
}: {
  label: string;
  n: number;
  suffix?: string;
  precision?: number;
}) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">
        {suffix === "$" ? `$${n.toFixed(precision ?? 2)}` : formatTokens(n)}
      </span>
    </div>
  );
}
