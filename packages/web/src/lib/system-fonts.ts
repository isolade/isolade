import { useEffect, useState } from "react";

// The font list is stable for the life of the app, so fetch it once and share
// the result across every hook caller.
let cache: string[] | null = null;
let inflight: Promise<string[]> | null = null;

async function fetchSystemFonts(): Promise<string[]> {
  if (cache) return cache;
  if (!inflight) {
    inflight = (async () => {
      try {
        // Dynamic import so the Tauri API isn't pulled into the browser bundle
        // path. `list_system_fonts` is the native command defined in app/.
        const { invoke } = await import("@tauri-apps/api/core");
        const fonts = await invoke<string[]>("list_system_fonts");
        cache = Array.isArray(fonts) ? fonts : [];
      } catch {
        cache = [];
      }
      return cache;
    })();
  }
  return inflight;
}

/** Installed font families on the machine running the app, enumerated by the
    native Tauri command. Returns [] when `enabled` is false (e.g. plain
    browser, where the picker falls back to free-text) or on failure. */
export function useSystemFonts(enabled: boolean): string[] {
  const [fonts, setFonts] = useState<string[]>(cache ?? []);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void fetchSystemFonts().then((f) => {
      if (!cancelled) setFonts(f);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return fonts;
}
