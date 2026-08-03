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
  // Holds back the send while leaving the composer usable: the draft can still
  // be typed, pasted into and attached to, it just has nowhere to go yet (the
  // chosen model's provider is signed out). Unlike `disabled`, which turns the
  // whole composer off, so a draft written before the reason appeared isn't
  // stranded.
  sendDisabled?: boolean;
  // Why, as the send button's tooltip. The composer's layout never changes for
  // it: the state belongs to the model, so what says it is the model picker
  // (which flags the model and offers both fixes), and this is the same sentence
  // where the blocked click lands.
  sendDisabledReason?: string;
  // An overlay across the composer, centered, for when nothing inside it can be
  // used: no provider is signed in, so there is no model, no draft worth typing
  // and no send. The composer stays where it is and shows through, so what is
  // unavailable is still legible; the overlay takes the clicks and `disabled`
  // (pass it too) takes the keyboard.
  cover?: React.ReactNode;
  placeholder?: string;
  autoFocus?: boolean;
  loading?: boolean;
  // The model/effort picker. Named for its content rather than its position on
  // purpose: this component decides where the bottom row's pieces sit, so every
  // composer in the app lays out identically instead of each caller choosing.
  modelPicker?: React.ReactNode;
  // Whether the chat runs at the provider's premium speed. Sits against the
  // picker, being a setting of the model rather than a figure about the chat.
  fastMode?: React.ReactNode;
  // How full the model's context is. Sits with the picker, because the window it
  // measures is a property of the model chosen there.
  context?: React.ReactNode;
  // What the chat has cost. Sits with the model and the context, the other two
  // facts about the conversation rather than about the moment.
  cost?: React.ReactNode;
  // Read-only status for the send corner: whether a turn is running and how long
  // it has taken.
  status?: React.ReactNode;
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

// The one composer in the app: the new-chat draft box and every chat pane render
// this, so they stay identical. A single column of the textarea, an optional
// attachment preview strip, then a control row with the attach button and what
// the chat is (model, how fast it runs, cost, context) on the left, and how the
// turn is going plus the send/stop button on the right. (It used to collapse
// onto one line with the controls while short. That inline mode is gone so the
// layout is stable regardless of how much has been typed.)
export function MessageBox({
  value,
  onChange,
  onSubmit,
  onStop,
  disabled,
  sendDisabled,
  sendDisabledReason,
  cover,
  placeholder,
  autoFocus,
  loading,
  modelPicker,
  fastMode,
  context,
  cost,
  status,
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
      // Zero width means the pane's rendering is skipped while it is off
      // screen. Re-fitting against that would only have to be undone on reveal.
      if (nextWidth === 0 || nextWidth === width) return;
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

  // The bottom-right corner only ever holds one button. While a turn is active
  // it stops the turn, unless there is something to send: then it turns into
  // Send again, which adds the draft to the durable queue.
  const canSubmit = !disabled && !sendDisabled && (value.trim().length > 0 || !!hasAttachments);
  const showStop = loading && !!onStop && !canSubmit;

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
        // Covered, the overlay and the composer share one grid cell rather than
        // the overlay being positioned on top of it. Same picture, except the
        // cell takes the taller of the two, so the box is never shorter than the
        // composer and never too short for the message either: a narrow docked
        // pane wraps the message onto three lines, which an absolutely
        // positioned overlay would have spilled out of the box.
        cover && "grid",
        className,
      )}
    >
      {/* The overlay sits across the composer rather than in place of it: the
          composer it explains stays visible underneath, so what is unavailable
          reads as the familiar box, dimmed. The negative margins pull the scrim
          out over the box's own padding (they cancel this element's padding, so
          the grid cell still sizes to the message), which is what lets it reach
          the rounded border instead of stopping short of it. */}
      {cover && (
        <div className="z-10 col-start-1 row-start-1 -mx-3 -my-2 flex flex-wrap items-center justify-center gap-x-2 gap-y-1.5 rounded-2xl bg-background/75 px-4 py-2 text-center backdrop-blur-[1px] dark:bg-background/65">
          {cover}
        </div>
      )}
      <div className="col-start-1 row-start-1 flex min-w-0 flex-col gap-2">
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
        <div className="flex min-w-0 items-center gap-1">
          {onAttachClick && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-8 shrink-0 rounded-full text-muted-foreground"
              onClick={onAttachClick}
              disabled={disabled}
              aria-label="Attach files"
            >
              <Paperclip className="size-4" />
            </Button>
          )}
          {/* What the chat is: the model, what it has cost, how full its context
            is. The model name is what gives way when a docked panel gets narrow
            enough that the row cannot hold everything: it truncates (the picker
            shrinks inside this box) while the figures and the send button keep
            their size. Without a shrinkable slot here the row grew past the
            composer's rounded border and pushed the send button outside it. The
            figures share the slot but not the shrinking: a percentage or an
            amount half elided says nothing. Spaced on the same gap as the row
            around it: each piece carries its own inset for its hover target, and
            those alone left the four of them reading as one crowded run. */}
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
            {modelPicker}
            {fastMode}
            {cost}
            {context}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {status}
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
              // The reason rides a wrapper, not the button: a disabled button
              // takes `pointer-events: none` from the button base, so a `title`
              // on it would never be hovered and never shown. The wrapper still
              // gets the pointer, so the explanation reaches the one place the
              // blocked click lands.
              <span className="inline-flex" title={sendDisabled ? sendDisabledReason : undefined}>
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
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
