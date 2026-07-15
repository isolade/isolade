#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.." # repo root

# The compiled server sidecar. It's bundled as a Tauri *resource* (not an
# externalBin), so it needs no target-triple suffix and lands in
# Contents/Resources/binaries/ instead of Contents/MacOS/. That frees the
# MacOS/Isolade name for the main app binary while letting the sidecar keep the
# "Isolade" name too — see app/tauri.conf.json and app/src/lib.rs.
SIDECAR="app/binaries/Isolade"

# macOS code signing. We re-sign the app + sidecar with a *stable* self-signed
# identity in place of the linker's ad-hoc signature, so macOS privacy prompts
# (local network, "access data from other apps") attribute to "Isolade" instead
# of the cargo crate name ("app") and keep that attribution — and any prior
# grant — stable across rebuilds instead of treating each build as a new app.
# This is NOT about the Keychain: secret values now live in on-disk per-profile
# files, not the login keychain (packages/server/src/secrets-store.ts). See
# scripts/create-signing-cert.sh for the full why.
# Prepare the identity up front so the build fails fast if it's missing. Set
# ISOLADE_SKIP_SIGNING=1 to opt out and fall back to ad-hoc.
SIGNING_IDENTITY="${ISOLADE_SIGNING_IDENTITY:-Isolade}"
if [ "$(uname -s)" = Darwin ] && [ -z "${ISOLADE_SKIP_SIGNING:-}" ]; then
  echo "==> Preparing code-signing identity '$SIGNING_IDENTITY'..."
  scripts/lib/setup-signing-keychain.sh
  if ! security find-identity -p codesigning | grep -qF "$SIGNING_IDENTITY"; then
    echo "error: code-signing identity '$SIGNING_IDENTITY' unavailable after setup." >&2
    echo "       Run scripts/create-signing-cert.sh, or set ISOLADE_SKIP_SIGNING=1 to" >&2
    echo "       build with an ad-hoc signature (privacy prompts will read 'app' and" >&2
    echo "       re-prompt on each rebuild)." >&2
    exit 1
  fi
fi

# `bun build --compile` bundles without type-checking, so a type error would
# silently ride into the release binary. Gate the build on a full typecheck.
echo "==> Typechecking..."
bun run typecheck

echo "==> Compiling isolade sidecar binary..."
mkdir -p app/binaries
# index.ts is the unified entry: it pins the isolated MSB_HOME, loads the
# microsandbox SDK via NAPI_RS_NATIVE_LIBRARY_PATH (set by lib.rs to the bundled
# runtime's .node), and runs the API server with the sandbox runtime embedded —
# a single sidecar, no separate sandbox process.
bun build --compile packages/server/src/index.ts --outfile "$SIDECAR"

# Assemble the self-contained microsandbox runtime (native .node + signed,
# hypervisor-entitled msb + libkrunfw) from the fork. Tauri bundles
# app/binaries/msb-runtime/** as a resource; lib.rs points the release sidecar
# at it via NAPI_RS_NATIVE_LIBRARY_PATH + ISOLADE_MSB_BIN_DIR.
echo "==> Assembling microsandbox runtime..."
scripts/lib/assemble-msb-runtime.sh app/binaries/msb-runtime

# Generate the third-party attribution notice into the web bundle's public dir,
# BEFORE the Tauri build runs the web build (beforeBuildCommand). Vite copies
# public/ verbatim, so it ships inside the .app/.deb and Settings → About can
# fetch it. --require-rust makes a missing Rust toolchain a hard error here (this
# build needs cargo anyway), so a release never ships without crate attributions.
echo "==> Generating third-party license notice..."
bun run scripts/lib/generate-third-party-licenses.ts \
  packages/web/public/THIRD-PARTY-LICENSES.txt --require-rust

echo "==> Building Tauri app..."
cd app
# Forward any extra args to the bundler — e.g. `--bundles deb` on Linux, which
# overrides tauri.conf's macOS-only ["app"] target. No args = use the config.
# Note: a local build reports "<version>+dev" to the update check and lands in
# the dev bucket of the version stats. Only the release build compiles with
# ISOLADE_OFFICIAL_BUILD set to produce an official build — see app/src/lib.rs
# and .github/workflows/ci.yml.
bunx tauri build "$@"

# Re-sign the bundle's nested binaries and then re-seal the outer .app with our
# stable self-signed identity. Tauri copies resources verbatim and leaves the
# main binary on the linker's automatic ad-hoc signature, so we fix up the
# load-bearing pieces here: the hypervisor-entitled msb, the network-facing
# sidecar, and finally the bundle itself. The app installs via `curl | tar` (no
# quarantine xattr, Gatekeeper bypassed), so a self-signed, non-notarized
# identity runs fine — its value is a *stable* code-signing identity, which is
# what keeps macOS privacy prompts reading "Isolade" and their grants valid
# across rebuilds. Order matters: sign nested binaries first, seal the bundle last.
if [ "$(uname -s)" = Darwin ]; then
  APP="target/release/bundle/macos/Isolade.app"

  # Re-sign the Bun sidecar with the stable identity (plain signing, no hardened
  # runtime — that would break the JIT in the Bun-compiled binary), replacing
  # Tauri's ad-hoc signature. The sidecar is a separate, network-facing process
  # (it binds the loopback API and the registry's LAN bridge listener), so a
  # stable identity — rather than Bun's ad-hoc, per-build cdhash — keeps any macOS
  # privacy prompt it triggers attributed to "Isolade" with a grant that survives
  # rebuilds, same as the outer app. It no longer touches the Keychain (secrets
  # are on-disk files now), so this is not about secret ACLs. Explicit
  # --identifier keeps the signed identifier (part of the designated requirement)
  # stable regardless of what Bun embeds. The sidecar bundles as a resource, so it
  # sits under Contents/Resources/binaries/ (not Contents/MacOS/) — re-assert the
  # exec bit first, since Tauri's resource copy can drop it.
  SIDECAR_IN_APP="$APP/Contents/Resources/binaries/Isolade"
  chmod +x "$SIDECAR_IN_APP"
  if [ -z "${ISOLADE_SKIP_SIGNING:-}" ]; then
    echo "==> Signing sidecar with '$SIGNING_IDENTITY'..."
    codesign --force --identifier dev.isolade.server -s "$SIGNING_IDENTITY" \
      "$SIDECAR_IN_APP"
  fi

  MSB_IN_APP=$(find "$APP/Contents/Resources" -type f -path "*msb-runtime/bin/msb" 2>/dev/null | head -1)
  if [ -n "$MSB_IN_APP" ]; then
    chmod +x "$MSB_IN_APP"
    if ! codesign --verify "$MSB_IN_APP" 2>/dev/null; then
      echo "==> Re-signing bundled msb..."
      codesign --entitlements "$FORK/msb-entitlements.plist" --force -s - "$MSB_IN_APP"
    fi
  else
    echo "warning: bundled msb not found under $APP/Contents/Resources" >&2
  fi

  # Re-seal the outer .app with the stable identity, LAST so it captures the
  # signatures applied above. This replaces the linker's automatic ad-hoc
  # signature on the main binary, whose identifier is derived from the cargo
  # crate name ("app-<hash>"). macOS privacy prompts — e.g. local network /
  # "access data from other apps" — key off the code-signing identity, not the
  # filename or CFBundleDisplayName, so without this the prompt reads "app" even
  # though the executable and display name are both "Isolade". No --deep (keeps
  # the sidecar/msb signatures distinct) and no hardened runtime (parity with the
  # old ad-hoc build; hardened runtime would break the webview's JIT).
  # --identifier pins it to the bundle id so the designated requirement is stable.
  if [ -z "${ISOLADE_SKIP_SIGNING:-}" ]; then
    echo "==> Signing app bundle with '$SIGNING_IDENTITY'..."
    codesign --force --identifier dev.isolade -s "$SIGNING_IDENTITY" "$APP"
  fi
fi

echo ""
echo "Done. Output under target/release/bundle/ (.app on macOS; .deb with --bundles deb)."
