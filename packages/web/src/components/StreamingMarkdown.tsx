import { memo, useRef } from "react";
import { type MarkdownFragment, StreamingMarkdownCache } from "@/lib/streaming-markdown";
import Markdown from "./Markdown";

const MarkdownFragmentView = memo(
  function MarkdownFragmentView({
    fragment,
    first,
    last,
  }: {
    fragment: MarkdownFragment;
    first: boolean;
    last: boolean;
  }) {
    // A layout box here changes CommonMark's adjacent-margin behavior.
    // `display: contents` preserves canonical document flow while the keyed
    // React boundary still retains sealed parser fragments.
    return (
      <div
        className="markdown-fragment"
        data-markdown-fragment={fragment.key}
        data-first-fragment={first ? "true" : "false"}
        data-last-fragment={last ? "true" : "false"}
        style={{ display: "contents" }}
      >
        <Markdown content={fragment.content} />
      </div>
    );
  },
  (previous, next) =>
    previous.fragment === next.fragment &&
    previous.first === next.first &&
    previous.last === next.last,
);

export interface StreamingMarkdownProps {
  content: string;
  streaming?: boolean;
  /** Exposed for session ownership and deterministic work-count tests. */
  cache?: StreamingMarkdownCache;
}

/** Proper live Markdown whose parser-derived sealed blocks retain identity. */
export const StreamingMarkdown = memo(function StreamingMarkdown({
  content,
  streaming = false,
  cache,
}: StreamingMarkdownProps) {
  const localCacheRef = useRef<StreamingMarkdownCache | null>(null);
  if (!localCacheRef.current) localCacheRef.current = new StreamingMarkdownCache();
  const model = (cache ?? localCacheRef.current).update(content, streaming, streaming);

  return (
    <>
      {model.fragments.map((fragment, index) => (
        <MarkdownFragmentView
          key={fragment.key}
          fragment={fragment}
          first={index === 0}
          last={index === model.fragments.length - 1}
        />
      ))}
    </>
  );
});

export default StreamingMarkdown;
