// The composer bar's usage surfaces: whether the agent is working and for how
// long, the running chat cost beside it in the composer's bottom row, the
// context-pressure bar under the model picker, and the token/cost/subscription
// breakdowns shown in the picker dropdown. Data comes from Chat.tsx's UsageState
// (persisted-row seed + live SSE usage events) and its turn clock.
import { Check, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { formatDuration, formatTokens } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  type ChatCostBreakdown,
  type ChatCostBucket,
  type ContextBreakdown,
  findChatModel,
} from "../../lib/contracts";
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
      {/* The token rows are the live session's, but cost spans the whole chat,
          agent switches included. It is the same figure the composer shows, to
          more decimal places. */}
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

// How long the cost ticker takes to travel to a new total. Long enough to read
// as a count-up, short enough to have settled well before the next usage event.
const COST_TWEEN_MS = 700;

// Animate a number toward `target`, returning the figure to paint right now.
// Mounting does not animate (a reloaded chat shows its total straight away);
// only a change while mounted counts up. A target that lands mid-count-up is
// picked up from wherever the animation had got to.
function useCountUp(target: number): number {
  const [value, setValue] = useState(target);
  const shownRef = useRef(target);
  useEffect(() => {
    if (shownRef.current === target) return;
    if (globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      shownRef.current = target;
      setValue(target);
      return;
    }
    const from = shownRef.current;
    const start = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const progress = Math.min(1, (now - start) / COST_TWEEN_MS);
      // Ease out: quick off the mark, then settling into the new total.
      const eased = 1 - (1 - progress) ** 3;
      shownRef.current = progress < 1 ? from + (target - from) * eased : target;
      setValue(shownRef.current);
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target]);
  return value;
}

const BUCKET_LABELS: Record<ChatCostBucket["bucket"], string> = {
  input: "input",
  cachedInput: "cache read",
  cacheWrite: "cache write",
  cacheWrite1h: "cache write 1h",
  output: "output",
  reasoningOutput: "reasoning",
};

// A residual worth showing: half a cent and at least 1% of the bill. Below that
// it is rounding, and a row of noise explains nothing.
function materialResidual(breakdown: ChatCostBreakdown): boolean {
  const size = Math.abs(breakdown.unattributed);
  return size >= 0.005 && size >= breakdown.billed * 0.01;
}

// Every figure in this card is shown to the same four decimals, rather than the
// magnitude-dependent precision used elsewhere: this is the view you open to
// reconcile numbers, and a column whose precision changed row by row would not
// visibly add up even when the data does. Signed, because the residual can be
// negative when list prices overstate the bill.
function detailCost(n: number): string {
  return `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(4)}`;
}

// Where the chat's money went, itemized. Tokens are exact and each part is
// priced at the model it was billed at, so a chat that switched agents still
// adds up. The total is what the providers actually charged: for codex it is
// these very buckets, but Claude reports a turn's cost as a figure of its own,
// so anything list prices can't explain (searches billed per request, cache
// written at a longer TTL than the rate card assumes) lands in "other" rather
// than being smeared across the rows. Those rows are left to speak for
// themselves: the card is numbers, not explanations.
//
// `inFlight` is what the turn currently running has added to the composer's
// figure but not yet to any bill. Shown so the card and the figure above it
// agree while a turn streams, instead of appearing to disagree by exactly the
// amount nobody has been charged for yet.
export function CostBreakdownDetail({
  breakdown,
  inFlightUsd = 0,
}: {
  breakdown: ChatCostBreakdown;
  inFlightUsd?: number;
}) {
  const showResidual = materialResidual(breakdown);
  const showInFlight = inFlightUsd >= 0.00005;
  return (
    <div className="space-y-1 font-mono text-xs">
      <div className="font-sans text-[10px] uppercase tracking-wider text-muted-foreground">
        Cost
      </div>
      {breakdown.buckets.map((bucket) => (
        <div key={bucket.bucket} className="flex justify-between gap-4">
          <span className="text-muted-foreground">{BUCKET_LABELS[bucket.bucket]}</span>
          <span className="tabular-nums">
            <span className="text-muted-foreground">{formatTokens(bucket.tokens)}</span>{" "}
            {detailCost(bucket.costUsd)}
          </span>
        </div>
      ))}
      {breakdown.webSearchRequests > 0 && (
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">web search</span>
          <span className="tabular-nums text-muted-foreground">
            {breakdown.webSearchRequests}
            {breakdown.webSearchRequests === 1 ? " request" : " requests"}
          </span>
        </div>
      )}
      {showResidual && (
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">other</span>
          <span className="tabular-nums">{detailCost(breakdown.unattributed)}</span>
        </div>
      )}
      {showInFlight && (
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">in progress</span>
          <span className="tabular-nums">{detailCost(inFlightUsd)}</span>
        </div>
      )}
      <div className="flex justify-between gap-4 border-t border-border/60 pt-1">
        <span className="text-muted-foreground">total</span>
        <span className="tabular-nums">{detailCost(breakdown.billed + inFlightUsd)}</span>
      </div>
      {/* Every model that cost money, not every agent the user picked: the CLI
          bills its own auxiliary calls (a small model summarizing a tool result,
          say) to the same chat, and those are spend like any other. */}
      {breakdown.models.length > 1 && (
        <>
          <div className="font-sans text-[10px] uppercase tracking-wider text-muted-foreground pt-1">
            Models
          </div>
          {breakdown.models.map((entry) => (
            <div key={`${entry.provider}:${entry.model}`} className="flex justify-between gap-4">
              <span className="text-muted-foreground">
                {findChatModel(entry.model)?.name ?? entry.model}
              </span>
              <span className="tabular-nums">{detailCost(entry.costUsd)}</span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

// Where the composer's turn clock stands. While `running`, `startedAt` is when
// the turn began on the browser's own clock, or null for a turn whose start
// nobody knows (a pointer a restarted server left behind, which a client only
// ever sees for the instant it takes to settle), which shows as working but with
// no figure to put on it. Once it settles, `lastMs` holds what that turn took,
// and is null on a chat with no turn worth reporting.
export interface TurnClock {
  running: boolean;
  startedAt: number | null;
  lastMs: number | null;
}

// Milliseconds between repaints of a running turn's age. It is shown to the
// second, so this is the coarsest tick that never leaves a stale figure on
// screen. Unaligned to the second boundary on purpose: the displayed second can
// trail the true one by up to a tick, which nobody watching a turn can tell, and
// aligning would cost a timer reset on every tick.
const TURN_TICK_MS = 1000;

// Milliseconds since `startedAt`, repainting while it is non-null. Re-reads the
// clock when a turn begins so the first frame counts from the new start rather
// than from whenever this component last happened to tick.
function useElapsed(startedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), TURN_TICK_MS);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  return startedAt === null ? 0 : now - startedAt;
}

// Whether the turn clock has anything to put on screen. The separator between
// this readout and the cost depends on the answer, so it is decided once here
// rather than inferred again by whoever draws the separator.
function hasTurnFigure({ running, lastMs }: TurnClock): boolean {
  return running || lastMs !== null;
}

// Whether the agent is working, and how long the turn has taken. Sits beside the
// running cost in the composer's bottom row, because "is it still going" and
// "what is it costing me" are one glance. A running turn spins and counts up. A
// settled one swaps the spinner for a tick and holds the final figure, so the
// last turn's duration is still there to read while the next message is typed. A
// chat between turns with nothing to report renders nothing rather than a zero.
//
// Type comes from the ComposerStatus cluster below rather than being set here, so
// this and the cost figure share one strut and their digits sit on the same
// baseline. Sized on its own the 12px text made a 16px line box next to the
// cost's inherited 24px one, and the two readouts landed a pixel apart.
export function TurnStatus({ running, startedAt, lastMs }: TurnClock) {
  const elapsed = useElapsed(running ? startedAt : null);
  const ms = running ? (startedAt === null ? null : elapsed) : lastMs;
  if (!hasTurnFigure({ running, startedAt, lastMs })) return null;
  const shown = ms == null ? null : formatDuration(ms);
  const label = running
    ? shown === null
      ? "Working"
      : `Working, ${shown} so far`
    : `Last turn took ${shown}`;
  return (
    <span
      className="flex select-none items-center gap-1 px-1"
      title={label}
      aria-label={label}
      // Deliberately not a live region: the label above is read when focus
      // reaches the composer's send corner, and announcing a count-up once a
      // second would talk over everything else.
    >
      {running ? (
        <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden />
      ) : (
        <Check className="size-3 shrink-0 text-muted-foreground/70" aria-hidden />
      )}
      {shown}
    </span>
  );
}

// The composer's send corner: how the turn is going, then what the chat has
// spent. One readout in one type, separated the way the rest of the app separates
// quiet metadata on a line, because two mono figures set side by side with only a
// gap between them read as two unrelated numbers competing for the corner rather
// than as one status line. The type is set once here so both figures share a
// strut and sit on the same baseline, and each figure carries its own inset so
// the separator is evenly spaced between them.
export function ComposerStatus({
  turn,
  costUsd,
  loadBreakdown,
}: {
  turn: TurnClock;
  costUsd?: number;
  loadBreakdown?: () => Promise<ChatCostBreakdown>;
}) {
  return (
    <span className="flex items-center font-mono text-xs tabular-nums text-muted-foreground">
      <TurnStatus running={turn.running} startedAt={turn.startedAt} lastMs={turn.lastMs} />
      {hasTurnFigure(turn) && <span className="text-muted-foreground/50">·</span>}
      <ChatCost costUsd={costUsd} loadBreakdown={loadBreakdown} />
    </span>
  );
}

// The chat's running total cost, sitting in the composer's bottom row. Each
// usage event nudges it up and it counts its way there rather than jumping, so
// spend reads as something accruing while the agent works. A chat that has yet
// to spend anything reads "$0.00", so the figure is part of the composer from
// the first message rather than appearing partway through.
// Always cents, never more: this is an ambient figure, and a digit count that
// changed with the magnitude would make the text jitter as it counts. Sub-cent
// spend therefore rounds, and hovering gives the itemized version.
export function ChatCost({
  costUsd,
  loadBreakdown,
}: {
  costUsd?: number;
  loadBreakdown?: () => Promise<ChatCostBreakdown>;
}) {
  const shown = useCountUp(costUsd ?? 0);
  const [detail, setDetail] = useState<ChatCostBreakdown | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Read on open rather than pushed with every usage frame: the split is
  // derived data, and putting it on the stream would persist a copy of it into
  // the chat's event log on every token update for something nobody is looking
  // at most of the time. Re-read on each open so it is current when read.
  const request = useRef(0);
  const onOpenChange = (open: boolean) => {
    if (!open || !loadBreakdown) return;
    const generation = ++request.current;
    setError(null);
    void (async () => {
      try {
        const next = await loadBreakdown();
        // A card closed and reopened while a read was in flight must not be
        // filled in by the read it no longer wants.
        if (request.current === generation) setDetail(next);
      } catch (err) {
        if (request.current !== generation) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  };

  const total = (
    <span className="select-none font-mono text-xs tabular-nums">{`$${shown.toFixed(2)}`}</span>
  );
  if (!loadBreakdown) return <span className="px-1 text-muted-foreground">{total}</span>;
  return (
    <HoverCard openDelay={150} closeDelay={80} onOpenChange={onOpenChange}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          className="cursor-default rounded px-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          aria-label="What this chat has cost so far, across every agent it has run on"
        >
          {total}
        </button>
      </HoverCardTrigger>
      <HoverCardContent align="end">
        {detail ? (
          // Whatever the composer is showing beyond the settled bill belongs to
          // the turn in flight. Derived here rather than plumbed through,
          // because these are the two numbers that have to agree.
          <CostBreakdownDetail
            breakdown={detail}
            inFlightUsd={Math.max(0, (costUsd ?? 0) - detail.billed)}
          />
        ) : (
          <div className="font-mono text-[10px] text-muted-foreground">
            {error ? `Cost breakdown: ${error}` : "Loading cost breakdown…"}
          </div>
        )}
      </HoverCardContent>
    </HoverCard>
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
