import { ArrowUp, Loader2, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface MessageBoxProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop?: () => void;
  disabled?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  loading?: boolean;
  leftToolbar?: React.ReactNode;
  rightToolbar?: React.ReactNode;
  className?: string;
}

// Two layouts share the same composer:
// - "compact" (flex row): the textarea shares a single line with the model
//   picker and the send button. The cursor lives to the left of the controls.
// - "expanded" (flex column): the textarea spans the full width with the
//   controls dropped to a row below. Triggered as soon as the typed text
//   needs more than one line at the compact-mode width.
//
// We only auto-collapse back to compact when the value goes empty. At the
// wider expanded width the same text that overflowed compact often fits on
// one line again, so re-evaluating on each keystroke would flicker between
// the two layouts.
export function MessageBox({
  value,
  onChange,
  onSubmit,
  onStop,
  disabled,
  placeholder,
  autoFocus,
  loading,
  leftToolbar,
  rightToolbar,
  className,
}: MessageBoxProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;

    // Manual auto-grow: reset to 0 to read the natural scrollHeight at the
    // current width, then clamp to a sane max. `field-sizing: content` would
    // be neater but browsers (Safari notably) ignore max-height when it's on.
    const maxHeight = Math.min(window.innerHeight * 0.6, 640);
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;

    if (!value) {
      setExpanded(false);
      return;
    }
    if (expanded) return;
    if (value.includes("\n")) {
      setExpanded(true);
      return;
    }
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 20;
    if (el.scrollHeight > lineHeight * 1.5) setExpanded(true);
  }, [value, expanded]);

  // `loading` blocks submission but leaves the textarea editable, so the user
  // can compose the next message while the agent is still streaming.
  const canSubmit = !disabled && !loading && value.trim().length > 0;
  // While loading, the trailing button swaps from Send → Stop and acts as an
  // interrupt for the in-flight turn. We only show Stop when the parent
  // wired an `onStop` handler. Without it the button falls back to a
  // disabled spinner the way it always behaved.
  const showStop = loading && !!onStop;

  const handleSubmit = () => {
    if (!canSubmit) return;
    onSubmit();
    // Keep focus on the composer after submit. Enter already keeps focus on
    // the textarea, but clicking the send button moves it to the button.
    textareaRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div
      className={cn(
        "border border-input bg-background shadow-xs transition-colors focus-within:border-ring/60 dark:bg-input/30 py-2 pr-2",
        expanded ? "rounded-2xl pl-3" : "rounded-full pl-4",
        className,
      )}
    >
      <div className={cn("flex gap-2", expanded ? "flex-col" : "items-center")}>
        <textarea
          ref={textareaRef}
          autoFocus={autoFocus}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          placeholder={placeholder}
          disabled={disabled}
          className={cn(
            "resize-none bg-transparent py-1 text-base leading-relaxed outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
            expanded ? "w-full" : "flex-1 min-w-0",
          )}
        />
        <div className={cn("flex items-center gap-1 flex-shrink-0", expanded && "self-end")}>
          {leftToolbar}
          {rightToolbar}
          {showStop ? (
            <Button
              type="button"
              size="icon"
              variant="default"
              className="size-8 rounded-full"
              onClick={onStop}
              aria-label="Stop"
            >
              <Square className="size-3 fill-current" />
            </Button>
          ) : (
            <Button
              type="button"
              size="icon"
              variant="default"
              className="size-8 rounded-full"
              disabled={!canSubmit}
              onClick={handleSubmit}
              aria-label="Send"
            >
              {loading ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <ArrowUp className="size-4" />
              )}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
