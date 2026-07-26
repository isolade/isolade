import { ArrowUp, Paperclip, Square } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
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
  // Right-hand controls (the model/effort picker), sitting just left of the
  // send button on the bottom row.
  leftToolbar?: React.ReactNode;
  rightToolbar?: React.ReactNode;
  // Opens the file picker. When provided, the paperclip button is shown on the
  // bottom-left of the composer.
  onAttachClick?: () => void;
  // Preview strip for staged attachments, rendered between the textarea and the
  // control row. Owned by the parent (it holds the attachment state).
  attachments?: React.ReactNode;
  // Forwarded to the textarea so the parent can intercept pasted images.
  onPaste?: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  // Send is allowed on attachments alone (empty text), so the parent tells us
  // when there's something to send beyond the trimmed textarea value.
  hasAttachments?: boolean;
  className?: string;
}

function resizeTextarea(el: HTMLTextAreaElement) {
  const styles = window.getComputedStyle(el);
  const lineHeight = Number.parseFloat(styles.lineHeight);
  const fontSize = Number.parseFloat(styles.fontSize);
  const renderedLineHeight = Number.isFinite(lineHeight)
    ? lineHeight
    : (Number.isFinite(fontSize) ? fontSize : 16) * 1.2;
  const verticalPadding =
    Number.parseFloat(styles.paddingTop) + Number.parseFloat(styles.paddingBottom);
  const verticalBorder =
    Number.parseFloat(styles.borderTopWidth) + Number.parseFloat(styles.borderBottomWidth);
  const firstLineHeight = renderedLineHeight + verticalPadding + verticalBorder;
  const maxHeight = Math.max(firstLineHeight, Math.min(window.innerHeight * 0.6, 640));

  // scrollHeight is the natural content height at the textarea's current
  // width. It includes padding but excludes borders, while the inline height
  // uses the app-wide border-box sizing.
  el.style.height = "0px";
  const contentHeight = el.scrollHeight + verticalBorder;
  el.style.height = `${Math.ceil(Math.max(firstLineHeight, Math.min(contentHeight, maxHeight)))}px`;
}

// The composer is a single column: the textarea on top, an optional attachment
// preview strip, then a control row with the attach button on the left and the
// model picker + send button on the right. (It used to collapse onto one line
// with the controls while short; that inline mode is gone so the layout is
// stable regardless of how much has been typed.)
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
  onAttachClick,
  attachments,
  onPaste,
  hasAttachments,
  className,
}: MessageBoxProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Size before paint so drafts never flash at the previous value's height.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    resizeTextarea(el);
  }, [value]);

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;

    // Wrapping changes when a docked panel is resized even if the draft does
    // not. Observe the border-box width only, avoiding a feedback cycle when
    // resizeTextarea changes the element's height.
    let width = el.offsetWidth;
    let resizeFrame: number | null = null;
    const observer = new ResizeObserver(() => {
      const nextWidth = el.offsetWidth;
      if (nextWidth === width) return;
      width = nextWidth;
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      // ResizeObserver runs before paint. Mutating the observed element in its
      // callback can leave a second notification undelivered, so resize on the
      // next frame instead.
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = null;
        resizeTextarea(el);
      });
    });
    observer.observe(el);

    const resizeForViewport = () => resizeTextarea(el);
    window.addEventListener("resize", resizeForViewport);

    // A late font load can alter both line height and wrapping without changing
    // the textarea's border-box.
    let active = true;
    void document.fonts?.ready.then(() => {
      if (active) resizeTextarea(el);
    });

    return () => {
      active = false;
      observer.disconnect();
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      window.removeEventListener("resize", resizeForViewport);
    };
  }, []);

  // While a turn is active, Send adds to the durable queue. Stop remains a
  // separate control beside it.
  const canSubmit = !disabled && (value.trim().length > 0 || !!hasAttachments);
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
        "flex flex-col gap-2 rounded-2xl border border-input bg-background px-3 py-2 shadow-xs focus-within:border-ring/60 dark:bg-input/30",
        className,
      )}
    >
      <textarea
        ref={textareaRef}
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={onPaste}
        rows={1}
        placeholder={placeholder}
        disabled={disabled}
        className="w-full resize-none bg-transparent py-1 text-base leading-relaxed outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 md:text-sm"
      />
      {attachments}
      <div className="flex items-center gap-1">
        {onAttachClick && (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-8 rounded-full text-muted-foreground"
            onClick={onAttachClick}
            disabled={disabled}
            aria-label="Attach files"
          >
            <Paperclip className="size-4" />
          </Button>
        )}
        <div className="ml-auto flex items-center gap-1">
          {leftToolbar}
          {rightToolbar}
          {showStop && (
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
          )}
          <Button
            type="button"
            size="icon"
            variant="default"
            className="size-8 rounded-full"
            disabled={!canSubmit}
            onClick={handleSubmit}
            aria-label={loading ? "Queue message" : "Send"}
          >
            <ArrowUp className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
