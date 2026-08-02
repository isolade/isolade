import { CopyButton } from "@/components/CopyButton";
import { cn } from "@/lib/utils";

// The copy affordance under a message, sized and revealed like the edit pencil
// next to it: invisible until its row is hovered or the button is focused, so
// a transcript at rest stays quiet. Which hover reveals it is the caller's to
// say, because an assistant turn can contain user bubbles: each row names its
// own group (`group/message`, `group/turn`) and passes the matching variant,
// so hovering a turn doesn't light up the steering messages inside it.
//
// Deliberately not marked `data-chat-action`: copying reads the transcript
// rather than changing it, so it stays live while a turn is running, when
// everything that would edit the chat is not.
export function MessageCopyButton({ text, className }: { text: string; className?: string }) {
  return (
    <CopyButton
      text={text}
      label="Copy message"
      className={cn(
        "flex h-6 w-6 items-center justify-center rounded opacity-0 focus-visible:opacity-100",
        className,
      )}
      iconClassName="h-3.5 w-3.5"
    />
  );
}
