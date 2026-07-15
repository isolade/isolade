#!/usr/bin/env bash
# Generate the app icon set from the single tracked source, app/icons/icon.svg.
#
# Only the SVG is committed (see app/.gitignore); every raster icon Tauri bundles
# is derived here so the artwork has one source of truth and generated binaries
# stay out of git. `tauri icon` (the Tauri CLI, already a devDependency)
# rasterizes the SVG with its own bundled renderer, so this needs no system tools
# (iconutil / rsvg-convert) and runs identically on macOS and Linux CI. It emits
# the whole set: the macOS icon.icns referenced by app/tauri.conf.json, plus the
# Windows .ico, Linux PNGs, and the mobile icon folders.
#
# Wired into Tauri's before{Dev,Build}Command (app/tauri.conf.json) as
# `bun run gen:icons`, so a clean checkout materializes the icons before any
# `tauri dev` / `tauri build` reads them.
set -euo pipefail

cd "$(dirname "$0")/../.." # repo root

SVG="app/icons/icon.svg"
ICNS="app/icons/icon.icns"

if [ ! -f "$SVG" ]; then
  echo "error: icon source $SVG not found" >&2
  exit 1
fi

# Idempotent: skip when the set is already current, so `tauri dev` startups don't
# re-rasterize on every launch. Gate on the icns — it's the load-bearing output
# (the only icon app/tauri.conf.json references); if it's newer than the SVG the
# rest of the set is too, since they're written together.
if [ -f "$ICNS" ] && [ "$ICNS" -nt "$SVG" ]; then
  echo "==> App icons up to date ($ICNS newer than $SVG); skipping."
  exit 0
fi

echo "==> Generating app icons from $SVG..."
bunx tauri icon "$SVG" -o app/icons
