#!/usr/bin/env bash
# Full macOS release pipeline: install deps -> build the .app -> package a
# curl-installable tarball. Runs identically locally and in GitHub Actions; the
# workflow only adds runner toolchain setup, then calls this same script.
#
# Local prerequisites (already present on a dev Mac): bun (the Tauri CLI is a bun
# devDependency, run via `bunx tauri`), the rust toolchain, and the pinned
# microsandbox submodule (the native .node/msb/libkrunfw source for
# scripts/lib/assemble-msb-runtime.sh; override with ISOLADE_MICROSANDBOX_DIR).
set -euo pipefail

cd "$(dirname "$0")/.." # repo root

VERSION="$(grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]+"' app/tauri.conf.json | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+[^"]*' || true)"
[ -n "$VERSION" ] || {
  echo "could not read the app version from app/tauri.conf.json" >&2
  exit 1
}

# microsandbox is a pinned npm dependency now, so the lockfile is authoritative —
# fail fast if package.json and bun.lock disagree instead of silently resolving.
echo "==> Installing dependencies..."
bun install --frozen-lockfile

# Build the .app: typecheck -> compile bun sidecars -> copy NAPI binary ->
# tauri build. Output lands in app/target/release/bundle/macos/.
scripts/build.sh

# Package the bundle into a tarball with CLI tar so nothing acquires a
# com.apple.quarantine xattr. A `curl | tar` install then bypasses Gatekeeper,
# and build.sh has already sealed the bundle with our own signing identity, so it
# executes without Developer ID signing or notarization.
#
# README.txt rides along for whoever downloads this in a browser instead, which
# does quarantine it: an extracted Isolade.app then refuses to launch as
# "damaged", and the file is the only place left to say why and what clears it.
# The installer extracts the Isolade.app member by name so this never lands in
# /Applications (see install.sh on the website).
APP_DIR="app/target/release/bundle/macos"
OUT="dist/isolade-v${VERSION}-macos-arm64.tar.gz"

echo "==> Packaging ${OUT}..."
mkdir -p dist
cp scripts/lib/macos-tarball-readme.txt "$APP_DIR/README.txt"
tar -C "$APP_DIR" -czf "$OUT" Isolade.app README.txt

echo ""
echo "Done."
echo "  tarball: ${OUT}"
echo "  install: curl -L <url> | tar -xz -C /Applications"
