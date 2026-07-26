import { Wrench, X, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { QueuedMessage } from "@/lib/contracts";

// Transcript polling may race the POST that created an optimistic queue row.
// Preserve rows owned by this browser until the transcript proves they were
// promoted into the conversation or a local action removes them.
export function reconcileQueuedMessageSnapshot(
  local: QueuedMessage[],
  server: QueuedMessage[],
  protectedIds: ReadonlySet<string>,
): QueuedMessage[] {
  const serverIds = new Set(server.map((message) => message.id));
  return [
    ...server,
    ...local.filter((message) => protectedIds.has(message.id) && !serverIds.has(message.id)),
  ];
}

export function QueuedMessages({
  messages,
  notice,
  canRetractSteering,
  onRemove,
  onDispatch,
}: {
  messages: QueuedMessage[];
  notice?: string | null;
  canRetractSteering: boolean;
  onRemove: (id: string) => void;
  onDispatch: (id: string, mode: "next" | "now") => void;
}) {
  if (messages.length === 0 && !notice) return null;
  return (
    <div className="mb-2 flex flex-col gap-1.5" aria-label="Queued messages">
      {notice && (
        <div
          role="status"
          className="rounded-xl border bg-background/95 px-3 py-2 text-xs text-muted-foreground shadow-xs"
        >
          {notice}
        </div>
      )}
      {messages.map((message) => {
        const busy = message.status === "steering" || message.status === "interrupting";
        const deliveryIssue = message.status === "unknown" || message.status === "rejected";
        const providerOwned =
          message.mode === "next" &&
          (message.status === "steering" ||
            message.status === "unknown" ||
            message.status === "delivered");
        const canRemove =
          message.status !== "interrupting" && (!providerOwned || canRetractSteering);
        return (
          <div
            key={message.id}
            className="flex items-center gap-2 rounded-xl border bg-background/95 px-3 py-2 text-sm shadow-xs"
          >
            <div className="min-w-0 flex-1">
              <div className="truncate">{message.content || "Attachment"}</div>
              <div
                className={
                  deliveryIssue ? "text-xs text-destructive" : "text-xs text-muted-foreground"
                }
              >
                {message.status === "queued"
                  ? "Queued"
                  : message.status === "interrupting"
                    ? "Interrupting current turn"
                    : message.status === "steering"
                      ? message.mode === "next"
                        ? "Waiting for next tool boundary"
                        : "Interrupting current turn"
                      : message.status === "unknown"
                        ? "Message may not have been sent"
                        : "Message was not sent"}
              </div>
            </div>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-7"
              disabled={busy}
              onClick={() => onDispatch(message.id, "next")}
              aria-label="Send after current tool"
              title="Send after current tool"
            >
              <Wrench className="size-3.5" />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-7"
              disabled={busy}
              onClick={() => onDispatch(message.id, "now")}
              aria-label="Send now"
              title="Send now"
            >
              <Zap className="size-3.5" />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-7"
              disabled={!canRemove}
              onClick={() => onRemove(message.id)}
              aria-label="Remove from queue"
              title={canRemove ? "Remove from queue" : "This message is already committed"}
            >
              <X className="size-3.5" />
            </Button>
          </div>
        );
      })}
    </div>
  );
}
