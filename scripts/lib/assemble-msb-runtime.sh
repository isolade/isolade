#!/usr/bin/env bash
# Assemble a self-contained microsandbox runtime from the isolade fork of
# microsandbox into DEST, in the layout microsandbox's own path resolution
# expects:
#
#   DEST/
#     microsandbox.<platform>.node   # NAPI binding (loaded via NAPI_RS_NATIVE_LIBRARY_PATH)
#     bin/msb                        # statically-linked supervisor/CLI, signed (macOS)
#     lib/libkrunfw.5.dylib          # firmware blob, dlopen'd by msb via <bin>/../lib
#
# This is the single source of truth for both run modes:
#   * release  — build.sh assembles into app/binaries/msb-runtime, which Tauri
#                bundles into the .app; lib.rs points the sidecar at it.
#   * dev      — dev.sh assembles into app/binaries/msb-runtime (ISOLADE_MSB_RUNTIME),
#                the same gitignored artifact release bundles from.
#
# Why a fork-built msb (not the published @superradcompany platform package):
# isolade runs a fork of microsandbox, so the bundled msb must come from the
# same source as the SDK's native .node. We take both from the pinned submodule
# checkout.
# libkrunfw is an unforked prebuilt blob, so any matching-ABI copy works.
#
# Source of the fork: $ISOLADE_MICROSANDBOX_DIR, else the pinned submodule at
# third_party/microsandbox.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEST="${1:?usage: assemble-msb-runtime.sh DEST}"
FORK="${ISOLADE_MICROSANDBOX_DIR:-$REPO_ROOT/third_party/microsandbox}"

[ -d "$FORK/sdk/node-ts" ] || {
  echo "error: microsandbox checkout not found at $FORK" >&2
  echo "       Run 'git submodule update --init third_party/microsandbox'," >&2
  echo "       or set ISOLADE_MICROSANDBOX_DIR=/path/to/microsandbox." >&2
  exit 1
}

# --- platform detection -------------------------------------------------------
case "$(uname -s)" in
  Darwin) OS=darwin ;;
  Linux)  OS=linux ;;
  *) echo "error: unsupported OS $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64)        ARCH=x64 ;;
  *) echo "error: unsupported arch $(uname -m)" >&2; exit 1 ;;
esac

# --- locate the three inputs in the fork --------------------------------------
# pick_first PATTERN... -> first existing path, or empty
pick_first() { for p in "$@"; do [ -e "$p" ] && { echo "$p"; return; }; done; }

# napi names the artifact <binaryName>.<platform>-<arch>[-<abi>].node: macOS has
# no abi suffix; Linux glibc builds get "-gnu" (musl "-musl"). Match whichever the
# fork produced instead of hardcoding, so it resolves on both.
NODE_SRC="$(pick_first \
  "$FORK/sdk/node-ts/native/microsandbox.${OS}-${ARCH}.node" \
  "$FORK/sdk/node-ts/native/microsandbox.${OS}-${ARCH}-gnu.node" \
  "$FORK/sdk/node-ts/native/microsandbox.${OS}-${ARCH}-musl.node")"
[ -n "$NODE_SRC" ] || { echo "error: microsandbox native binding missing under $FORK/sdk/node-ts/native/ (run 'bun run bootstrap:microsandbox')" >&2; exit 1; }
NODE_NAME="$(basename "$NODE_SRC")"

# Build msb from the fork so it always matches the SDK's native binding (both
# compile from the same crates) — the whole reason we don't use the published
# platform package. Skipped when ISOLADE_SKIP_MSB_BUILD is set (e.g. the release
# CI built and cached it in the provision step). Build flags live in build-msb.sh.
if [ -z "${ISOLADE_SKIP_MSB_BUILD:-}" ]; then
  "$(dirname "$0")/build-msb.sh"
fi

# Prefer the freshest cargo output; fall back to the fork's `just build` output.
MSB_SRC="$(pick_first "$FORK/target/release/msb" "$FORK/target/${ARCH}-apple-darwin/release/msb" "$FORK/build/msb")"
[ -n "$MSB_SRC" ] || { echo "error: no msb binary in microsandbox checkout (run 'bun run bootstrap:microsandbox')" >&2; exit 1; }

# libkrunfw is unforked; take whatever matching-ABI copy the fork has on hand.
if [ "$OS" = darwin ]; then KRUN_GLOB="libkrunfw.*.dylib"; else KRUN_GLOB="libkrunfw.so.*"; fi
KRUN_SRC="$(pick_first \
  "$FORK"/build/$KRUN_GLOB \
  "$FORK"/sdk/node-ts/node_modules/@superradcompany/microsandbox-${OS}-${ARCH}/lib/$KRUN_GLOB \
  "$FORK"/sdk/node-ts/node_modules/@superradcompany/microsandbox-*/lib/$KRUN_GLOB)"
[ -n "$KRUN_SRC" ] || { echo "error: no libkrunfw found in microsandbox checkout (run 'bun run bootstrap:microsandbox')" >&2; exit 1; }

# Official-build guard: libkrunfw is a prebuilt blob (an LGPL-2.1 wrapper around
# an embedded, GPL-2.0 Linux kernel), and official releases ship a corresponding
# source archive built from vendor/libkrunfw. Assert that the bundled blob embeds
# the same kernel version pinned by that source tree. Local builds skip this
# entirely so they don't require the recursive libkrunfw source submodule.
if [ -n "${ISOLADE_OFFICIAL_BUILD:-}" ]; then
  KERNEL_MAKEFILE="$FORK/vendor/libkrunfw/Makefile"
  [ -f "$KERNEL_MAKEFILE" ] || {
    echo "error: official build requires libkrunfw source metadata at $KERNEL_MAKEFILE" >&2
    echo "       Run 'git submodule update --init --recursive third_party/microsandbox'." >&2
    exit 1
  }
  KERNEL_EXPECTED="$(awk -F= '
    /^KERNEL_VERSION/ {
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", $2)
      sub(/^linux-/, "", $2)
      print $2
      exit
    }
  ' "$KERNEL_MAKEFILE")"
  [ -n "$KERNEL_EXPECTED" ] || {
    echo "error: could not read KERNEL_VERSION from $KERNEL_MAKEFILE" >&2
    exit 1
  }
  KERNEL_FOUND="$(grep -a -o 'Linux version [0-9][0-9.]*' "$KRUN_SRC" 2>/dev/null | head -1 | sed 's/Linux version //')"
  if [ -z "$KERNEL_FOUND" ]; then
    echo "error: could not read a kernel version from $KRUN_SRC" >&2
    exit 1
  elif [ "$KERNEL_FOUND" != "$KERNEL_EXPECTED" ]; then
    echo "error: libkrunfw embeds kernel $KERNEL_FOUND but vendor/libkrunfw/Makefile pins linux-$KERNEL_EXPECTED." >&2
    echo "       The prebuilt blob and our corresponding-source/license notices would disagree." >&2
    echo "       Re-sync third_party/microsandbox with the libkrunfw blob it ships." >&2
    exit 1
  else
    echo "libkrunfw kernel version verified: $KERNEL_FOUND (matches pinned linux-$KERNEL_EXPECTED)"
  fi
fi

# --- assemble -----------------------------------------------------------------
rm -rf "$DEST"
mkdir -p "$DEST/bin" "$DEST/lib"

install -m644 "$NODE_SRC" "$DEST/$NODE_NAME"
install -m755 "$MSB_SRC"  "$DEST/bin/msb"
install -m644 "$KRUN_SRC" "$DEST/lib/$(basename "$KRUN_SRC")"

# Sign msb with the hypervisor entitlements (macOS only). Without these,
# Hypervisor.framework refuses the binary and no VM boots. Re-signing is
# idempotent and guarantees the entitlements regardless of the source's state.
if [ "$OS" = darwin ]; then
  ENT="$FORK/msb-entitlements.plist"
  [ -f "$ENT" ] || { echo "error: entitlements plist missing: $ENT" >&2; exit 1; }
  codesign --entitlements "$ENT" --force -s - "$DEST/bin/msb"
  codesign --verify --verbose "$DEST/bin/msb" >/dev/null 2>&1 || { echo "error: msb failed signature verification" >&2; exit 1; }
fi

echo "assembled msb runtime -> $DEST"
echo "  node:     $NODE_NAME  (from $NODE_SRC)"
echo "  msb:      bin/msb     (from $MSB_SRC$([ "$OS" = darwin ] && echo ', signed w/ hypervisor entitlements'))"
echo "  libkrunfw: lib/$(basename "$KRUN_SRC")  (from $KRUN_SRC)"
