// The composer bar's usage surfaces: whether the agent is working and for how
// long, the running chat cost, the context meter beside them, and the token and
// cost breakdowns each of those opens on hover. Data comes from Chat.tsx's UsageState
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
import type { TokenUsage, UsageState } from "./chunks";

// How full the model's context is, and against what. The denominator prefers
// the provider-reported value (codex sends it on every usage update) and falls
// back to the catalog entry. The numerator is the most recent turn's input,
// cached input and cache writes: every part of the prompt that was packed into
// the model, however each part was billed. Output is left out, being what came
// back rather than what was sent. It is the most faithful "context pressure"
// signal we can show without tokenizing every block ourselves.
interface ContextFill {
  used: number;
  window?: number;
  /** Percent of the window filled, or null when no window is known. */
  pct: number | null;
}

function contextFill(usage: UsageState, catalogWindow?: number): ContextFill {
  const window = usage.modelContextWindow ?? catalogWindow;
  const used =
    usage.last.inputTokens + usage.last.cachedInputTokens + usage.last.cacheCreationInputTokens;
  return { used, window, pct: window ? Math.min(100, (used / window) * 100) : null };
}

// What a chat that has not run a turn has put in the model: nothing. Stands in
// for the usage snapshot a chat has yet to receive, so the meter can read an
// honest zero from the moment the chat opens rather than waiting for the first
// usage event to exist at all.
const NO_TOKENS: TokenUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
};
const EMPTY_USAGE: UsageState = { last: NO_TOKENS, total: NO_TOKENS };

// The session state a context probe's answer belongs to. What is holding the
// context only moves when the model is sent something or the thread is
// compacted, so two opens that agree on this key would get the same answer back,
// and the second one is not worth asking for: the probe reaches into the VM and
// resumes the CLI process (spawning one if the session has since been let go) to
// produce it.
//
// A turn in flight is a key of its own rather than the figures underneath it,
// which tick with every usage event the turn streams: the server declines to
// probe a running turn, and being told so once per turn is enough.
export function contextProbeKey(usage: UsageState | null, running?: boolean): string {
  if (running) return "running";
  const { last, total, compacted } = usage ?? EMPTY_USAGE;
  return [
    last.inputTokens,
    last.cachedInputTokens,
    last.cacheCreationInputTokens,
    total.totalTokens,
    compacted ? 1 : 0,
  ].join(":");
}

// Rich token breakdown, shown when the composer's context meter is hovered.
// Tokens only: what the chat has cost lives in the cost card next to it, so
// each figure in the composer opens the detail for itself rather than both
// opening most of the same card.
export function ContextDetail({
  usage,
  catalogWindow,
}: {
  usage: UsageState;
  catalogWindow?: number;
}) {
  const { used: usedNow, window, pct } = contextFill(usage, catalogWindow);
  // A chat between its first message and its first usage event has a window and
  // nothing in it. Saying so is the point of the card being open, but the turn
  // and total rows would just be a column of zeros, so they wait for a turn.
  const ran = usedNow > 0 || usage.total.totalTokens > 0;
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
      {ran ? (
        <>
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
        </>
      ) : (
        <div className="text-[10px] text-muted-foreground">Nothing sent to the model yet.</div>
      )}
    </div>
  );
}

// Per-category breakdown from Claude's structured `get_context_usage`
// response. Anthropic-only. Codex chats render the unavailable hint. Each row
// mirrors a category reported by the live CLI process. Read when the meter's
// card opens, so `breakdown` and `error` both being empty means the read is
// still in flight. Reopening the card retries a failed read.
export function ContextBreakdownDetail({
  breakdown,
  error,
}: {
  breakdown: ContextBreakdown | null;
  error: string | null;
}) {
  if (!breakdown) {
    return (
      <div className="font-mono text-[10px] text-muted-foreground">
        {error ? `Context breakdown: ${error}` : "Loading context breakdown…"}
      </div>
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

// Where the meter stops being quiet metadata and starts being a warning. The
// same two thresholds the pressure bar under the model name used before it.
const CONTEXT_WARN_PCT = 75;
const CONTEXT_DANGER_PCT = 90;

// The arc's geometry, in the units of its viewBox. Radius and stroke are set so
// the ring's outer edge lands exactly on the box, leaving no padding to align
// away when the meter sits beside type.
const RING_R = 8;
const RING_C = 2 * Math.PI * RING_R;

// The fill, drawn as a ring. Both arcs take their color from the text around
// them, so the meter warms with the rest of the chip rather than being colored
// twice, and the track is the same color held back to a hint of itself.
function ContextRing({ pct }: { pct: number }) {
  return (
    <svg viewBox="0 0 20 20" className="size-3.5 shrink-0 -rotate-90" aria-hidden>
      <circle
        cx="10"
        cy="10"
        r={RING_R}
        fill="none"
        strokeWidth="4"
        className="stroke-current opacity-20"
      />
      <circle
        cx="10"
        cy="10"
        r={RING_R}
        fill="none"
        strokeWidth="4"
        strokeDasharray={`${(pct / 100) * RING_C} ${RING_C}`}
        className="stroke-current transition-[stroke-dasharray] duration-200"
      />
    </svg>
  );
}

// How full the context is, as a ring and a percentage, at the end of the
// composer's left cluster. It reads as a share rather than as a token count
// because that is the question being asked of it ("how much room is left"), and
// because the same 420k is comfortable on one model and nearly full on another,
// so a percentage survives a model switch where a raw figure would have to be
// re-read against a new denominator. The tokens themselves, and what is holding
// them, are one hover away.
//
// It sits with the model rather than in the send corner because the window it
// measures is the model's: switching models moves this number.
export function ContextMeter({
  usage,
  catalogWindow,
  running,
  loadBreakdown,
}: {
  usage: UsageState | null;
  catalogWindow?: number;
  /** Whether a turn is in flight, which the probe cannot see past. */
  running?: boolean;
  loadBreakdown?: () => Promise<ContextBreakdown>;
}) {
  const [breakdown, setBreakdown] = useState<ContextBreakdown | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Read on open, like the cost card beside it: the categories come from the
  // live CLI process, so they are only worth asking for when someone is looking.
  // Unlike the cost card, the read is not cheap (it resumes, and can spawn, a
  // CLI process inside the VM to ask), so what came back is kept and reused
  // until the session it describes has moved on. `readAt` is the probe key that
  // produced what is in state, and null when nothing usable is.
  const request = useRef(0);
  const readAt = useRef<string | null>(null);
  // Any turn that ran leaves the context changed, so a settled one drops what
  // the last probe returned. The figures in the key normally say so by
  // themselves, but a turn stopped before it reported any usage still put a
  // message into the session while leaving every figure where it was.
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) readAt.current = null;
    wasRunning.current = running;
  }, [running]);
  const onOpenChange = (open: boolean) => {
    if (!open || !loadBreakdown) return;
    const key = contextProbeKey(usage, running);
    if (readAt.current === key) return;
    const generation = ++request.current;
    setBreakdown(null);
    setError(null);
    void (async () => {
      try {
        const next = await loadBreakdown();
        // A card closed and reopened while a read was in flight must not be
        // filled in by the read it no longer wants.
        if (request.current !== generation) return;
        setBreakdown(next);
        readAt.current = key;
      } catch (err) {
        if (request.current !== generation) return;
        setError(err instanceof Error ? err.message : String(err));
        // A failed read is not worth keeping. Most of them are a VM that was
        // busy or waking, so the next hover should try again rather than show
        // the same message until the next turn.
        readAt.current = null;
      }
    })();
  };

  // A chat that has yet to run a turn reads 0%, so the meter is part of the
  // composer from the moment the chat opens rather than appearing partway
  // through, the same way the cost beside it starts at $0.00. An empty context
  // is empty whatever the window, so this holds even before a window is known,
  // which is what a codex chat looks like until its first usage event (the
  // catalog leaves those windows to the provider to report). Once something has
  // been sent, though, a share of an unknown denominator is not a fact, and a
  // ring nobody can read says less than no ring at all.
  const fill = contextFill(usage ?? EMPTY_USAGE, catalogWindow);
  const pct = fill.used === 0 ? 0 : fill.pct;
  if (pct === null) return null;
  // A prompt that exists but rounds to nothing still reads as 1%: on a
  // million-token window an opening turn is a rounding error, and rounding it
  // away would leave the meter reading empty on a chat that is under way. An
  // empty context is the one thing that may read 0%.
  const shown = fill.used === 0 ? 0 : Math.max(1, Math.round(pct));
  const label = `Context ${shown}% full${
    fill.window ? `, ${formatTokens(fill.used)} of ${formatTokens(fill.window)} tokens` : ""
  }`;
  return (
    <HoverCard openDelay={150} closeDelay={80} onOpenChange={onOpenChange}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex h-8 shrink-0 cursor-default items-center gap-1 rounded-md px-1.5 font-mono text-xs tabular-nums focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
            pct >= CONTEXT_DANGER_PCT
              ? "text-red-500"
              : pct >= CONTEXT_WARN_PCT
                ? "text-amber-500"
                : "text-muted-foreground hover:text-foreground",
          )}
          aria-label={label}
          data-demo="context-meter"
        >
          <ContextRing pct={pct} />
          <span className="select-none">{shown}%</span>
        </button>
      </HoverCardTrigger>
      <HoverCardContent side="top" align="start" className="space-y-2">
        <ContextDetail usage={usage ?? EMPTY_USAGE} catalogWindow={catalogWindow} />
        {loadBreakdown && <ContextBreakdownDetail breakdown={breakdown} error={error} />}
      </HoverCardContent>
    </HoverCard>
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

// Whether the turn clock has anything to put on screen.
function hasTurnFigure({ running, lastMs }: TurnClock): boolean {
  return running || lastMs !== null;
}

// Whether the agent is working, and how long the turn has taken. The composer's
// send corner, and the only thing in it: it is the one readout that is about
// right now rather than about the chat, so it sits where you look when you are
// waiting, while what the chat is made of and what it has cost stay together on
// the left. A running turn spins and counts up. A settled one swaps the spinner
// for a tick and holds the final figure, so the last turn's duration is still
// there to read while the next message is typed. A chat between turns with
// nothing to report renders nothing rather than a zero.
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
      // Sets its own type now that it stands alone. The 12px figure in a 24px
      // line box is what keeps it on the send button's centre line.
      className="flex h-8 select-none items-center gap-1 px-1 font-mono text-xs tabular-nums text-muted-foreground"
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

// The chat's running total cost, between the model picker and the context meter
// on the left of the composer's bottom row. It is a fact about the chat rather
// than about the moment, which is what it has in common with the model it ran on
// and the context it filled, and what the turn clock in the send corner does not
// share.
// Each usage event nudges it up and it counts its way there rather than jumping,
// so spend reads as something accruing while the agent works. A chat that has yet
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

  // Struck to the same height and inset as the context meter next to it, so the
  // two figures on the left of the row sit on one line and present the same
  // target however each of them is hovered.
  const total = (
    <span className="select-none font-mono text-xs tabular-nums">{`$${shown.toFixed(2)}`}</span>
  );
  if (!loadBreakdown) {
    return <span className="flex h-8 items-center px-1.5 text-muted-foreground">{total}</span>;
  }
  return (
    <HoverCard openDelay={150} closeDelay={80} onOpenChange={onOpenChange}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          className="flex h-8 shrink-0 cursor-default items-center rounded-md px-1.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          aria-label="What this chat has cost so far, across every agent it has run on"
        >
          {total}
        </button>
      </HoverCardTrigger>
      <HoverCardContent side="top" align="start">
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
