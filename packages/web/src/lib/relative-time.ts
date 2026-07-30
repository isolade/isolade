import { useEffect, useState } from "react";

// "When did this last move" labels for the chat list, plus the clock that keeps
// them honest. The sidebar rows are memoized on stable props, so a row whose
// data hasn't changed never re-renders on its own: without a ticking clock a
// "3m ago" label would sit there until the next server change touched that row.

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// Compact elapsed-time label, sized for a 10px line in a narrow sidebar: "just
// now" under a minute, then m / h / d, and an absolute date once "6d ago" stops
// being a useful way to say when. Anything in the future (clock skew, a floored
// `now`) reads as "just now" rather than a negative count.
export function formatRelativeTime(at: Date | string | number, now: number): string {
  const then = at instanceof Date ? at : new Date(at);
  const elapsed = now - then.getTime();
  if (Number.isNaN(elapsed)) return "";
  if (elapsed < MINUTE_MS) return "just now";
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}m ago`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)}h ago`;
  if (elapsed < 7 * DAY_MS) return `${Math.floor(elapsed / DAY_MS)}d ago`;
  return then.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    // Only spell out the year once it isn't the current one, so the common case
    // stays as short as "Mar 4".
    year: then.getFullYear() === new Date(now).getFullYear() ? undefined : "numeric",
  });
}

// The full timestamp, for the hover tooltip behind a relative label.
export function formatAbsoluteTime(at: Date | string | number): string {
  const date = at instanceof Date ? at : new Date(at);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

// A clock at the granularity the labels above can actually show a change at:
// one minute. The returned `now` is floored to the minute so it's derived from
// state (stable across re-renders), which costs a label up to a minute of lag
// and buys a list that re-renders once a minute instead of once a tick.
//
// Polled rather than scheduled on the minute boundary, so a throttled or
// suspended tab just catches up on its next tick. Ticks that land in the same
// minute return the previous state, which React bails out of without a render.
export function useMinuteClock(): number {
  const [minute, setMinute] = useState(() => Math.floor(Date.now() / MINUTE_MS));
  useEffect(() => {
    const id = window.setInterval(() => {
      const next = Math.floor(Date.now() / MINUTE_MS);
      setMinute((prev) => (prev === next ? prev : next));
    }, 15_000);
    return () => window.clearInterval(id);
  }, []);
  return minute * MINUTE_MS;
}
