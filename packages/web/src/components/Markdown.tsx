import { Check, Copy } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { createContext, memo, useContext, useEffect, useRef, useState } from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { highlightCode } from "@/lib/highlight";
import { RENDER_METRICS_ENABLED, recordRenderMetric } from "@/lib/render-metrics";
import { onExternalLinkClick } from "../lib/tauri";

// True while rendering inside a fenced code block's <pre>. react-markdown
// gives the `code` renderer no parent information, so without this context
// it can't reliably tell fenced blocks from inline code, so newline sniffing
// misclassifies single-line fences, and untagged fences have no language
// class to key off.
const PreContext = createContext(false);

// Minimal structural hast type so we don't depend on @types/hast directly.
type HastNode = {
  type?: string;
  tagName?: string;
  value?: string;
  children?: HastNode[];
  properties?: { className?: unknown };
};

// Raw text of a hast subtree. Keep the recursive walk so the copy payload does
// not depend on how react-markdown represents a future nested code child.
function hastText(node: HastNode | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(hastText).join("");
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    },
    [],
  );
  const Icon = copied ? Check : Copy;
  return (
    <button
      type="button"
      aria-label="Copy code"
      onClick={() => {
        navigator.clipboard
          .writeText(text)
          .then(() => {
            setCopied(true);
            if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
            resetTimer.current = window.setTimeout(() => setCopied(false), 1500);
          })
          .catch((err: unknown) => {
            console.warn("[markdown] clipboard write failed:", err);
          });
      }}
      className="text-muted-foreground hover:text-foreground transition-colors"
    >
      <Icon className="h-3 w-3" />
    </button>
  );
}

// Fenced code block: memoized lowlight output with a copy button floating in
// the top-right corner. Replaces react-markdown's default <pre> so we
// don't end up with our card div nested inside a <pre>. The button sits
// outside the overflow wrapper so it stays put when the code scrolls
// horizontally. The translucent backdrop keeps it legible when a long
// first line runs underneath it.
function PreBlock({ node, children }: { node?: unknown; children?: ReactNode }) {
  const hast = node as HastNode | undefined;
  // Fenced code carries a trailing newline in the AST, so strip it so the
  // copied text matches what's displayed.
  const text = hastText(hast).replace(/\n$/, "");
  return (
    <div className="relative my-2 rounded-md bg-muted/40 border border-border">
      <div className="absolute top-1 right-1 rounded p-1 bg-background/80 backdrop-blur-sm">
        <CopyButton text={text} />
      </div>
      <div className="overflow-x-auto">
        <pre className="px-3 py-2 text-xs leading-relaxed">
          <PreContext.Provider value={true}>{children}</PreContext.Provider>
        </pre>
      </div>
    </div>
  );
}

const CodeRenderer = memo(function CodeRenderer({
  className,
  children,
  ...props
}: ComponentProps<"code"> & { node?: unknown }) {
  delete props.node;
  const inPre = useContext(PreContext);
  if (inPre) {
    const text = typeof children === "string" ? children : String(children ?? "");
    const language = className?.match(/(?:^|\s)language-([^\s]+)/)?.[1] ?? null;
    const highlighted = language ? highlightCode(text, language) : text;
    const codeClassName = [className, language ? "hljs" : null].filter(Boolean).join(" ");
    if (language && RENDER_METRICS_ENABLED) recordRenderMetric("codeHighlightRuns");
    return (
      <code className={codeClassName || undefined} {...props}>
        {highlighted}
      </code>
    );
  }
  return (
    <code className="px-1 py-0.5 rounded bg-muted text-foreground text-xs" {...props}>
      {children}
    </code>
  );
}, codePropsEqual);

function codePropsEqual(
  previous: ComponentProps<"code"> & { node?: unknown },
  next: ComponentProps<"code"> & { node?: unknown },
): boolean {
  return previous.className === next.className && previous.children === next.children;
}

const Paragraph = memo(
  function Paragraph({ children }: { children?: ReactNode }) {
    return <p className="mb-2 last:mb-0 leading-relaxed">{children}</p>;
  },
  (previous, next) => previous.children === next.children,
);

const components: Components = {
  pre: PreBlock,
  code: CodeRenderer,
  // Block elements
  p: Paragraph,
  // `pl-6` (not the tighter `pl-4`) so the outside list markers have room to
  // sit inside the padding. With less padding a disc or a multi-digit number
  // overhangs to the left of the list box and gets clipped whenever the list
  // is flush against a clipping ancestor (the chat scroll area, or the
  // overflow-hidden wrappers around collapsible tool/thinking blocks).
  ul({ children }) {
    return <ul className="mb-2 last:mb-0 pl-6 list-disc space-y-1">{children}</ul>;
  },
  ol({ children }) {
    return <ol className="mb-2 last:mb-0 pl-6 list-decimal space-y-1">{children}</ol>;
  },
  li({ children }) {
    return <li className="leading-relaxed">{children}</li>;
  },
  h1({ children }) {
    return <h1 className="text-lg font-semibold mb-2 mt-3 first:mt-0">{children}</h1>;
  },
  h2({ children }) {
    return <h2 className="text-base font-semibold mb-2 mt-3 first:mt-0">{children}</h2>;
  },
  h3({ children }) {
    return <h3 className="text-sm font-semibold mb-1 mt-2 first:mt-0">{children}</h3>;
  },
  blockquote({ children }) {
    return (
      <blockquote className="border-l-2 border-border pl-3 my-2 text-muted-foreground italic">
        {children}
      </blockquote>
    );
  },
  a({ href, children }) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-link hover:underline"
        onClick={(e) => onExternalLinkClick(e, href)}
      >
        {children}
      </a>
    );
  },
  hr() {
    return <hr className="my-3 border-border" />;
  },
  // GitHub-style table: a rounded, clipped frame instead of a full cell grid.
  // The frame's overflow clips the inner square corners to the radius, and the
  // only rules are a header band plus horizontal row dividers with zebra
  // striping, which is lighter and more legible than bordering every cell.
  //
  // Two layers handle width. The outer `-mr-12` cancels the assistant column's
  // `pr-12` gutter (see Chat.tsx), making the *available* width the full inner
  // chat container. The inner frame is `w-fit`, so it hugs the table's natural
  // width rather than stretching, so a small table stays small. The table itself
  // is `width:auto` (shrink-to-fit), so it grows toward the full width only as
  // its content needs, wraps cells once it hits that ceiling, and finally
  // `overflow-x-auto` scrolls when even that can't contain it.
  table({ children }) {
    return (
      <div className="my-3 -mr-12">
        <div className="w-fit max-w-full overflow-x-auto rounded-md border border-border">
          <table className="border-collapse text-xs">{children}</table>
        </div>
      </div>
    );
  },
  thead({ children }) {
    return <thead className="border-b border-border bg-muted/60">{children}</thead>;
  },
  tbody({ children }) {
    return (
      <tbody className="[&_tr]:border-t [&_tr]:border-border [&_tr:nth-child(even)]:bg-muted/30 [&_tr:hover]:bg-muted/50 [&_tr]:transition-colors">
        {children}
      </tbody>
    );
  },
  // Spread the remaining props so GFM column alignment (passed as an inline
  // `text-align` style) survives. `text-left` is just the default it overrides.
  th({ children, ...props }: ComponentProps<"th"> & { node?: unknown }) {
    delete props.node;
    return (
      <th className="px-3 py-2 text-left font-semibold whitespace-nowrap" {...props}>
        {children}
      </th>
    );
  },
  td({ children, ...props }: ComponentProps<"td"> & { node?: unknown }) {
    delete props.node;
    return (
      <td className="px-3 py-1.5 align-top" {...props}>
        {children}
      </td>
    );
  },
};

interface MarkdownProps {
  content: string;
}

function Markdown({ content }: MarkdownProps) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={components}>
      {content}
    </ReactMarkdown>
  );
}

// Memoize to avoid re-parsing unchanged messages in the history list.
// Streaming content changes every render, so memo won't help there,
// but it prevents re-rendering all previous messages on each delta.
export default memo(Markdown);
