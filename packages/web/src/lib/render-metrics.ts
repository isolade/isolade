export type RenderMetricName =
  | "codeHighlightRuns"
  | "historicalRowRenders"
  | "historyMappings"
  | "markdownInputBytes"
  | "parserInputBytes"
  | "previewInputBytes";

export const RENDER_METRICS_ENABLED = false;

/** Replaced by the browser harness. Production builds compile this branch away. */
export function recordRenderMetric(_name: RenderMetricName, _amount = 1): void {}
