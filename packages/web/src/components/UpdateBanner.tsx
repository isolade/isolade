import { useEffect, useState } from "react";
import { onExternalLinkClick, openExternal } from "../lib/tauri";
import { useUpdateStatus } from "../lib/useUpdateStatus";

// Remember the version a user dismissed, so the bar stays gone for that release
// but returns when a newer one ships.
const DISMISS_KEY = "isolade-update-dismissed";

/**
 * A slim bar shown under the title bar when a newer version is available. The
 * server decides availability (the once-per-day check). This just renders it and
 * routes the download/notes links to the system browser via openExternal. The
 * app is self-signed, so we point the user at the install rather than auto-
 * updating in place.
 */
export default function UpdateBanner() {
  const { status } = useUpdateStatus();
  const [dismissed, setDismissed] = useState(false);

  // Re-hide for a version the user already dismissed, and reappear for a newer one.
  useEffect(() => {
    try {
      if (status?.latest && localStorage.getItem(DISMISS_KEY) === status.latest) setDismissed(true);
    } catch {
      // localStorage unavailable, so just show the bar.
    }
  }, [status?.latest]);

  if (!status?.available || dismissed) return null;

  const target = status.download ?? status.notes;
  const dismiss = () => {
    setDismissed(true);
    try {
      if (status.latest) localStorage.setItem(DISMISS_KEY, status.latest);
    } catch {
      // ignore
    }
  };

  return (
    <div className="flex items-center gap-3 border-b border-border bg-muted/60 px-4 py-1.5 text-sm">
      <span className="font-medium">Update available</span>
      <span className="truncate text-muted-foreground">
        <span className="tabular-nums">
          {status.current} → {status.latest}
        </span>
        {status.changes.length > 0 && <span> · {status.changes[0]}</span>}
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-3">
        {target && (
          <button
            type="button"
            onClick={() => void openExternal(target)}
            className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:opacity-90"
          >
            Get the update
          </button>
        )}
        {status.notes && (
          <a
            href={status.notes}
            target="_blank"
            rel="noopener"
            className="text-xs text-muted-foreground underline-offset-2 hover:underline"
            onClick={(e) => onExternalLinkClick(e, status.notes)}
          >
            What's new
          </a>
        )}
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss"
          className="text-muted-foreground hover:text-foreground"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
