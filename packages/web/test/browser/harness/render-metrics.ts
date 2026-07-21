import { getRenderMetrics, type MetricName } from "./metrics";

export type RenderMetricName = Extract<
  MetricName,
  | "codeHighlightRuns"
  | "historicalRowRenders"
  | "historyMappings"
  | "markdownInputBytes"
  | "parserInputBytes"
  | "previewInputBytes"
>;

export const RENDER_METRICS_ENABLED = true;

export function recordRenderMetric(name: RenderMetricName, amount = 1): void {
  getRenderMetrics().increment(name, amount);
}
