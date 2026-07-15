import { localDay } from "@isolade/shared";
import { useMemo, useState } from "react";
import { formatCost, formatTokens } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { UsageDay } from "../lib/contracts";

// A GitHub-contribution-graph view of recorded usage: one square per day,
// 53 weeks of columns ending today, shaded by how heavy that day was. Two
// metrics are offered: dollar cost (the default, what people watch) and raw
// token throughput, toggled in the header. Days with no recorded usage are
// rendered as empty squares, so gaps read as "didn't use it" rather than
// "no data".

// Geometry, in px. Shared by the grid, the weekday gutter, and the month-label
// row so all three line up exactly (Tailwind's gap-1 would drift from the
// absolutely-positioned month labels, so we drive spacing by these constants).
const CELL = 12;
const GAP = 3;
const STEP = CELL + GAP;
const WEEKS = 53;
const WEEKDAY_GUTTER = 28;

// Classic GitHub light-mode green ramp for levels 1–4. Reads well on both
// light and dark themes. Empty squares fall back to the theme's muted token so
// they recede appropriately per theme.
const LEVEL_COLORS = ["#9be9a8", "#40c463", "#30a14e", "#216e39"] as const;

type Metric = "cost" | "tokens";

interface Cell {
  /** Local "YYYY-MM-DD", or null for padding slots in the trailing week. */
  day: string | null;
  date: Date | null;
  entry: UsageDay | null;
  value: number;
}

function totalTokens(d: UsageDay): number {
  // Throughput proxy for the heatmap. Reasoning tokens are a subset of output
  // for the providers we track, so they're left out here to avoid double
  // counting (they still appear in the tooltip breakdown).
  return d.inputTokens + d.cachedInputTokens + d.cacheCreationInputTokens + d.outputTokens;
}

function metricValue(d: UsageDay, metric: Metric): number {
  return metric === "cost" ? d.costUsd : totalTokens(d);
}

// Local midnight today, the grid's right edge. Stripping the time keeps day
// bucketing stable regardless of when the page is opened.
function startOfToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function addDays(date: Date, n: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + n);
  return next;
}

// Build the week-major grid: WEEKS columns of 7 rows (Sun..Sat), ending on the
// week that contains today. The trailing column is padded with nulls for days
// after today.
function buildWeeks(byDay: Map<string, UsageDay>, metric: Metric): Cell[][] {
  const today = startOfToday();
  // Sunday that starts today's week, then back (WEEKS-1) weeks for the left edge.
  const lastSunday = addDays(today, -today.getDay());
  const start = addDays(lastSunday, -(WEEKS - 1) * 7);

  const weeks: Cell[][] = [];
  for (let w = 0; w < WEEKS; w++) {
    const col: Cell[] = [];
    for (let r = 0; r < 7; r++) {
      const date = addDays(start, w * 7 + r);
      if (date > today) {
        col.push({ day: null, date: null, entry: null, value: 0 });
        continue;
      }
      const key = localDay(date);
      const entry = byDay.get(key) ?? null;
      col.push({
        day: key,
        date,
        entry,
        value: entry ? metricValue(entry, metric) : 0,
      });
    }
    weeks.push(col);
  }
  return weeks;
}

// Quartile thresholds over the *active* days in view (GitHub's approach).
// Anchoring to the distribution rather than the single busiest day is what
// keeps the gradient legible: a lone spike day would otherwise squash every
// ordinary day into the lightest shade, which is exactly the "same color
// everywhere" failure mode. Returns the level-1/2/3 upper bounds; anything
// above the third is level 4.
function computeThresholds(values: number[]): [number, number, number] {
  const active = values.filter((v) => v > 0).toSorted((a, b) => a - b);
  if (active.length === 0) return [0, 0, 0];
  const at = (p: number) => active[Math.min(active.length - 1, Math.floor(p * active.length))] ?? 0;
  return [at(0.25), at(0.5), at(0.75)];
}

// 0 → empty, otherwise 1–4 by which quartile band the value lands in.
function levelFor(value: number, [t1, t2, t3]: [number, number, number]): number {
  if (value <= 0) return 0;
  if (value <= t1) return 1;
  if (value <= t2) return 2;
  if (value <= t3) return 3;
  return 4;
}

function cellColor(level: number): string | undefined {
  return level === 0 ? undefined : LEVEL_COLORS[level - 1];
}

function formatDate(date: Date): string {
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// Month labels sit above the first column in which a new month begins (matching
// GitHub). Returns the column index + short month name for each transition.
function monthLabels(weeks: Cell[][]): { col: number; text: string }[] {
  const labels: { col: number; text: string }[] = [];
  let lastMonth = -1;
  weeks.forEach((col, i) => {
    const first = col.find((c) => c.date)?.date;
    if (!first) return;
    const month = first.getMonth();
    if (month !== lastMonth) {
      // Skip a label that would collide with the previous one (months that
      // span <2 columns at the very start of the range).
      const prev = labels[labels.length - 1];
      if (!prev || i - prev.col >= 2) {
        labels.push({
          col: i,
          text: first.toLocaleDateString(undefined, { month: "short" }),
        });
      }
      lastMonth = month;
    }
  });
  return labels;
}

const WEEKDAY_LABELS = ["", "Mon", "", "Wed", "", "Fri", ""];

export default function UsageHeatmap({ days }: { days: UsageDay[] }) {
  const [metric, setMetric] = useState<Metric>("cost");
  const [hover, setHover] = useState<{
    cell: Cell;
    x: number;
    y: number;
  } | null>(null);

  const byDay = useMemo(() => {
    const map = new Map<string, UsageDay>();
    for (const d of days) map.set(d.day, d);
    return map;
  }, [days]);

  const weeks = useMemo(() => buildWeeks(byDay, metric), [byDay, metric]);
  const thresholds = useMemo(
    () => computeThresholds(weeks.flatMap((col) => col.map((c) => c.value))),
    [weeks],
  );
  const labels = useMemo(() => monthLabels(weeks), [weeks]);

  // Totals across the visible range, for the summary line.
  const { totalCost, totalTok, activeDays } = useMemo(() => {
    let cost = 0;
    let tok = 0;
    let active = 0;
    for (const col of weeks) {
      for (const c of col) {
        if (!c.entry) continue;
        cost += c.entry.costUsd;
        tok += totalTokens(c.entry);
        if (metricValue(c.entry, metric) > 0) active++;
      }
    }
    return { totalCost: cost, totalTok: tok, activeDays: active };
  }, [weeks, metric]);

  const gridWidth = WEEKS * STEP - GAP;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs text-muted-foreground">
          {metric === "cost" ? formatCost(totalCost) : `${formatTokens(totalTok)} tokens`} over the
          last year
          <span className="ml-2 text-muted-foreground/70">· active {activeDays} days</span>
        </div>
        <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
          {(["cost", "tokens"] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={metric === m}
              onClick={() => setMetric(m)}
              className={cn(
                "rounded px-2 py-0.5 text-xs capitalize transition-colors",
                metric === m
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {m}
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto pb-1">
        <div className="inline-flex flex-col gap-1">
          {/* Month labels, absolutely placed above the column where each month starts. */}
          <div className="flex" style={{ paddingLeft: WEEKDAY_GUTTER }}>
            <div className="relative" style={{ width: gridWidth, height: 13 }}>
              {labels.map((l) => (
                <span
                  key={`${l.col}-${l.text}`}
                  className="absolute top-0 text-[10px] leading-none text-muted-foreground"
                  style={{ left: l.col * STEP }}
                >
                  {l.text}
                </span>
              ))}
            </div>
          </div>

          <div className="flex">
            {/* Weekday gutter: Mon/Wed/Fri, aligned to their rows. */}
            <div className="flex flex-col" style={{ width: WEEKDAY_GUTTER, gap: GAP }}>
              {WEEKDAY_LABELS.map((label, i) => (
                <span
                  key={i}
                  className="text-[10px] leading-none text-muted-foreground"
                  style={{ height: CELL, lineHeight: `${CELL}px` }}
                >
                  {label}
                </span>
              ))}
            </div>

            {/* The week columns. */}
            <div className="flex" style={{ gap: GAP }}>
              {weeks.map((col, ci) => (
                <div key={ci} className="flex flex-col" style={{ gap: GAP }}>
                  {col.map((cell, ri) => {
                    if (!cell.day) {
                      return <div key={ri} style={{ width: CELL, height: CELL }} />;
                    }
                    const level = levelFor(cell.value, thresholds);
                    const color = cellColor(level);
                    return (
                      <div
                        key={ri}
                        className={cn(
                          "rounded-[2px] ring-1 ring-inset ring-black/[0.06] transition-colors",
                          color ? "" : "bg-muted",
                        )}
                        style={{
                          width: CELL,
                          height: CELL,
                          ...(color ? { backgroundColor: color } : {}),
                        }}
                        onMouseEnter={(e) => setHover({ cell, x: e.clientX, y: e.clientY })}
                        onMouseMove={(e) => setHover({ cell, x: e.clientX, y: e.clientY })}
                        onMouseLeave={() => setHover(null)}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>

          {/* Legend. */}
          <div className="flex items-center gap-1.5 self-end pt-1 text-[10px] text-muted-foreground">
            <span>Less</span>
            <div className="h-3 w-3 rounded-[2px] bg-muted ring-1 ring-inset ring-black/[0.06]" />
            {LEVEL_COLORS.map((c) => (
              <div
                key={c}
                className="h-3 w-3 rounded-[2px] ring-1 ring-inset ring-black/[0.06]"
                style={{ backgroundColor: c }}
              />
            ))}
            <span>More</span>
          </div>
        </div>
      </div>

      {/* Floating tooltip, position: fixed so it escapes the scroll container's
          clipping and follows the hovered square. */}
      {hover?.cell.date && (
        <div
          className="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-full rounded-md bg-foreground px-2.5 py-1.5 text-xs text-background shadow-md"
          style={{ left: hover.x, top: hover.y - 8 }}
        >
          <div className="font-medium">
            {hover.cell.entry
              ? metric === "cost"
                ? `${formatCost(hover.cell.entry.costUsd)} spent`
                : `${formatTokens(totalTokens(hover.cell.entry))} tokens`
              : "No usage"}
          </div>
          <div className="text-background/70">{formatDate(hover.cell.date)}</div>
          {hover.cell.entry && (
            <div className="mt-1 space-y-0.5 text-background/70">
              {metric === "cost" ? (
                <>
                  {hover.cell.entry.anthropicCostUsd > 0 && (
                    <div className="flex justify-between gap-3">
                      <span>Anthropic</span>
                      <span className="font-mono tabular-nums">
                        {formatCost(hover.cell.entry.anthropicCostUsd)}
                      </span>
                    </div>
                  )}
                  {hover.cell.entry.openaiCostUsd > 0 && (
                    <div className="flex justify-between gap-3">
                      <span>OpenAI</span>
                      <span className="font-mono tabular-nums">
                        {formatCost(hover.cell.entry.openaiCostUsd)}
                      </span>
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div className="flex justify-between gap-3">
                    <span>input</span>
                    <span className="font-mono tabular-nums">
                      {formatTokens(hover.cell.entry.inputTokens)}
                    </span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span>output</span>
                    <span className="font-mono tabular-nums">
                      {formatTokens(hover.cell.entry.outputTokens)}
                    </span>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
