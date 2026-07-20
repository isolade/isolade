import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remend from "remend";
import { unified } from "unified";
import { RENDER_METRICS_ENABLED, recordRenderMetric } from "@/lib/render-metrics";

type PositionedNode = {
  type: string;
  children?: PositionedNode[];
  position?: {
    start: { offset?: number };
    end: { offset?: number };
  };
};

const GLOBAL_NODE_TYPES = new Set([
  "definition",
  "linkReference",
  "imageReference",
  "footnoteDefinition",
  "footnoteReference",
]);

const markdownParser = unified().use(remarkParse).use(remarkGfm);
const encoder = new TextEncoder();

const REMEND_OPTIONS = {
  // Link and image completion is deliberately handled below. Remend treats
  // every unmatched `[` as a link, which corrupts ordinary text such as
  // `array[0` while it streams.
  links: false,
  images: false,
  // Keep this preview transform narrowly scoped to Markdown presentation.
  comparisonOperators: false,
  htmlTags: false,
  setextHeadings: false,
  singleTilde: false,
  katex: false,
  inlineKatex: false,
} as const;

export interface StreamingMarkdownMetrics {
  blockParseCalls: number;
  blockParseBytes: number;
  scheduledFragmentRenders: number;
  scheduledMarkdownBytes: number;
  previewInputBytes: number;
}

export function createStreamingMarkdownMetrics(): StreamingMarkdownMetrics {
  return {
    blockParseCalls: 0,
    blockParseBytes: 0,
    scheduledFragmentRenders: 0,
    scheduledMarkdownBytes: 0,
    previewInputBytes: 0,
  };
}

export interface MarkdownFragment {
  readonly key: string;
  readonly type: string;
  readonly content: string;
  /** Offset in the canonical source. Display completion only changes the tail. */
  readonly start: number;
}

export interface StreamingMarkdownModel {
  readonly source: string;
  readonly displaySource: string;
  readonly fragments: readonly MarkdownFragment[];
  readonly referenceSensitive: boolean;
  readonly streaming: boolean;
}

type FragmentSpec = Omit<MarkdownFragment, "key">;

type IncompleteLink = {
  start: number;
  label: string;
};

function utf8Bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

function walk(node: PositionedNode, visit: (node: PositionedNode) => boolean | void): boolean {
  if (visit(node)) return true;
  for (const child of node.children ?? []) {
    if (walk(child, visit)) return true;
  }
  return false;
}

function hasGlobalDependency(root: PositionedNode): boolean {
  return walk(root, (node) => GLOBAL_NODE_TYPES.has(node.type));
}

function findIncompleteLink(source: string): IncompleteLink | null {
  // This intentionally accepts only the unambiguous `[label](` form at the
  // end of the stream. An unmatched `[` remains exactly as written.
  const labelEnd = source.lastIndexOf("](");
  if (labelEnd < 0) return null;
  const labelStart = source.lastIndexOf("[", labelEnd);
  if (labelStart < 0) return null;
  let openLabels = 0;
  for (let index = 0; index < labelEnd; index += 1) {
    if (source[index - 1] === "\\") continue;
    if (source[index] === "[") openLabels += 1;
    if (source[index] === "]" && openLabels > 0) openLabels -= 1;
  }
  if (openLabels !== 1) return null;
  const label = source.slice(labelStart + 1, labelEnd);
  const target = source.slice(labelEnd + 2);
  if (!label || label.includes("[") || label.includes("]")) return null;
  if (target.includes(")") || target.includes("\n")) return null;
  const previous = source[labelStart - 1];
  if (previous === "!" || previous === "\\") return null;
  return { start: labelStart, label };
}

function isInsideCode(root: PositionedNode, offset: number): boolean {
  return walk(root, (node) => {
    if (node.type !== "code" && node.type !== "inlineCode") return false;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    return start !== undefined && end !== undefined && offset >= start && offset < end;
  });
}

function specsFromRoot(
  root: PositionedNode,
  displaySource: string,
  baseOffset: number,
): FragmentSpec[] {
  const specs: FragmentSpec[] = [];
  for (const node of root.children ?? []) {
    const localStart = node.position?.start.offset;
    const localEnd = node.position?.end.offset;
    if (localStart === undefined || localEnd === undefined) continue;
    specs.push({
      type: node.type,
      content: displaySource.slice(baseOffset + localStart, baseOffset + localEnd),
      start: baseOffset + localStart,
    });
  }
  return specs;
}

/**
 * Retains parser-derived Markdown blocks across append-only streaming updates.
 *
 * Remark always decides block boundaries. Once a block is followed by another
 * top-level block, only the final block can change under ordinary CommonMark
 * appends, so updates parse that final block plus the appended source. Global
 * definitions and references intentionally fall back to a full-document block.
 */
export class StreamingMarkdownCache {
  private model: StreamingMarkdownModel = {
    source: "",
    displaySource: "",
    fragments: [],
    referenceSensitive: false,
    streaming: false,
  };
  private nextKey = 0;

  constructor(private readonly metrics?: StreamingMarkdownMetrics) {}

  current(): StreamingMarkdownModel {
    return this.model;
  }

  update(source: string, streaming: boolean, knownAppendOnly = false): StreamingMarkdownModel {
    if (source === this.model.source && streaming === this.model.streaming) return this.model;

    // Live text chunks are append-only by reducer contract. Accept that fact
    // from the caller so every token does not rescan the entire accumulated
    // string merely to prove it is still a prefix. Non-live callers retain the
    // defensive comparison, and any shrink always forces a full parse.
    const appendOnly =
      source.length >= this.model.source.length &&
      (knownAppendOnly || source.startsWith(this.model.source));
    const canParseSuffix =
      appendOnly && !this.model.referenceSensitive && this.model.fragments.length > 0;
    const reparseStart = canParseSuffix ? (this.model.fragments.at(-1)?.start ?? 0) : 0;
    const retained = canParseSuffix ? this.model.fragments.slice(0, -1) : [];

    const canonicalPrefix = source.slice(0, reparseStart);
    const canonicalSuffix = source.slice(reparseStart);
    const incompleteLink = streaming ? findIncompleteLink(canonicalSuffix) : null;
    const baseDisplay = streaming
      ? canonicalPrefix + this.completeDisplaySource(canonicalSuffix)
      : source;
    let displaySource = baseDisplay;

    // Once a definition/reference has made the text segment globally
    // dependent, append-only updates must remain one canonical Markdown
    // document. We already know that structural fact, so avoid running our
    // boundary parser over the whole accumulated source again. ReactMarkdown
    // still performs the one canonical parse needed to render it. An
    // incomplete link needs the AST-based code exclusion below, so it keeps
    // the full path.
    if (appendOnly && this.model.referenceSensitive && !incompleteLink) {
      const fragment = this.makeFragment(
        { type: "document", content: displaySource, start: 0 },
        this.model.fragments[0]?.key,
      );
      this.model = {
        source,
        displaySource,
        fragments: displaySource ? [fragment] : [],
        referenceSensitive: true,
        streaming,
      };
      return this.model;
    }

    let parsed = this.parse(baseDisplay.slice(reparseStart));

    if (incompleteLink) {
      if (!isInsideCode(parsed, incompleteLink.start)) {
        const textOnlySuffix = `${canonicalSuffix.slice(0, incompleteLink.start)}${incompleteLink.label}`;
        displaySource = canonicalPrefix + this.completeDisplaySource(textOnlySuffix);
        parsed = this.parse(displaySource.slice(reparseStart));
      }
    }

    if (hasGlobalDependency(parsed)) {
      // A definition in the active suffix can change references in already
      // sealed blocks, so discard the suffix optimization immediately.
      if (reparseStart !== 0) parsed = this.parse(displaySource);
      const fragment = this.makeFragment(
        {
          type: "document",
          content: displaySource,
          start: 0,
        },
        this.model.fragments[0]?.key,
      );
      this.model = {
        source,
        displaySource,
        fragments: displaySource ? [fragment] : [],
        referenceSensitive: true,
        streaming,
      };
      return this.model;
    }

    const suffixSpecs = specsFromRoot(parsed, displaySource, reparseStart);
    const nextFragments = canParseSuffix
      ? this.reconcileSuffix(retained, suffixSpecs)
      : this.reconcileFull(suffixSpecs);
    this.model = {
      source,
      displaySource,
      fragments: nextFragments,
      referenceSensitive: false,
      streaming,
    };
    return this.model;
  }

  private parse(source: string): PositionedNode {
    const needsBytes = Boolean(this.metrics) || RENDER_METRICS_ENABLED;
    const byteLength = needsBytes ? utf8Bytes(source) : 0;
    if (RENDER_METRICS_ENABLED) recordRenderMetric("parserInputBytes", byteLength);
    if (this.metrics) {
      this.metrics.blockParseCalls += 1;
      this.metrics.blockParseBytes += byteLength;
    }
    return markdownParser.parse(source) as PositionedNode;
  }

  private completeDisplaySource(source: string): string {
    const needsBytes = Boolean(this.metrics) || RENDER_METRICS_ENABLED;
    const byteLength = needsBytes ? utf8Bytes(source) : 0;
    if (this.metrics) this.metrics.previewInputBytes += byteLength;
    if (RENDER_METRICS_ENABLED) recordRenderMetric("previewInputBytes", byteLength);
    return remend(source, REMEND_OPTIONS);
  }

  private reconcileSuffix(
    retained: readonly MarkdownFragment[],
    specs: readonly FragmentSpec[],
  ): MarkdownFragment[] {
    const previousTail = this.model.fragments.at(-1);
    const suffix = specs.map((spec, index) => {
      if (index === 0 && previousTail) {
        if (
          previousTail.type === spec.type &&
          previousTail.content === spec.content &&
          previousTail.start === spec.start
        ) {
          return previousTail;
        }
        return this.makeFragment(spec, previousTail.key);
      }
      return this.makeFragment(spec);
    });
    return [...retained, ...suffix];
  }

  private reconcileFull(specs: readonly FragmentSpec[]): MarkdownFragment[] {
    let common = 0;
    while (common < specs.length && common < this.model.fragments.length) {
      const previous = this.model.fragments[common];
      const spec = specs[common];
      if (
        !previous ||
        !spec ||
        previous.type !== spec.type ||
        previous.content !== spec.content ||
        previous.start !== spec.start
      ) {
        break;
      }
      common += 1;
    }

    const next = this.model.fragments.slice(0, common);
    for (let index = common; index < specs.length; index += 1) {
      const spec = specs[index];
      if (!spec) continue;
      next.push(this.makeFragment(spec, this.model.fragments[index]?.key));
    }
    return next;
  }

  private makeFragment(spec: FragmentSpec, key?: string): MarkdownFragment {
    if (this.metrics) {
      this.metrics.scheduledFragmentRenders += 1;
      this.metrics.scheduledMarkdownBytes += utf8Bytes(spec.content);
    }
    return {
      ...spec,
      key: key ?? `markdown-fragment-${this.nextKey++}`,
    };
  }
}
