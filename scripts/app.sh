#!/usr/bin/env bash
# Native dev flow: run the real Tauri desktop app with frontend HMR and Rust
# recompile-on-change. Use this (not scripts/dev.sh) when you need the native
# shell the browser can't exercise — the macOS title-bar overlay + traffic
# lights, the list_system_fonts IPC command, the sidecar lifecycle/teardown, and
# the window.__ISOLADE__.port injection.
#
# Unlike dev.sh, we do NOT start a server here: the Tauri app (app/src/lib.rs)
# spawns its own API-server sidecar in debug mode, picks a free port, and injects
# it into the webview. tauri.conf.json's beforeDevCommand starts only Vite.
# Running dev.sh alongside this would bind a second, redundant server — use one
# flow or the other.
#
# The debug sidecar runs under `bun --watch`, so backend edits (server, shared,
# sandbox) hot-reload without restarting the app — like Vite's frontend HMR. Each
# reload tears down running VMs (the sandbox lives in-process), same as dev.sh.
set -euo pipefail

cd "$(dirname "$0")/.." # repo root
source scripts/lib/common.sh

isolade_prepare_sandbox

# Pick a free loopback port for the Vite dev server so several `bun run app`
# instances can run at once without colliding on 5173. Vite reads
# ISOLADE_WEB_PORT (see packages/web/vite.config.ts) and binds it strictly,
# while --config overrides Tauri's static devUrl to the matching URL so the
# webview loads the right server. (Tiny TOCTOU window between picking the port
# here and Vite binding it — negligible for a single-user dev tool; strictPort
# turns a lost race into a loud failure rather than a silent mismatch.)
ISOLADE_WEB_PORT="$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close();});')"
export ISOLADE_WEB_PORT
echo "[isolade] vite dev server on http://localhost:$ISOLADE_WEB_PORT (random; Tauri devUrl overridden to match)"

# Mirror build.sh: run the Tauri CLI from app/ (where tauri.conf.json lives).
# Tauri runs before*Command from app/'s parent (the repo root), so the config's
# repo-root-relative `--cwd packages/web` resolves. Extra args pass through to
# `tauri dev` (e.g. --no-watch to stop restarting on Rust changes).
cd app

# Two dev-only overrides layered onto the static tauri.conf.json:
#   - build.devUrl: point the webview at the random Vite port picked above.
#   - bundle.resources: empty it. The committed config lists release-only build
#     artifacts as bundle resources (the compiled `binaries/Isolade` sidecar and
#     the assembled msb-runtime files), and Tauri's build script validates that
#     every declared resource exists — even under `tauri dev`, which builds no
#     bundle. The sidecar is produced only by build.sh, so on a checkout that
#     hasn't been release-built it's missing and `tauri dev` aborts with
#     "resource path `binaries/Isolade` doesn't exist". Dev never reads these
#     resources anyway: the debug sidecar runs from source (app/src/lib.rs spawns
#     `bun run packages/server/src/index.ts`) and locates msb via the
#     ISOLADE_MSB_BIN_DIR repo path, not the bundled copy. Clearing the list lets
#     `bun run app` work on a clean checkout. (Tauri replaces arrays wholesale on
#     --config merge, so [] drops every entry rather than merging.)
DEV_CONFIG="{\"build\":{\"devUrl\":\"http://localhost:${ISOLADE_WEB_PORT}\"},\"bundle\":{\"resources\":[]}}"
exec bunx tauri dev --config "$DEV_CONFIG" "$@"
