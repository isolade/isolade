import { memo, useRef } from "react";
import { retainMarkdownCache } from "@/lib/markdown-cache";
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
  /**
   * Stable identity for this piece of content, normally the message id plus a
   * discriminator. Given one, the parse is kept outside the component tree and
   * survives unmounting, so a row can be dropped and remounted without redoing
   * it. Without one the parse lives and dies with the component, which is only
   * right for content that has no identity to key by (a live turn before it
   * commits).
   */
  cacheKey?: string;
}

/** Proper live Markdown whose parser-derived sealed blocks retain identity. */
export const StreamingMarkdown = memo(function StreamingMarkdown({
  content,
  streaming = false,
  cache,
  cacheKey,
}: StreamingMarkdownProps) {
  const localCacheRef = useRef<StreamingMarkdownCache | null>(null);
  if (!localCacheRef.current) localCacheRef.current = new StreamingMarkdownCache();
  // A streaming turn keeps its parser local: it has no settled identity yet,
  // and its content changes every frame, so there is nothing to reuse later.
  const keyed = cacheKey !== undefined && !streaming ? retainMarkdownCache(cacheKey) : null;
  const model = (cache ?? keyed ?? localCacheRef.current).update(content, streaming, streaming);

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
