// Pins NAPI_RS_NATIVE_LIBRARY_PATH so microsandbox's loader resolves the right
// platform `.node`. Kept free of any native import so it can run during the
// earliest bootstrap, before the SDK is loaded. Used by both the standalone
// sandbox entry (./main.ts) and the merged isolade entry
// (packages/server/src/index.ts).

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

function candidateNames(): string[] {
  const p = process.platform;
  const a = process.arch;
  if (p === "darwin" && a === "arm64") return ["microsandbox.darwin-arm64.node"];
  if (p === "darwin" && a === "x64") return ["microsandbox.darwin-x64.node"];
  if (p === "linux" && a === "x64")
    return ["microsandbox.linux-x64-gnu.node", "microsandbox.linux-x64-musl.node"];
  if (p === "linux" && a === "arm64")
    return ["microsandbox.linux-arm64-gnu.node", "microsandbox.linux-arm64-musl.node"];
  return [];
}

// Set the NAPI library path BEFORE microsandbox is loaded so the binding
// resolves to the intended `.node`. `bun build --compile` doesn't embed napi-rs
// platform packages, so the `.node` ships separately and this var preempts the
// normal resolution. In a Tauri release build lib.rs sets it to the bundled
// runtime. The fallback here covers a compiled sidecar run standalone (a
// sibling `.node`). In dev it stays unset and resolves via node_modules. This
// is idempotent. A value already present (e.g. from lib.rs) wins and is left
// untouched.
export function pinNapiLibraryPath(): void {
  if (process.env.NAPI_RS_NATIVE_LIBRARY_PATH) return;
  const dir = dirname(process.execPath);
  for (const name of candidateNames()) {
    const path = join(dir, name);
    if (existsSync(path)) {
      process.env.NAPI_RS_NATIVE_LIBRARY_PATH = path;
      return;
    }
  }
}
