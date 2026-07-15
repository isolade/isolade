import logoDark from "@/assets/logo_dark.svg";
import logoLight from "@/assets/logo_light.svg";
import { openExternal } from "../lib/tauri";
import { useUpdateStatus } from "../lib/useUpdateStatus";

function formatChecked(ts: number | null): string {
  if (!ts) return "never";
  return new Date(ts).toLocaleString();
}

// A calm, centered hero: the full brand lockup (glass mark, wordmark, and
// tagline) big enough to enjoy on its own, with the version stacked beneath it.
// Centered both ways so it stays composed whether the pane is tall or short.
// Scrolls rather than clips if the window gets very small. h-full (not flex-1)
// because the enclosing TabsContent is a plain block, so there's no flex context
// to stretch into.
export default function AboutTab() {
  const { status, checking, recheck } = useUpdateStatus();

  // The server reports the runtime version Tauri read from app/tauri.conf.json
  // and passed to the sidecar. In a plain browser/dev session, that value is not
  // available, so show an explicit fallback instead of a copied constant that can
  // drift from the packaged app.
  const version = status?.current && status.current !== "unknown" ? status.current : "unknown";
  const showUpdates = !!status && status.current !== "unknown";

  return (
    <div className="h-full w-full overflow-auto">
      <div className="min-h-full flex flex-col items-center justify-center gap-4 px-6 py-16 text-center">
        {/* The full brand lockup ships in two variants that differ only in the
            tagline's ink (black on light, white on dark), so we render both and
            let the `.dark` class on the root pick one. The tagline's gold half
            and the gold wordmark and glass mark are shared, so either variant is
            correct on its own theme. */}
        <img
          src={logoLight}
          alt="Isolade"
          draggable={false}
          className="h-80 w-auto select-none drop-shadow-xl transition-transform duration-500 ease-out hover:scale-[1.04] dark:hidden"
        />
        <img
          src={logoDark}
          alt="Isolade"
          draggable={false}
          className="hidden h-80 w-auto select-none drop-shadow-xl transition-transform duration-500 ease-out hover:scale-[1.04] dark:block"
        />

        <span className="text-xs text-muted-foreground tabular-nums">Version {version}</span>

        {showUpdates && (
          <div className="mt-2 flex flex-col items-center gap-2">
            {status.checkedAt === null ? (
              // No check has ever succeeded, so don't claim either way.
              <span className="text-sm text-muted-foreground">Couldn't check for updates.</span>
            ) : status.available ? (
              <span className="text-sm">
                Update available: <span className="tabular-nums">{status.latest}</span>
                {status.download && (
                  <>
                    {" · "}
                    <button
                      type="button"
                      onClick={() => void openExternal(status.download ?? status.notes ?? "")}
                      className="font-medium text-primary underline-offset-2 hover:underline"
                    >
                      get it
                    </button>
                  </>
                )}
              </span>
            ) : (
              <span className="text-sm text-muted-foreground">You're up to date.</span>
            )}

            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <button
                type="button"
                onClick={() => void recheck()}
                disabled={checking}
                className="rounded-md border border-border px-2.5 py-1 hover:bg-muted disabled:opacity-60"
              >
                {checking ? "Checking…" : "Check for updates"}
              </button>
              <span>Last checked: {formatChecked(status.checkedAt)}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
