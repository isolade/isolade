import { AlertCircle, FileIcon, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PendingAttachment } from "../../lib/use-attachments";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// The composer's staged-attachment strip: image thumbnails and file chips, each
// removable, with an uploading spinner / error badge overlaid while the
// background upload runs.
export function AttachmentStrip({
  items,
  onRemove,
}: {
  items: PendingAttachment[];
  onRemove: (localId: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 px-1">
      {items.map((it) => {
        const isImage = it.mediaType.startsWith("image/") && it.previewUrl;
        return (
          <div
            key={it.localId}
            className={cn(
              "group relative flex items-center gap-2 rounded-lg border border-border bg-muted/40 text-xs",
              isImage ? "p-0" : "px-2 py-1.5 pr-7",
            )}
          >
            {isImage ? (
              <img
                src={it.previewUrl}
                alt={it.filename}
                className="size-14 rounded-lg object-cover"
              />
            ) : (
              <>
                <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                <div className="flex flex-col overflow-hidden">
                  <span className="max-w-[10rem] truncate">{it.filename}</span>
                  <span className="text-[10px] text-muted-foreground">{formatSize(it.size)}</span>
                </div>
              </>
            )}
            {/* Upload state overlay: spinner while in flight, alert on failure. */}
            {it.status !== "done" && (
              <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-background/60">
                {it.status === "uploading" ? (
                  <Loader2 className="size-4 animate-spin text-muted-foreground" />
                ) : (
                  <AlertCircle className="size-4 text-destructive" />
                )}
              </div>
            )}
            <button
              type="button"
              onClick={() => onRemove(it.localId)}
              aria-label={`Remove ${it.filename}`}
              className={cn(
                "absolute -right-1.5 -top-1.5 flex size-4 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-sm hover:text-foreground",
              )}
            >
              <X className="size-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
