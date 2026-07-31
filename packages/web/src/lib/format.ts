// Shared display formatters for the usage surfaces (UsageTab, UsageHeatmap,
// and the composer-bar UsagePanel). Kept in one place so the three views agree
// on how a token count or a dollar amount reads.

// Compact token count: raw below 1k, then k/M/B with a decimal only while the
// leading number is small enough that the extra digit still carries meaning
// (e.g. "9.4k" but "12k", "1.23M", "4.20B").
export function formatTokens(n: number): string {
  if (n < 1000) return n.toFixed(0);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}

// Dollar amount with precision that grows as the figure shrinks, so sub-cent
// spend stays legible instead of collapsing to "$0.00".
export function formatCost(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

// How long a turn has taken, sized for the composer's status line: whole
// seconds under a minute ("42s"), then a stopwatch reading ("7:03", "1:12:40")
// so an hour-long turn stays about as narrow as a short one. Seconds are the
// finest granularity because this counts up in front of the reader, and a
// tenths digit spinning next to the cost would be noise. Sub-second and
// negative figures (a clock nudged backwards mid-turn) read as "0s".
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const seconds = String(total % 60).padStart(2, "0");
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  if (hours === 0) return `${minutes}:${seconds}`;
  return `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`;
}
