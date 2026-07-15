import { type ReactNode, useLayoutEffect, useRef } from "react";
import { highlightCode } from "@/lib/highlight";
import { cn } from "@/lib/utils";

// A lightweight syntax-highlighting code editor: a transparent <textarea> layered
// over a highlighted <pre>, kept in lockstep by identical typography and mirrored
// scrolling. No CodeMirror/Monaco. This reuses the shared lowlight engine and
// the `.hljs-*` token CSS already in the app, which is plenty for editing a
// Dockerfile or a raw config file.
//
// The textarea and pre MUST share font, size, line-height, padding and
// whitespace handling or the caret drifts from the rendered glyphs. The classes
// below are deliberately identical on both.
const SHARED = "m-0 whitespace-pre p-3 font-mono text-xs leading-5 tracking-normal";

export function CodeEditor({
  value,
  onChange,
  language,
  placeholder,
  readOnly = false,
  className,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  language: string;
  placeholder?: ReactNode;
  readOnly?: boolean;
  className?: string;
  ariaLabel?: string;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);

  // Mirror the textarea's scroll onto the highlight layer. Done in a layout
  // effect too so a value change (which can shift scroll) stays aligned.
  const syncScroll = () => {
    const ta = textareaRef.current;
    const pre = preRef.current;
    if (!ta || !pre) return;
    pre.scrollTop = ta.scrollTop;
    pre.scrollLeft = ta.scrollLeft;
  };
  useLayoutEffect(syncScroll, [value]);

  // Tab inserts two spaces at the caret rather than moving focus.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Tab" || readOnly) return;
    e.preventDefault();
    const ta = e.currentTarget;
    const { selectionStart, selectionEnd } = ta;
    const next = `${value.slice(0, selectionStart)}  ${value.slice(selectionEnd)}`;
    onChange(next);
    requestAnimationFrame(() => {
      ta.selectionStart = ta.selectionEnd = selectionStart + 2;
    });
  };

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-md border border-input bg-input/30 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50",
        className,
      )}
    >
      <pre
        ref={preRef}
        aria-hidden
        className={cn(
          SHARED,
          "pointer-events-none absolute inset-0 overflow-hidden text-foreground",
        )}
      >
        <code>
          {highlightCode(value, language)}
          {"\n"}
        </code>
      </pre>
      {value === "" && placeholder !== undefined && (
        <div className={cn(SHARED, "pointer-events-none absolute inset-0 text-muted-foreground")}>
          {placeholder}
        </div>
      )}
      <textarea
        ref={textareaRef}
        value={value}
        aria-label={ariaLabel}
        readOnly={readOnly}
        onChange={(e) => onChange(e.target.value)}
        onScroll={syncScroll}
        onKeyDown={handleKeyDown}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        wrap="off"
        className={cn(
          SHARED,
          "absolute inset-0 h-full w-full resize-none overflow-auto bg-transparent text-transparent caret-foreground outline-none",
        )}
      />
    </div>
  );
}
