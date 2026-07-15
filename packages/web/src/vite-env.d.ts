declare module "*.css";
declare module "*.svg" {
  const src: string;
  export default src;
}

interface NavigatorUAData {
  platform?: string;
}

interface Navigator {
  userAgentData?: NavigatorUAData;
}

interface Screen {
  availLeft?: number;
  availTop?: number;
}

interface Window {
  __TAURI__?: unknown;
  __TAURI_INTERNALS__?: unknown;
  // Injected by the Tauri host (app/src/lib.rs) before page load: the loopback
  // port the isolade API server bound to this launch, the per-launch bearer
  // token every API request must present, and whether the host is on macOS Tahoe
  // (26+), whose larger, wider-spaced native window controls the title bar sizes
  // its layout to match. Absent in a plain browser, where requests go same-origin
  // (and the Vite dev proxy handles /api) against a tokenless server. See
  // packages/web/src/lib/api.ts.
  __ISOLADE__?: { port: number; token: string; tahoe: boolean };
  // Capture-time override set by the demo recorder (the isolade-demo repo).
  // Unset in normal use. `disableTerminalWebgl` forces xterm's DOM renderer: the
  // WebGL canvas renders into a mismatched-DPR backing buffer under headed
  // screenshot capture (tiny, mispositioned glyphs), whereas the DOM renderer
  // screenshots crisply and DPR-consistently at any DPR.
  __ISOLADE_CAPTURE__?: { disableTerminalWebgl?: boolean };
}
