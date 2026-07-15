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
