export const metricNames = [
  "apiRequests",
  "codeHighlightRuns",
  "contentResizeNotifications",
  "domMutations",
  "historicalRowRenders",
  "historyMappings",
  "markdownInputBytes",
  "markdownRenders",
  "parserInputBytes",
  "previewInputBytes",
] as const;

export type MetricName = (typeof metricNames)[number];
export type MetricSnapshot = Record<MetricName, number>;

export interface RenderMetrics {
  increment: (name: MetricName, amount?: number) => void;
  reset: () => void;
  snapshot: () => MetricSnapshot;
}

function emptySnapshot(): MetricSnapshot {
  return {
    apiRequests: 0,
    codeHighlightRuns: 0,
    contentResizeNotifications: 0,
    domMutations: 0,
    historicalRowRenders: 0,
    historyMappings: 0,
    markdownInputBytes: 0,
    markdownRenders: 0,
    parserInputBytes: 0,
    previewInputBytes: 0,
  };
}

export function getRenderMetrics(): RenderMetrics {
  const existing = window.__isoladeRenderMetrics;
  if (existing) return existing;

  let values = emptySnapshot();
  const metrics: RenderMetrics = {
    increment(name, amount = 1) {
      values[name] += amount;
    },
    reset() {
      values = emptySnapshot();
    },
    snapshot() {
      return { ...values };
    },
  };
  window.__isoladeRenderMetrics = metrics;
  return metrics;
}

declare global {
  interface Window {
    __isoladeRenderMetrics?: RenderMetrics;
  }
}
