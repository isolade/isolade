import { FileIcon } from "lucide-react";
import { uploadUrl } from "../../lib/api";
import type { Upload } from "../../lib/contracts";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Attachments shown under a user message in the transcript. Images render as
// thumbnails that open full-size in a new tab; other files render as download
// chips. Both hit the instance-scoped upload endpoint (with the auth token in
// the URL, since <img>/<a> can't set headers).
export function MessageUploads({ instanceId, uploads }: { instanceId: string; uploads: Upload[] }) {
  if (uploads.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap justify-end gap-2">
      {uploads.map((u) => {
        const href = uploadUrl(instanceId, u.id);
        if (u.mediaType.startsWith("image/")) {
          return (
            <a key={u.id} href={href} target="_blank" rel="noreferrer" title={u.filename}>
              <img
                src={href}
                alt={u.filename}
                className="max-h-48 rounded-lg border border-border object-cover"
              />
            </a>
          );
        }
        return (
          <a
            key={u.id}
            href={uploadUrl(instanceId, u.id, { download: true })}
            className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-2 py-1.5 text-xs hover:bg-muted"
            title={`Download ${u.filename}`}
          >
            <FileIcon className="size-4 shrink-0 text-muted-foreground" />
            <div className="flex flex-col overflow-hidden text-left">
              <span className="max-w-[12rem] truncate">{u.filename}</span>
              <span className="text-[10px] text-muted-foreground">{formatSize(u.size)}</span>
            </div>
          </a>
        );
      })}
    </div>
  );
}
