// Platform helpers for the dual-target frontend: the same bundle runs inside the
// native Tauri webview (the shipped app) and in a plain browser (dev, the demo
// recorder). The Tauri host injects `__TAURI_INTERNALS__` before page scripts,
// so its presence is the canonical "are we native?" signal.

import type { MouseEvent as ReactMouseEvent } from "react";

/** True when running inside the Tauri webview rather than a plain browser. */
export function isTauri(): boolean {
  return typeof window.__TAURI_INTERNALS__ !== "undefined";
}

/**
 * The app's title bar height, in logical pixels: the single constant the
 * window-chrome layout is built around, and every other title-bar measurement is
 * derived from it. Mirrors `TITLE_BAR_HEIGHT` in app/src/lib.rs, where the
 * native window controls are centred in a bar of this height, and here we size the
 * CSS bar to match. It's a fixed design number, so a mirrored literal on each
 * side is simpler than threading a value across the boundary. Keep the two in
 * step. This does NOT include the native inset.
 */
export const TITLE_BAR_HEIGHT = 32;
export const MACOS_WINDOW_INSET = 1;
export const TITLE_BAR_WITH_INSET_HEIGHT = TITLE_BAR_HEIGHT + MACOS_WINDOW_INSET;

/**
 * True when the native host reports macOS Tahoe (26) or newer, whose native
 * window controls ("traffic lights") are larger and wider-spaced. Injected by
 * the host (app/src/lib.rs). False in a plain browser and on pre-Tahoe macOS.
 */
export function isTahoe(): boolean {
  return window.__ISOLADE__?.tahoe === true;
}

export const TRAFFIC_LIGHT = { width: 14, height: 14 };
export const TRAFFIC_LIGHT_GAP = 9;

/**
 * Open a URL in the user's default browser.
 *
 * In a plain browser `window.open` does this. Inside WKWebView (the Tauri app)
 * it does not (it either no-ops or opens another in-app webview), so we hand
 * the URL to the native host via the `open_url` command (app/src/lib.rs), which
 * asks the OS to open it. Used by the provider OAuth flow, where the sign-in
 * page must land in a real browser the user is already logged into.
 */
export async function openExternal(url: string): Promise<void> {
  if (isTauri()) {
    // Dynamic import so the Tauri API isn't pulled into the browser bundle path
    // (mirrors lib/system-fonts.ts).
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("open_url", { url });
    return;
  }
  // Browser: no `noopener`, so the OAuth success page can window.close() the tab
  // it opened once the callback lands.
  window.open(url, "_blank");
}

/**
 * onClick handler for an `<a>` that should open in the system browser.
 *
 * Prefer this over relying on `installExternalLinkHandler` alone: the
 * document-level delegate only fires if the native click actually bubbles to
 * `document`, which inside WKWebView it does not do reliably for
 * `target="_blank"` anchors (the culprit behind chat-markdown links that just
 * no-op). Handling the click on the element itself (the same path the OAuth
 * "Sign in" button already uses) fires dependably. Left as a no-op in a plain
 * browser, where the anchor's native `target="_blank"` opens a tab, and likewise for
 * modifier/middle clicks, which we leave to the webview.
 */
export function onExternalLinkClick(
  e: ReactMouseEvent<HTMLAnchorElement>,
  href: string | null | undefined,
): void {
  if (!isTauri()) return;
  if (e.defaultPrevented || e.button !== 0) return;
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  if (!href) return;
  e.preventDefault();
  void openExternal(href);
}

/**
 * Fallback: route stray `target="_blank"` links to the system browser under
 * Tauri via one document-level listener.
 *
 * Anchors we control use `onExternalLinkClick` directly, which fires reliably.
 * This delegate is a safety net for any anchor that doesn't (third-party markup,
 * future code), but note it only works when the native click bubbles all the
 * way to `document`, which inside WKWebView it does not do dependably, so it is
 * not a substitute for the per-element handler. Skips anchors already handled
 * (their `preventDefault` sets `defaultPrevented`). No-op in a plain browser,
 * where `target="_blank"` works natively. Returns a cleanup function.
 */
export function installExternalLinkHandler(): () => void {
  if (!isTauri()) return () => {};
  const onClick = (e: MouseEvent) => {
    // Honour an explicit preventDefault, and leave modifier/middle clicks to
    // the webview's own handling.
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const target = e.target;
    const anchor = target instanceof Element ? target.closest('a[target="_blank"]') : null;
    const href = anchor?.getAttribute("href");
    if (!href) return;
    let resolved: URL;
    try {
      resolved = new URL(href, window.location.href);
    } catch {
      return; // Not a navigable URL, so leave it alone.
    }
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return;
    e.preventDefault();
    void openExternal(resolved.href);
  };
  document.addEventListener("click", onClick);
  return () => document.removeEventListener("click", onClick);
}
