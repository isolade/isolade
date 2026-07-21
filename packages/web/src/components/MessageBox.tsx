import { ArrowUp, Loader2, Paperclip, Square } from "lucide-react";
import { useEffect, useRef } from "react";
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

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    // Manual auto-grow: reset to 0 to read the natural scrollHeight at the
    // current width, then clamp to a sane max. `field-sizing: content` would
    // be neater but browsers (Safari notably) ignore max-height when it's on.
    const maxHeight = Math.min(window.innerHeight * 0.6, 640);
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, [value]);

  // `loading` blocks submission but leaves the textarea editable, so the user
  // can compose the next message while the agent is still streaming. Sending is
  // allowed with empty text as long as there's at least one attachment.
  const canSubmit = !disabled && !loading && (value.trim().length > 0 || !!hasAttachments);
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
        "flex flex-col gap-2 rounded-2xl border border-input bg-background px-3 py-2 shadow-xs transition-colors focus-within:border-ring/60 dark:bg-input/30",
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
