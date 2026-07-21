import {
  currentMonitor,
  getCurrentWindow,
  LogicalPosition,
  LogicalSize,
} from "@tauri-apps/api/window";
import { useRef } from "react";

// Window-chrome drag + double-click-zoom, shared by every surface that stands in
// for the OS title bar. In the panel workspace that's the tab strips of the
// top-edge panels (their empty regions drag the window); the settings overlay's
// top strip uses it too. Extracted from the old TitleBar so both can behave
// identically without a bar component in between.

// A mousedown on a drag surface starts an OS window drag, EXCEPT when it lands
// on an interactive control (buttons, tabs, menu items, …) so those keep
// working. Mirrors AppKit's title-bar behaviour.
const INTERACTIVE_SELECTOR =
  "button, a, input, select, textarea, [role='button'], [role='tab'], [role='menuitem'], [data-no-drag]";

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
}

async function animateWindow(
  from: { x: number; y: number; w: number; h: number },
  to: { x: number; y: number; w: number; h: number },
  duration: number,
): Promise<void> {
  const win = getCurrentWindow();
  const start = performance.now();
  await new Promise<void>((resolve) => {
    const frame = async (now: number) => {
      const t = easeInOut(Math.min((now - start) / duration, 1));
      await Promise.all([
        win.setPosition(
          new LogicalPosition(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t),
        ),
        win.setSize(new LogicalSize(from.w + (to.w - from.w) * t, from.h + (to.h - from.h) * t)),
      ]);
      if (t < 1) requestAnimationFrame(frame);
      else resolve();
    };
    requestAnimationFrame(frame);
  });
}

// Handlers to spread onto a drag surface. No-ops (and never start a drag) when
// `isTauri` is false, so the same surface is inert in the browser dev build.
export function useWindowDrag(isTauri: boolean) {
  const lastClickRef = useRef(0);
  const savedBoundsRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);

  const isDragTarget = (e: React.MouseEvent): boolean => {
    if (!isTauri) return false;
    const target = e.target as HTMLElement;
    if (target.closest(INTERACTIVE_SELECTOR)) return false;
    return true;
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (!isDragTarget(e)) return;
    const now = Date.now();
    const isDoubleClick = now - lastClickRef.current < 300;
    lastClickRef.current = now;
    if (!isDoubleClick) getCurrentWindow().startDragging();
  };

  const onDoubleClick = async (e: React.MouseEvent) => {
    if (!isDragTarget(e)) return;
    const win = getCurrentWindow();
    const full = {
      x: window.screen.availLeft ?? 0,
      y: window.screen.availTop ?? 0,
      w: window.screen.availWidth,
      h: window.screen.availHeight,
    };
    try {
      if (savedBoundsRef.current) {
        const to = savedBoundsRef.current;
        savedBoundsRef.current = null;
        await animateWindow(full, to, 250);
      } else {
        const [pos, size, monitor] = await Promise.all([
          win.outerPosition(),
          win.outerSize(),
          currentMonitor(),
        ]);
        const sf = monitor?.scaleFactor ?? 1;
        savedBoundsRef.current = {
          x: pos.x / sf,
          y: pos.y / sf,
          w: size.width / sf,
          h: size.height / sf,
        };
        await animateWindow(savedBoundsRef.current, full, 250);
      }
    } catch (err) {
      console.error("zoom error:", err);
    }
  };

  return { onMouseDown, onDoubleClick };
}
