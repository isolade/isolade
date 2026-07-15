import {
  currentMonitor,
  getCurrentWindow,
  LogicalPosition,
  LogicalSize,
} from "@tauri-apps/api/window";
import { type ReactNode, useRef } from "react";
import { MACOS_WINDOW_INSET, TITLE_BAR_HEIGHT, TRAFFIC_LIGHT_GAP } from "../lib/tauri";
import TrafficLights from "./TrafficLights";

// The window's title bar. Always present so the workspace/settings content never
// reaches the very top of the window. Its height is TITLE_BAR_HEIGHT (the single
// layout constant, shared with app/src/lib.rs, which centres the native window
// controls in a bar of exactly this height). (In the browser the black
// .mac-stage insets the window 8px from the HTML body, so the bar's bottom lands
// TITLE_BAR_HEIGHT+8 below the body top. In Tauri it's flush at the top edge.)
//
// The chrome controls live in a band spanning the full bar height with its
// children vertically centred: because the native traffic lights (real ones in
// Tauri, decorative look-alikes in the browser) are themselves centred in the
// bar (see the formula in app/src/lib.rs), centring the band lands our own
// chrome on their midline. No pixel offset to keep in sync: it falls out of the
// shared bar height.

// A mousedown on the bar starts a window drag, except when it lands on an
// interactive control (so the chrome buttons keep working), mirroring AppKit.
const INTERACTIVE_SELECTOR =
  "button, a, input, select, textarea, [role='button'], [role='tab'], [role='menuitem'], [data-no-drag]";

function easeInOut(t: number) {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
}

async function animateWindow(
  from: { x: number; y: number; w: number; h: number },
  to: { x: number; y: number; w: number; h: number },
  duration: number,
) {
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

interface TitleBarProps {
  isTauri: boolean;
  // Chrome controls placed immediately to the right of the traffic lights
  // (the sidebar-collapse toggle and the settings gear / its "Back" swap).
  left?: ReactNode;
  // Chrome controls pinned to the far right (the side-panel toggle).
  right?: ReactNode;
  // Content centred on the window's midline, layered over the control band (the
  // active chat's attached-PR badges).
  center?: ReactNode;
}

export default function TitleBar({ isTauri, left, right, center }: TitleBarProps) {
  const lastClickRef = useRef(0);
  const savedBoundsRef = useRef<{
    x: number;
    y: number;
    w: number;
    h: number;
  } | null>(null);

  // Only the empty regions of the bar drag the window. Controls in the slots
  // are <button>s and so excluded by INTERACTIVE_SELECTOR.
  const isDragTarget = (e: React.MouseEvent) => {
    if (!isTauri) return false;
    const target = e.target as HTMLElement;
    if (target.closest(INTERACTIVE_SELECTOR)) return false;
    return true;
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (!isDragTarget(e)) return;
    const now = Date.now();
    const isDoubleClick = now - lastClickRef.current < 300;
    lastClickRef.current = now;
    if (!isDoubleClick) getCurrentWindow().startDragging();
  };

  const handleDoubleClick = async (e: React.MouseEvent) => {
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

  return (
    // The bar is window chrome: mousedown starts an OS window drag and
    // double-click zooms. It's a drag surface, not an ARIA control, so a role
    // would misrepresent it.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <header
      className="flex-shrink-0 bg-muted/30 select-none"
      onMouseDown={handleMouseDown}
      onDoubleClick={handleDoubleClick}
    >
      {/* A full-width MACOS_WINDOW_INSET-tall (1px) spacer at the very top of the
          bar, the reason the header is TITLE_BAR_WITH_INSET_HEIGHT rather than a
          bare TITLE_BAR_HEIGHT. */}
      <div className="w-full" style={{ height: MACOS_WINDOW_INSET }} aria-hidden />
      <div className="relative" style={{ height: TITLE_BAR_HEIGHT }}>
        <div className="h-full flex items-center">
          <TrafficLights isTauri={isTauri} />
          {left}
          {/* Draggable filler between the left and right control clusters. */}
          <div className="flex-1 self-stretch" />
          {right}
          <div style={{ width: MACOS_WINDOW_INSET + TRAFFIC_LIGHT_GAP }} />
        </div>
        {/* The centred content (attached-PR badges), centred on the window's
            midline and vertically centred in the bar, a full-bar overlay layered
            over the control band. The wrapper is click-through so the empty space
            on either side still drags the window; only the content catches clicks.

            max-width caps this centred zone so it shrinks *before* it can collide
            with the window chrome. Because the zone is centred on the window, each
            side must reserve room for the widest control cluster: on the left the
            reserved lights slot (~70px) plus the sidebar/settings controls (~44px),
            on the right the panel toggle. Reserving 11rem per side (22rem total)
            keeps the content clear of both stacks. */}
        {center && (
          <div className="pointer-events-none absolute top-0 w-full h-full">
            <div className="relative inset-0 flex items-center justify-center h-full">
              <div className="pointer-events-auto flex max-w-[calc(100vw-22rem)] items-center">
                {center}
              </div>
            </div>
          </div>
        )}
      </div>
    </header>
  );
}
