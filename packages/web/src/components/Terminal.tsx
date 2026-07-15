import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { type ITheme, Terminal as XTerm } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import "@xterm/xterm/css/xterm.css";
import { withAuthToken } from "../lib/api";
import { useThemeSetting } from "../lib/settings";
import { openExternal } from "../lib/tauri";

interface TerminalProps {
  wsUrl: string;
  active: boolean;
}

// ANSI palettes from GitHub Primer's prettylights ansi scales, matching the
// GitHub Light / GitHub Dark base themes in index.css (same source as the
// hljs token colors there).
const ANSI_LIGHT = {
  black: "#24292f",
  red: "#cf222e",
  green: "#116329",
  yellow: "#4d2d00",
  blue: "#0969da",
  magenta: "#8250df",
  cyan: "#1b7c83",
  white: "#6e7781",
  brightBlack: "#57606a",
  brightRed: "#a40e26",
  brightGreen: "#1a7f37",
  brightYellow: "#633c01",
  brightBlue: "#218bff",
  brightMagenta: "#a475f9",
  brightCyan: "#3192aa",
  brightWhite: "#8c959f",
} as const;

const ANSI_DARK = {
  black: "#484f58",
  red: "#ff7b72",
  green: "#3fb950",
  yellow: "#d29922",
  blue: "#58a6ff",
  magenta: "#bc8cff",
  cyan: "#39c5cf",
  white: "#b1bac4",
  brightBlack: "#6e7681",
  brightRed: "#ffa198",
  brightGreen: "#56d364",
  brightYellow: "#e3b341",
  brightBlue: "#79c0ff",
  brightMagenta: "#d2a8ff",
  brightCyan: "#56d4dd",
  brightWhite: "#f0f6fc",
} as const;

// xterm's color parser only understands hex/rgb, but theme tokens may hold
// any CSS color (the Extra themes use oklch). Normalize through a canvas
// fillStyle round-trip, which serializes opaque sRGB colors back as #rrggbb.
let colorCtx: CanvasRenderingContext2D | null = null;
function resolveCssColor(value: string, fallback: string): string {
  colorCtx ??= document.createElement("canvas").getContext("2d");
  if (!colorCtx || !value) return fallback;
  colorCtx.fillStyle = fallback;
  colorCtx.fillStyle = value;
  const resolved = colorCtx.fillStyle;
  return typeof resolved === "string" ? resolved : fallback;
}

// Terminal colors derive from the live theme tokens on <html>, so the
// terminal follows Light/Dark/Extra/custom themes like every other surface.
function buildXtermTheme(): ITheme {
  const root = document.documentElement;
  const dark = root.classList.contains("dark");
  const styles = getComputedStyle(root);
  const background = resolveCssColor(
    styles.getPropertyValue("--background").trim(),
    dark ? "#0d1117" : "#f6f8fa",
  );
  const foreground = resolveCssColor(
    styles.getPropertyValue("--foreground").trim(),
    dark ? "#e6edf3" : "#1f2328",
  );
  return {
    // Fully transparent (rgba, not the "transparent" keyword, since xterm's color
    // parser doesn't understand the keyword and falls back to opaque black).
    // The terminal then shows whatever surface it's mounted on: bg-background
    // in the tab strip, the muted panel tint in the terminal sidebar. This
    // also sidesteps the resolveCssColor round-trip, which can't serialize
    // oklch tokens and would otherwise paint a mismatched fixed-hex fallback.
    // Requires allowTransparency on the terminal.
    background: "rgba(0, 0, 0, 0)",
    foreground,
    cursor: foreground,
    // Keep the cursor accent opaque, since it's the glyph color under a block
    // cursor, which would vanish against a transparent background.
    cursorAccent: background,
    // accent.muted at 40%, GitHub's selection wash.
    selectionBackground: dark ? "#388bfd66" : "#54aeff66",
    ...(dark ? ANSI_DARK : ANSI_LIGHT),
  };
}

// xterm's default DOM renderer is slow: every cell is a styled <span>, which
// crawls in the macOS WKWebView the Tauri shell uses. The WebGL renderer draws
// the grid from a glyph texture atlas on the GPU instead, which is dramatically
// faster for streaming agent output. WebKit can drop the GL context for a
// backgrounded (display:none) tab, so we wire onContextLoss to dispose the
// addon (xterm transparently reverts to the DOM renderer) and re-attach when
// the tab becomes active again. Returns the live addon, or null if WebGL is
// unavailable (rare, and we then stay on the DOM renderer). onLost runs after a
// context loss disposes the addon, so the caller can drop its reference and
// re-attach later.
function tryEnableWebgl(term: XTerm, onLost: () => void): WebglAddon | null {
  // The demo recorder forces the DOM renderer: under headed screenshot capture
  // the WebGL canvas renders into a mismatched-DPR buffer (tiny, mispositioned
  // glyphs), while the DOM renderer screenshots crisply at any DPR.
  if (typeof window !== "undefined" && window.__ISOLADE_CAPTURE__?.disableTerminalWebgl)
    return null;
  try {
    const addon = new WebglAddon();
    addon.onContextLoss(() => {
      addon.dispose();
      onLost();
    });
    term.loadAddon(addon);
    return addon;
  } catch (err) {
    console.warn("[terminal] WebGL renderer unavailable, using DOM renderer", err);
    return null;
  }
}

export default function Terminal({ wsUrl, active }: TerminalProps) {
  const isMacLike =
    typeof navigator !== "undefined" &&
    /mac|iphone|ipad/i.test(navigator.userAgentData?.platform ?? navigator.platform ?? "");
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const webglRef = useRef<WebglAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const activeRef = useRef(active);
  const themeId = useThemeSetting();

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  // Re-skin a live terminal when the user switches themes. applyTheme has
  // already written the new tokens onto <html> by the time the listener
  // fires, so reading them here sees the new values.
  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.theme = buildXtermTheme();
  }, [themeId]);

  // Initialize xterm and WebSocket once on mount
  useEffect(() => {
    const term = new XTerm({
      cursorBlink: true,
      fontSize: 11,
      fontFamily: "Menlo, Monaco, 'Courier New', monospace",
      theme: buildXtermTheme(),
      // Lets the transparent theme background show the container surface
      // through, so the terminal matches bg-background in every theme.
      allowTransparency: true,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    // WebLinksAddon's default click handler calls window.open, which no-ops
    // inside the Tauri webview (see lib/tauri). Route clicks through
    // openExternal so terminal URLs reach the system browser under Tauri and
    // still open a new tab in a plain browser.
    term.loadAddon(new WebLinksAddon((_event, uri) => void openExternal(uri)));
    term.open(containerRef.current!);
    // Must run after open(), since the WebGL addon needs the rendered canvas.
    webglRef.current = tryEnableWebgl(term, () => {
      webglRef.current = null;
    });
    fitAddon.fit();
    termRef.current = term;
    fitAddonRef.current = fitAddon;

    // In the Tauri webview talk to the host-injected loopback API port. In a
    // plain browser use the page origin (the Vite dev proxy forwards the WS).
    const apiPort = window.__ISOLADE__?.port;
    const wsHost = apiPort ? `127.0.0.1:${apiPort}` : window.location.host;
    const protocol = apiPort ? "ws:" : window.location.protocol === "https:" ? "wss:" : "ws:";
    // WebSocket can't set an Authorization header, so the bearer token (when the
    // host minted one) rides on the URL as a ?token= param. wsUrl already carries
    // ?rows=&cols=, so withAuthToken appends it.
    const ws = new WebSocket(withAuthToken(`${protocol}//${wsHost}${wsUrl}`));
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    term.write("\x1b[90mConnecting to VM...\x1b[0m\r\n");

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "resize", rows: term.rows, cols: term.cols }));
      term.focus();
    };

    let firstMessage = true;
    ws.onmessage = (event) => {
      if (firstMessage) {
        term.clear();
        firstMessage = false;
      }
      if (event.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(event.data));
      } else {
        term.write(event.data);
      }
    };

    ws.onclose = (event) => {
      if (event.code === 1000 || event.code === 1005) {
        term.write("\r\n\x1b[90m[connection closed]\x1b[0m\r\n");
      } else {
        const detail = event.reason || `code ${event.code}`;
        term.write(`\r\n\x1b[31m[connection failed: ${detail}]\x1b[0m\r\n`);
      }
    };

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });

    term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", rows, cols }));
      }
    });

    const handleWindowResize = () => {
      if (activeRef.current) fitAddon.fit();
    };
    window.addEventListener("resize", handleWindowResize);

    // Refit when the container itself changes size without a window resize,
    // e.g. dragging the sidebar splitter or collapsing the left sidebar.
    const resizeObserver = new ResizeObserver(() => {
      if (activeRef.current) fitAddon.fit();
    });
    resizeObserver.observe(containerRef.current!);

    return () => {
      window.removeEventListener("resize", handleWindowResize);
      resizeObserver.disconnect();
      ws.close();
      // term.dispose() also disposes loaded addons (including WebGL).
      webglRef.current = null;
      term.dispose();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync terminal size when becoming active (container is visible by now)
  useEffect(() => {
    if (!active) return;
    const term = termRef.current;
    const fitAddon = fitAddonRef.current;
    const ws = wsRef.current;
    if (!term || !fitAddon || !ws) return;
    // Re-attach the GPU renderer if WebKit dropped its context while this tab
    // was backgrounded (display:none), otherwise it would limp along on the
    // slow DOM fallback after the first tab switch.
    if (!webglRef.current) {
      webglRef.current = tryEnableWebgl(term, () => {
        webglRef.current = null;
      });
    }
    fitAddon.fit();
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "resize", rows: term.rows, cols: term.cols }));
      term.focus();
    }
  }, [active]);

  return (
    <div className="h-full w-full pl-3">
      <div
        ref={containerRef}
        className={`terminal-shell h-full w-full${isMacLike ? " terminal-shell--mac" : ""}`}
      />
    </div>
  );
}
