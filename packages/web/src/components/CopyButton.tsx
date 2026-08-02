import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

// A button that puts `text` on the clipboard and says so by swapping its icon
// for a tick. Shared by the code-block corner and the chat's message rows, so
// copying feels the same wherever it is offered. Callers style the button and
// its icon; the confirmation and its timer live here.
export function CopyButton({
  text,
  label,
  className,
  iconClassName,
}: {
  text: string;
  label: string;
  className?: string;
  iconClassName?: string;
}) {
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
      aria-label={label}
      onClick={() => {
        void copyText(text).then((ok) => {
          if (!ok) return;
          setCopied(true);
          if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
          resetTimer.current = window.setTimeout(() => setCopied(false), 1500);
        });
      }}
      className={cn("text-muted-foreground hover:text-foreground", className)}
    >
      <Icon className={cn("h-3 w-3", iconClassName)} />
    </button>
  );
}
