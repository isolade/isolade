import type { MouseEvent as ReactMouseEvent } from "react";

interface SidebarResizeHandleProps {
  onMouseDown: (e: ReactMouseEvent) => void;
}

// The invisible grab strip straddling the sidebar's right edge that drives
// drag-to-resize with no visible line, just the col-resize cursor as the
// affordance. Shared by the instances list and the settings pane so both resize
// identically. Pair it with `useResizableSidebarWidth`. Expects a `relative`
// ancestor to anchor against.
export default function SidebarResizeHandle({ onMouseDown }: SidebarResizeHandleProps) {
  return (
    <div
      onMouseDown={onMouseDown}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      // Focusable (out of tab order) so the splitter counts as an interactive
      // control. The drag itself stays pointer-driven.
      tabIndex={-1}
      className="absolute top-0 -right-1 z-10 h-full w-2 cursor-col-resize"
    />
  );
}
