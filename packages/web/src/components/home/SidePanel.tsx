import { FolderTree, GitPullRequest, Globe, Network, Terminal as TerminalIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { PortForward, Terminal as TerminalT } from "../../lib/contracts";
import Terminal from "../Terminal";
import BrowserPreview from "./BrowserPreview";
import FileTree from "./FileTree";
import PortsPanel from "./PortsPanel";
import ReviewPanel from "./ReviewPanel";

// Which body the right-hand panel shows. Remembered per instance by the parent.
export type PanelMode = "terminal" | "browser" | "files" | "review" | "ports";

interface SidePanelProps {
  instanceId: string;
  // The dedicated shell terminal for this instance, or null until one has been
  // created. The parent owns terminal state, and this panel just renders it.
  terminal: TerminalT | null;
  // Forwarded ports for this instance, surfaced by the browser preview.
  ports: PortForward[];
  // Body selection is owned (and persisted per instance) by the parent. The
  // open/closed (collapsed) state lives in the parent too: it only mounts this
  // panel while open, and the title bar carries the toggle.
  width: number;
  mode: PanelMode;
  onModeChange: (mode: PanelMode) => void;
  // Called on resize release with the final width, so the parent persists it.
  onWidthChange: (width: number) => void;
  // Fired while the terminal mode is open but no shell terminal exists yet, so
  // the parent can lazily create one. Safe to call repeatedly, since the parent
  // de-dupes in-flight creation.
  onEnsureTerminal: () => void;
}

const MIN_WIDTH = 240;
// Reserve enough horizontal space for the left sidebar plus a usable content
// column. Within that, let the panel scale with the window so wide monitors can
// give the preview most of the screen.
const MIN_REST_WIDTH = 480;

function maxPanelWidth(): number {
  return Math.max(MIN_WIDTH, window.innerWidth - MIN_REST_WIDTH);
}

export default function SidePanel({
  instanceId,
  terminal,
  ports,
  width,
  mode,
  onModeChange,
  onWidthChange,
  onEnsureTerminal,
}: SidePanelProps) {
  // Committed panel width. The parent's persisted value is the source of truth,
  // so sync to it when it changes (e.g. switching to a different instance's
  // remembered layout). During a drag we deliberately do NOT setState per
  // mousemove, which would re-render the whole panel body (a multi-thousand-row
  // diff is enough to make the drag stutter). Instead the live width is written
  // straight to the <aside> via a ref, and committed to state once on release.
  const [localWidth, setLocalWidth] = useState<number>(width);
  useEffect(() => {
    setLocalWidth(width);
  }, [width]);
  const asideRef = useRef<HTMLElement>(null);
  const dragStartRef = useRef<{ x: number; width: number } | null>(null);
  // While resizing, a full-window overlay sits above the body so the cursor
  // never enters the preview iframe. Otherwise the iframe captures the mouse
  // events and the drag freezes (and never releases on mouseup).
  const [resizing, setResizing] = useState(false);

  // Terminal mode with no shell yet → ask the parent to create one. The browser
  // mode never needs a shell, so opening straight into it costs no VM resources.
  useEffect(() => {
    if (mode === "terminal" && !terminal) onEnsureTerminal();
  }, [mode, terminal, onEnsureTerminal]);

  // Defer mounting the browser (and thus its first request to the dev server)
  // until the user actually opens it, then keep it mounted thereafter so toggling
  // back to it doesn't reload the page.
  const [browserMounted, setBrowserMounted] = useState(false);
  useEffect(() => {
    if (mode === "browser") setBrowserMounted(true);
  }, [mode]);

  // Same lazy-mount-then-keep-alive treatment for the file tree, so its
  // expansion state and scroll position survive a peek at the terminal.
  const [filesMounted, setFilesMounted] = useState(false);
  useEffect(() => {
    if (mode === "files") setFilesMounted(true);
  }, [mode]);

  // Likewise for the review diff, so its expand/collapse and scroll position
  // survive switching away and back.
  const [reviewMounted, setReviewMounted] = useState(false);
  useEffect(() => {
    if (mode === "review") setReviewMounted(true);
  }, [mode]);

  // Ports panel: lazy-mount then keep alive so its poll loop and any pending
  // add/remove survive a peek at another mode.
  const [portsMounted, setPortsMounted] = useState(false);
  useEffect(() => {
    if (mode === "ports") setPortsMounted(true);
  }, [mode]);

  // The handle lives on the left edge, so dragging left widens the panel,
  // the mirror of the left sidebar's right-edge handle.
  const handleResizeMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    dragStartRef.current = { x: e.clientX, width: localWidth };
    setResizing(true);
    let latest = localWidth;

    const onMove = (ev: MouseEvent) => {
      const start = dragStartRef.current;
      if (!start) return;
      latest = Math.min(maxPanelWidth(), Math.max(MIN_WIDTH, start.width - (ev.clientX - start.x)));
      // Write the width straight to the DOM so the body doesn't re-render on
      // every mousemove. React's render still holds the pre-drag value, but it
      // won't re-apply the style prop until something triggers a render, which
      // we only do on release (setLocalWidth below), and by then they agree.
      if (asideRef.current) asideRef.current.style.width = `${latest}px`;
    };
    const onUp = () => {
      dragStartRef.current = null;
      setResizing(false);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      // Commit the final width to local state (so future renders agree with the
      // DOM) and persist it to the parent (per-instance), both once on release.
      setLocalWidth(latest);
      onWidthChange(latest);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  return (
    <>
      {/* Transparent capture layer during a drag: keeps the cursor out of the
          preview iframe (which would otherwise eat the mousemove/mouseup) and
          carries the resize cursor across the whole window. */}
      {resizing && <div className="fixed inset-0 z-50 cursor-col-resize select-none" />}
      {/* Transparent: the muted chrome field shows through, matching the left
          sidebar; only the body region below paints (terminal transparent,
          preview paints its own background). */}
      <aside
        ref={asideRef}
        className="relative flex-shrink-0 flex flex-col"
        style={{ width: Math.min(localWidth, maxPanelWidth()) }}
      >
        {/* pt-px aligns the mode toggle's top with the left sidebar's first row
            (the chat-title band), which sits ~1px below the title bar since the
            chrome moved into the title bar, so Terminal/Browser start at the
            same y as the chat titles across the window rather than dropped
            below them. The pill is the same 28px tall as a sidebar row, so the
            two read as one continuous band. */}
        <div className="flex items-center px-2 pt-px pb-1">
          <ModeToggle mode={mode} onModeChange={onModeChange} />
        </div>
        <div className="flex-1 min-h-0">
          {/* Terminal: mounted once a shell exists and then kept alive, so its
              scrollback and socket survive a peek at the preview. Keyed by
              terminal id so switching instances reconnects to the new shell. */}
          {terminal && (
            <div className="h-full" style={{ display: mode === "terminal" ? "block" : "none" }}>
              <Terminal
                key={terminal.id}
                wsUrl={`/api/instances/${instanceId}/terminals/${terminal.id}/socket?rows=24&cols=80`}
                active={mode === "terminal"}
              />
            </div>
          )}
          {mode === "terminal" && !terminal && (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Starting shell…
            </div>
          )}
          {browserMounted && (
            <div className="h-full" style={{ display: mode === "browser" ? "block" : "none" }}>
              <BrowserPreview instanceId={instanceId} ports={ports} active={mode === "browser"} />
            </div>
          )}
          {filesMounted && (
            <div className="h-full" style={{ display: mode === "files" ? "block" : "none" }}>
              <FileTree instanceId={instanceId} active={mode === "files"} />
            </div>
          )}
          {reviewMounted && (
            <div className="h-full" style={{ display: mode === "review" ? "block" : "none" }}>
              <ReviewPanel instanceId={instanceId} active={mode === "review"} />
            </div>
          )}
          {portsMounted && (
            <div className="h-full" style={{ display: mode === "ports" ? "block" : "none" }}>
              <PortsPanel instanceId={instanceId} active={mode === "ports"} />
            </div>
          )}
        </div>
        <div
          onMouseDown={handleResizeMouseDown}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize panel"
          // Focusable (out of tab order) so the splitter counts as an
          // interactive control. The drag itself stays pointer-driven.
          tabIndex={-1}
          className="absolute top-0 -left-1 z-10 h-full w-2 cursor-col-resize"
        />
      </aside>
    </>
  );
}

// Compact segmented control switching the panel body between the shell and the
// browser preview.
function ModeToggle({
  mode,
  onModeChange,
}: {
  mode: PanelMode;
  onModeChange: (mode: PanelMode) => void;
}) {
  const item = (value: PanelMode, Icon: typeof TerminalIcon, label: string) => (
    <button
      type="button"
      data-demo={`panel-${value}`}
      onClick={() => onModeChange(value)}
      aria-pressed={mode === value}
      className={cn(
        "inline-flex items-center gap-1 rounded px-2 h-6 text-xs transition-colors",
        mode === value
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon className="size-3.5" />
      {label}
    </button>
  );
  return (
    <div className="inline-flex items-center gap-0.5 rounded-md bg-muted/50 p-0.5">
      {item("terminal", TerminalIcon, "Terminal")}
      {item("files", FolderTree, "Files")}
      {item("review", GitPullRequest, "Review")}
      {item("browser", Globe, "Browser")}
      {item("ports", Network, "Ports")}
    </div>
  );
}
