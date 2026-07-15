#!/usr/bin/env bash
# Assemble the "complete corresponding source" for the GPL/LGPL components that
# ship inside an isolade release, as required by GPL-2.0 §3 and LGPL-2.1.
#
# isolade bundles a prebuilt libkrunfw shared library (an LGPL-2.1 wrapper around
# an embedded, patched Linux kernel — the kernel is GPL-2.0-only) and links the
# libkrun crate (msb_krun, LGPL-2.1) into the msb supervisor. Distributing those
# binaries obliges us to make their corresponding source available. We satisfy
# GPL-2.0 §3(a) / LGPL-2.1 by *accompanying* the release with this tarball: it is
# uploaded as a release asset next to the binaries, so anyone who obtains a build
# from the GitHub release (directly, or via the isolade.com/download redirect that the
# installer follows) has equivalent access to the source from the same place.
#
# What "corresponding source" means here, and why each piece is included:
#   * libkrunfw/          the vendored libkrunfw tree at the pinned submodule
#                         commit — its Makefile, kernel .config files, the GPL-2.0
#                         kernel patches, and build scripts. This is what turns a
#                         pristine kernel into the blob we ship.
#   * linux-<ver>.tar.xz  the pristine upstream kernel source libkrunfw compiles
#                         (fetched at build time, never vendored). Pristine
#                         tarball + patches + config + scripts is the standard,
#                         reproducible form of kernel corresponding source.
#   * libkrun-<sha>.tar.gz  the libkrun fork at the exact commit msb links (read
#                         from the submodule Cargo.lock, not the moving branch).
#
# The pieces are self-describing: the tarball filenames encode the kernel version
# and libkrun commit, libkrunfw/Makefile pins the kernel version, and each tree
# carries its own build scripts and license texts. No manifest/claims are added —
# the compliance act is shipping the source, not declaring it.
#
# Usage: collect-corresponding-source.sh OUT_TARBALL [VERSION]
#   OUT_TARBALL  path to write, e.g. dist/isolade-v0.3.0-third-party-source.tar.gz
#   VERSION      release version X.Y.Z; defaults to app/tauri.conf.json's version.
#
# Large downloads (the ~140 MB kernel tarball, the libkrun snapshot) are cached
# under dist/corresponding-source-cache/ and reused across runs, so re-running is
# cheap and offline-friendly once primed.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

OUT="${1:?usage: collect-corresponding-source.sh OUT_TARBALL [VERSION]}"
FORK="${ISOLADE_MICROSANDBOX_DIR:-$REPO_ROOT/third_party/microsandbox}"
LIBKRUNFW="$FORK/vendor/libkrunfw"
CACHE="$REPO_ROOT/dist/corresponding-source-cache"

[ -f "$LIBKRUNFW/Makefile" ] || {
  echo "error: vendored libkrunfw source metadata not found at $LIBKRUNFW/Makefile" >&2
  echo "       Run 'git submodule update --init --recursive third_party/microsandbox'." >&2
  exit 1
}

# --- version (for asset naming + the manifest) --------------------------------
VERSION="${2:-}"
if [ -z "$VERSION" ]; then
  VERSION="$(grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]+"' app/tauri.conf.json | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+[^"]*')"
fi
[ -n "$VERSION" ] || { echo "error: could not determine version" >&2; exit 1; }

# --- kernel: read the exact version + upstream URL the build uses -------------
# Expand $(KERNEL_VERSION) in KERNEL_REMOTE ourselves so we fetch precisely what
# libkrunfw's Makefile would, without invoking make.
KERNEL_VERSION="$(grep -E '^KERNEL_VERSION' "$LIBKRUNFW/Makefile" | head -1 | sed 's/.*=[[:space:]]*//;s/[[:space:]]*$//')"
KERNEL_REMOTE="$(grep -E '^KERNEL_REMOTE' "$LIBKRUNFW/Makefile" | head -1 | sed 's/.*=[[:space:]]*//;s/[[:space:]]*$//')"
KERNEL_REMOTE="${KERNEL_REMOTE//\$(KERNEL_VERSION)/$KERNEL_VERSION}"
[ -n "$KERNEL_VERSION" ] && [ -n "$KERNEL_REMOTE" ] || {
  echo "error: could not read KERNEL_VERSION/KERNEL_REMOTE from $LIBKRUNFW/Makefile" >&2
  exit 1
}

# --- libkrun: the exact commit msb links (from the submodule Cargo.lock) ------
# The source line looks like: git+https://github.com/OWNER/libkrun?branch=...#<sha>
KRUN_SRC_LINE="$(grep -m1 -E 'source = "git\+https://[^"]*libkrun[^"]*#' "$FORK/Cargo.lock" || true)"
[ -n "$KRUN_SRC_LINE" ] || { echo "error: no libkrun git source found in $FORK/Cargo.lock" >&2; exit 1; }
KRUN_URL="$(printf '%s' "$KRUN_SRC_LINE" | sed -E 's/.*"git\+([^?#"]+).*/\1/')"      # https://github.com/OWNER/libkrun
KRUN_SHA="$(printf '%s' "$KRUN_SRC_LINE" | sed -E 's/.*#([0-9a-f]+)".*/\1/')"        # full commit sha
KRUN_SLUG="$(printf '%s' "$KRUN_URL" | sed -E 's#^https?://github.com/##;s/\.git$//')" # OWNER/libkrun
[ -n "$KRUN_SHA" ] && [ -n "$KRUN_SLUG" ] || { echo "error: could not parse libkrun url/sha from Cargo.lock" >&2; exit 1; }

echo "==> Collecting corresponding source for v$VERSION"
echo "    kernel:  $KERNEL_VERSION  ($KERNEL_REMOTE)"
echo "    libkrun: $KRUN_SLUG @ $KRUN_SHA"

# --- fetch (cached) -----------------------------------------------------------
mkdir -p "$CACHE"
KERNEL_TARBALL="$CACHE/${KERNEL_VERSION}.tar.xz"
KRUN_TARBALL="$CACHE/libkrun-${KRUN_SHA}.tar.gz"

fetch() { # fetch URL DEST — download unless already cached
  local url="$1" dest="$2"
  if [ -s "$dest" ]; then echo "    cached: $(basename "$dest")"; return; fi
  echo "    fetch:  $(basename "$dest")"
  curl -fsSL --retry 3 -o "$dest.part" "$url" && mv "$dest.part" "$dest"
}
fetch "$KERNEL_REMOTE" "$KERNEL_TARBALL"
# GitHub serves a pristine snapshot tarball for any commit at /archive/<sha>.tar.gz
fetch "https://github.com/$KRUN_SLUG/archive/$KRUN_SHA.tar.gz" "$KRUN_TARBALL"

# --- stage --------------------------------------------------------------------
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
ROOT="$STAGE/isolade-v$VERSION-third-party-source"
mkdir -p "$ROOT"

# libkrunfw source (committed files only; drop any local download/build output).
cp -R "$LIBKRUNFW" "$ROOT/libkrunfw"
rm -rf "$ROOT/libkrunfw/tarballs" "$ROOT"/libkrunfw/linux-* "$ROOT/libkrunfw/build"

cp "$KERNEL_TARBALL" "$ROOT/${KERNEL_VERSION}.tar.xz"
cp "$KRUN_TARBALL"   "$ROOT/libkrun-${KRUN_SHA}.tar.gz"

# --- pack ---------------------------------------------------------------------
mkdir -p "$(dirname "$OUT")"
tar -C "$STAGE" -czf "$OUT" "isolade-v$VERSION-third-party-source"

echo "==> Wrote $OUT ($(du -h "$OUT" | cut -f1))"
