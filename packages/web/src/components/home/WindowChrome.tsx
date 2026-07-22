import { PanelLeft, Settings } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import {
  MACOS_WINDOW_INSET,
  TITLE_BAR_HEIGHT,
  TITLE_BAR_WITH_INSET_HEIGHT,
  TRAFFIC_LIGHT_GAP,
} from "@/lib/tauri";
import TrafficLights from "../TrafficLights";

// The floating window-chrome cluster pinned to the top-left of the window: the
// macOS traffic-lights slot, the sidebar-collapse toggle, and the settings
// toggle. It floats above the panel workspace and the settings overlay both,
// so it's always reachable.
//
// The top-left panel's tab strip reserves leading space equal to this cluster's
// width (only while the sidebar is collapsed, otherwise the sidebar sits under
// the cluster instead), so its tabs never hide behind the chrome. We measure
// the rendered width rather than hard-coding it, since the traffic-lights slot
// width and the controls differ between platforms/builds.
interface WindowChromeProps {
  isTauri: boolean;
  settingsOpen: boolean;
  onToggleSidebar: () => void;
  onOpenSettings: () => void;
  onCloseSettings: () => void;
  // Reports the cluster's rendered width (px) so the workspace can inset the
  // top-left panel's tab strip by exactly this much.
  onWidthChange: (width: number) => void;
}

// Ghost-button chrome: no hover fill or focus ring, just an icon colour shift,
// so a control in the window chrome never reads as a stray tinted box.
const chromeBase =
  "text-muted-foreground hover:text-foreground hover:bg-transparent dark:hover:bg-transparent transition-colors focus-visible:ring-0";

export default function WindowChrome({
  isTauri,
  settingsOpen,
  onToggleSidebar,
  onOpenSettings,
  onCloseSettings,
  onWidthChange,
}: WindowChromeProps) {
  const rowRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    const report = () => onWidthChange(el.getBoundingClientRect().width);
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [onWidthChange]);

  return (
    // Sized to its content (inline-flex) so only the cluster itself is on top;
    // the empty top row beside it stays a window-drag surface owned by the
    // panel strips underneath. z above the settings overlay (z-40).
    <div
      className="absolute top-0 left-0 z-50 inline-flex flex-col select-none"
      style={{ height: TITLE_BAR_WITH_INSET_HEIGHT }}
    >
      <div className="w-full" style={{ height: MACOS_WINDOW_INSET }} aria-hidden />
      <div ref={rowRef} className="flex items-center" style={{ height: TITLE_BAR_HEIGHT }}>
        <TrafficLights isTauri={isTauri} />
        <button
          type="button"
          className={chromeBase}
          style={{ marginRight: TRAFFIC_LIGHT_GAP }}
          onMouseUp={(e) => {
            if (e.button === 0) onToggleSidebar();
          }}
          onClick={onToggleSidebar}
          aria-label="Toggle sidebar"
        >
          <PanelLeft size={17} />
        </button>
        <button
          type="button"
          style={{ marginLeft: -2 }}
          className={chromeBase}
          onClick={settingsOpen ? onCloseSettings : onOpenSettings}
          aria-label={settingsOpen ? "Close settings" : "Settings"}
          aria-pressed={settingsOpen}
          data-demo="settings-toggle"
        >
          <Settings size={17} />
        </button>
      </div>
    </div>
  );
}
