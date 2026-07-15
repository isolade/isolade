import { useEffect } from "react";
import HomeTab from "./components/home/HomeTab";
import { resolveActiveProfileId } from "./lib/activeProfile";
import { getProfileAppearance, setProfileAppearance } from "./lib/api";
import { applyAppearance, getLocalAppearance } from "./lib/settings";
import { isTauri as detectTauri, installExternalLinkHandler } from "./lib/tauri";

export default function App() {
  const isTauri = detectTauri();

  // Route target="_blank" links to the system browser (no-op outside Tauri).
  useEffect(() => installExternalLinkHandler(), []);

  // Appearance is owned by the active profile. The pre-render FOUC hint +
  // initTheme() paint from the localStorage cache. Here we reconcile against the
  // active profile's server-stored appearance (authoritative), and on the first
  // run for a profile with none, seed it from the local cache (one-time
  // migration off localStorage). A reload after a profile switch re-runs this,
  // re-skinning the app for the new profile. Resilient: if the profiles API is
  // unavailable, the localStorage theme already on screen stays.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const profileId = await resolveActiveProfileId();
        if (!profileId) return;
        const server = await getProfileAppearance(profileId);
        if (cancelled) return;
        if (server.theme || server.fontAgent || server.fontUser || server.debug !== undefined) {
          applyAppearance(server);
        } else {
          await setProfileAppearance(profileId, getLocalAppearance()).catch(() => {});
        }
      } catch {
        // No profiles API (demo mock) or offline, so keep the cached theme.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // The title bar (see components/TitleBar) owns the window chrome: the
  // traffic-light slot, the drag region and double-click-to-zoom.
  const body = (
    <div
      className={`${isTauri ? "h-screen" : "h-full"} flex flex-col bg-background text-foreground`}
    >
      <HomeTab isTauri={isTauri} />
    </div>
  );

  // Native (Tauri) builds get window chrome from macOS itself. Opened in a plain
  // browser there is none, so float the UI as a simulated macOS window: a black
  // backdrop, rounded corners, a drop shadow and the inset highlight border
  // (see .mac-stage/.mac-window in index.css, and mirrors the demo recorder).
  if (isTauri) return body;

  return (
    <div className="mac-stage">
      <div className="mac-window">{body}</div>
    </div>
  );
}
