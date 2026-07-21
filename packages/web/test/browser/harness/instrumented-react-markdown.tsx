import type { ComponentProps } from "react";
import ActualReactMarkdown from "react-markdown-uninstrumented";
import { getRenderMetrics } from "./metrics";

export default function InstrumentedReactMarkdown(
  props: ComponentProps<typeof ActualReactMarkdown>,
) {
  const metrics = getRenderMetrics();
  metrics.increment("markdownRenders");
  if (typeof props.children === "string") {
    metrics.increment("markdownInputBytes", new TextEncoder().encode(props.children).byteLength);
  }
  return <ActualReactMarkdown {...props} />;
}
