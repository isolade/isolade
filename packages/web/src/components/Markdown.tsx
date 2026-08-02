import { Check, Copy, ImageOff } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { createContext, memo, useContext, useEffect, useMemo, useRef, useState } from "react";
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

/** What became of a markdown image the assistant wrote. */
export type ResolvedMarkdownImage =
  | { status: "ready"; href: string }
  | { status: "failed"; reason: "missing" | "not-an-image" | "unreadable" | "unreachable" };

// Said in the transcript, where the reader has no reason to know what the
// capture step is or that it exists. Each names what is wrong with the file
// rather than what the code did about it.
//
// `none` is the odd one out: it means no capture was even attempted for this
// reference, which is what a message written before this feature existed looks
// like, and equally what a server that is not running it looks like. Spelled
// out rather than left blank so the three states (worked, failed for a reason,
// never tried) are never confusable on screen.
const IMAGE_FAILURES = {
  missing: "file not found",
  "not-an-image": "not an image",
  unreadable: "could not be read",
  unreachable: "could not be fetched",
  none: "not captured",
} as const;

/**
 * Turns a `![](…)` into something renderable, or null when nothing backs it.
 *
 * An assistant's images are paths inside a VM the browser cannot reach, so they
 * are snapshotted host-side as the reply is written and looked up here (see
 * server/agent-images.ts). Takes the offset as well as the destination because
 * one path can be shown more than once in a reply, each time with whatever
 * bytes were there at that moment, and position is what tells those apart.
 *
 * The offset is relative to whatever content the nearest provider scoped, so
 * every layer between the message and a single parsed fragment rebases it (see
 * MarkdownImageOffset). Absent this context an `<img>` renders the way it always
 * has, which is what user messages and every other call site want.
 */
export type MarkdownImageResolver = (
  source: string,
  offset: number,
) => ResolvedMarkdownImage | null;

export const MarkdownImageContext = createContext<MarkdownImageResolver | null>(null);

/**
 * Rebase a resolver onto a nested piece of the same text.
 *
 * The message's snapshots are recorded against offsets into the whole reply,
 * while a node's own position is relative to the one fragment remark parsed. A
 * provider at each level adds back what it sits at, so the two meet.
 */
export const MarkdownImageOffset = memo(function MarkdownImageOffset({
  delta,
  children,
}: {
  delta: number;
  children: ReactNode;
}) {
  const parent = useContext(MarkdownImageContext);
  const shifted = useMemo(
    () =>
      parent === null || delta === 0
        ? parent
        : (source: string, offset: number) => parent(source, offset + delta),
    [parent, delta],
  );
  return <MarkdownImageContext.Provider value={shifted}>{children}</MarkdownImageContext.Provider>;
});

function hasUriScheme(source: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(source) || source.startsWith("//");
}

// An image reference with no picture behind it: one pointing outside the
// machine, one whose file could not be captured, or one nothing ever tried to
// capture. Better than a browser's broken-image glyph, because the alt text is
// usually the agent describing what you were meant to be looking at.
//
// `reason` always says something, including when nothing was tried, so a chip
// can never leave you guessing which of those happened.
function UnresolvedImage({
  source,
  alt,
  reason,
}: {
  source: string;
  alt: string;
  reason: keyof typeof IMAGE_FAILURES;
}) {
  const remote = hasUriScheme(source);
  return (
    <span className="my-2 inline-flex max-w-full items-center gap-2 rounded-md border border-border bg-muted/40 px-2 py-1.5 text-xs text-muted-foreground">
      <ImageOff className="size-3.5 shrink-0" />
      {alt && <span className="truncate">{alt}</span>}
      {remote ? (
        <a
          href={source}
          target="_blank"
          rel="noopener noreferrer"
          className="truncate text-link hover:underline"
          onClick={(e) => onExternalLinkClick(e, source)}
        >
          {source}
        </a>
      ) : (
        <span className="truncate font-mono opacity-70">{source}</span>
      )}
      <span className="shrink-0 opacity-70">({IMAGE_FAILURES[reason]})</span>
    </span>
  );
}

// The picture at full size, over everything else. Radix handles the parts that
// are easy to get wrong: escape to close, scroll lock, focus trapped while open
// and returned to the thumbnail after. The content layer covers the viewport
// rather than sitting inside the overlay, so a click anywhere dismisses it,
// including on the image itself.
function ImageLightbox({
  open,
  onOpenChange,
  href,
  alt,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  href: string;
  alt: string;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/80" />
        <DialogPrimitive.Content
          className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center p-6 outline-none"
          onClick={() => onOpenChange(false)}
          aria-describedby={undefined}
        >
          {/* Radix requires a title. The caption is the agent's own description
              of the picture, which is exactly what a screen reader wants. */}
          <DialogPrimitive.Title className="sr-only">{alt || "Image"}</DialogPrimitive.Title>
          {/* The grid shrink-wraps the picture rather than the picture being
              fitted into the grid, so it shows through transparent pixels and
              nowhere else. An opaque image simply covers it. */}
          <div className="image-checkerboard">
            <img src={href} alt={alt} className="max-h-[92vh] max-w-[92vw]" />
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

// A markdown image. Only ever loads bytes the resolver vouched for: a remote
// URL in an assistant's reply is shown as a link rather than fetched, so a
// message composed inside a sandboxed VM cannot make the app call out to a host
// of the agent's choosing just by being displayed.
function ImageRenderer({ src, alt, title, node }: ComponentProps<"img"> & { node?: unknown }) {
  const resolve = useContext(MarkdownImageContext);
  const [zoomed, setZoomed] = useState(false);
  const source = typeof src === "string" ? src : "";
  const caption = alt ?? "";
  if (!resolve) return <img src={src} alt={caption} title={title} className="max-w-full" />;
  // Where this image sits in the fragment remark parsed, which the providers
  // above have rebased onto the whole reply.
  const offset = (node as HastNode | undefined)?.position?.start?.offset ?? 0;
  const resolved = source ? resolve(source, offset) : null;
  if (resolved?.status !== "ready") {
    return <UnresolvedImage source={source} alt={caption} reason={resolved?.reason ?? "none"} />;
  }
  return (
    <>
      {/* Block and width-fit so `mx-auto` has something to centre. Preflight
          already makes the image itself a block (see the note on sizing), so
          the button is only here to own the click and the centring. */}
      <button
        type="button"
        title={title ?? alt}
        onClick={() => setZoomed(true)}
        className="mx-auto my-2 block w-fit cursor-zoom-in"
      >
        <img src={resolved.href} alt={caption} className="max-h-96 max-w-full rounded-md" />
      </button>
      <ImageLightbox open={zoomed} onOpenChange={setZoomed} href={resolved.href} alt={caption} />
    </>
  );
}

// Minimal structural hast type so we don't depend on @types/hast directly.
type HastNode = {
  type?: string;
  tagName?: string;
  value?: string;
  children?: HastNode[];
  properties?: { className?: unknown };
  position?: { start?: { offset?: number } };
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
      className="text-muted-foreground hover:text-foreground"
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
  img: ImageRenderer,
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
      <tbody className="[&_tr]:border-t [&_tr]:border-border [&_tr:nth-child(even)]:bg-muted/30 [&_tr:hover]:bg-muted/50">
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
