import { type MouseEvent as ReactMouseEvent, useCallback, useRef, useState } from "react";
import { cn } from "./utils";

// ---------------------------------------------------------------------------
// Sidebar nav row look: single source of truth
//
// The instances/chat list (InstancesSidebar) and the settings section nav
// (SettingsPane) render the same kind of row and must look identical. The
// shared tokens below are the one place that decides that look, and both consumers
// build from them so they can't drift.
//
// They can't share a single class string because the two surfaces select their
// active row differently: the chat list is a plain <button> that computes
// `isActive` itself, while the settings nav is a Radix TabsTrigger styled via
// its `[data-state]` attribute, and Tailwind v4 only emits CSS for class names
// that appear verbatim in source (it can't see runtime-built strings), so the
// `data-[state=…]:` variants have to be written out as literals. Hence two thin
// adapters over one set of tokens rather than one string.
// `transition-none`: the rows snap on hover/active rather than fading. The
// plain-button rows have no transition anyway, but the Radix TabsTrigger base
// carries `transition-all`, so this is what cancels the hover-fade there and
// keeps both surfaces instant.
// `select-none`: these are nav rows, not prose, so the label isn't selectable
// text. Without it, right-clicking a row (to open its context menu) leaves the
// browser's default word selection behind on the title.
const SIDEBAR_ROW_LAYOUT =
  "w-full flex items-center gap-1.5 rounded px-2 py-1 text-sm text-left transition-none select-none";
const SIDEBAR_ROW_ACTIVE = "bg-accent text-accent-foreground";
const SIDEBAR_ROW_IDLE = "text-foreground hover:bg-accent/40";

// Plain-button rows (the chat list) that compute their own active state.
export function sidebarRowClass(active: boolean): string {
  return cn(SIDEBAR_ROW_LAYOUT, active ? SIDEBAR_ROW_ACTIVE : SIDEBAR_ROW_IDLE);
}

// Radix TabsTrigger rows (the settings nav). The trigger ships a heavy base
// whose layout/idle/active rules (including dark-mode ones) are keyed on
// `[data-state]`. In Tailwind v4 group variants are wrapped in :where() (zero
// specificity), so the only reliable override is same-modifier classes that
// tailwind-merge drops the base ones for. This mirrors the plain-row palette
// above using `[data-state]` modifiers, plus the neutralizers that cancel base
// utilities a bare <button> never had (flex-1, border, the centered alignment,
// the medium weight, the dimmed idle text, and the active-indicator pseudo).
export const SIDEBAR_TABS_TRIGGER_CLASS = cn(
  SIDEBAR_ROW_LAYOUT,
  "flex-none justify-start border-0 h-auto font-normal after:hidden",
  // Idle: full-strength foreground in both themes (base dims it to /60).
  "text-foreground dark:text-foreground",
  // Hover only on the inactive rows, so the active row keeps its solid fill.
  "data-[state=inactive]:hover:bg-accent/40",
  // Active: the SIDEBAR_ROW_ACTIVE palette, keyed on data-state (and repeated
  // for dark, which the base overrides separately).
  "data-[state=active]:bg-accent data-[state=active]:text-accent-foreground",
  "dark:data-[state=active]:bg-accent dark:data-[state=active]:text-accent-foreground",
);

// Geometry for the left sidebar, shared so the instances list and the settings
// pane render at the same width and resize in lockstep.
// Clears the full floating window-chrome cluster at the top of the instances
// sidebar, including the Settings icon's slight negative horizontal margins.
const MIN_WIDTH = 128;
const MAX_WIDTH = 480;
const DEFAULT_WIDTH = 256;
const WIDTH_STORAGE_KEY = "isolade.sidebarWidth";

function loadStoredWidth(): number {
  try {
    const raw = window.localStorage.getItem(WIDTH_STORAGE_KEY);
    if (raw === null) return DEFAULT_WIDTH;
    const n = parseInt(raw, 10);
    if (Number.isNaN(n)) return DEFAULT_WIDTH;
    return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, n));
  } catch {
    return DEFAULT_WIDTH;
  }
}

// Owns the sidebar width plus the drag-to-resize gesture. Both panes that host
// the sidebar (the instances list, the settings pane) call this. They're never
// mounted at once, so persisting to localStorage on every drag is enough to
// keep them in sync: whichever pane last wrote the width is what the other
// opens at, which is what makes the two read as one continuous sidebar.
export function useResizableSidebarWidth() {
  const [width, setWidth] = useState<number>(loadStoredWidth);
  const dragStartRef = useRef<{ x: number; width: number } | null>(null);

  const beginResize = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      dragStartRef.current = { x: e.clientX, width };
      const prevCursor = document.body.style.cursor;
      const prevUserSelect = document.body.style.userSelect;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const onMove = (ev: MouseEvent) => {
        const start = dragStartRef.current;
        if (!start) return;
        const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, start.width + (ev.clientX - start.x)));
        setWidth(next);
        try {
          window.localStorage.setItem(WIDTH_STORAGE_KEY, String(next));
        } catch {}
      };
      const onUp = () => {
        dragStartRef.current = null;
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevUserSelect;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [width],
  );

  return { width, beginResize };
}
