#!/usr/bin/env bash
# Local Linux release pipeline: install deps -> build the .deb. GitHub Actions
# runs this on both x86_64 and arm64 Linux runners; locally it packages for the
# host architecture.
#
# Local prerequisites: bun (the Tauri CLI is a bun devDependency, run via
# `bunx tauri`), the rust toolchain, a
# pinned microsandbox submodule (native .node/msb/libkrunfw source for
# scripts/lib/assemble-msb-runtime.sh; override with ISOLADE_MICROSANDBOX_DIR), and
# the Tauri Linux system deps:
# libwebkit2gtk-4.1-dev, libxdo-dev, libssl-dev,
# libayatana-appindicator3-dev, librsvg2-dev, and build tools.
set -euo pipefail

cd "$(dirname "$0")/.." # repo root

case "${ISOLADE_LINUX_ARCH:-$(uname -m)}" in
  x86_64 | amd64 | x64) DIST_ARCH=amd64 ;;
  aarch64 | arm64) DIST_ARCH=arm64 ;;
  *)
    echo "unsupported Linux architecture: ${ISOLADE_LINUX_ARCH:-$(uname -m)}" >&2
    exit 1
    ;;
esac

VERSION="$(grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]+"' app/tauri.conf.json | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+[^"]*' || true)"
[ -n "$VERSION" ] || {
  echo "could not read the app version from app/tauri.conf.json" >&2
  exit 1
}

# microsandbox is a pinned npm dependency now, so the lockfile is authoritative —
# fail fast if package.json and bun.lock disagree instead of silently resolving.
echo "==> Installing dependencies..."
bun install --frozen-lockfile

# Build a .deb. --bundles overrides tauri.conf's macOS-only ["app"] target;
# apt resolves the WebKitGTK/GTK runtime deps the package declares.
scripts/build.sh --bundles deb

# Publish under a self-describing release asset name. apt still reads the
# authoritative package name/version from inside the .deb.
DEB="$(find app/target/release/bundle/deb -maxdepth 1 -name '*.deb' -print -quit)"
if [ -z "$DEB" ]; then
  echo "no .deb produced under app/target/release/bundle/deb/" >&2
  exit 1
fi
OUT="dist/isolade-v${VERSION}-linux-${DIST_ARCH}.deb"

echo "==> Packaging ${OUT}..."
mkdir -p dist
cp "$DEB" "$OUT"

# Repack the same payload as a plain tarball, for the distributions apt does not
# serve. rpm and AppImage would each solve part of this, and neither covers
# everything: an rpm needs its own dependency names per distribution, and an
# AppImage is built against the runner's glibc. The payload is relocatable as it
# stands, because Tauri resolves bundled resources relative to the executable, so
# `bin/Isolade` plus `lib/Isolade/` runs from any prefix.
#
# The two libraries the .deb declares (WebKitGTK and GTK) stay the user's to
# install, which install.sh checks for and names per package manager.
TAR_OUT="dist/isolade-v${VERSION}-linux-${DIST_ARCH}.tar.gz"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

echo "==> Packaging ${TAR_OUT}..."
dpkg-deb -x "$DEB" "$STAGE/payload"
# One top-level directory, so extracting into /opt yields /opt/isolade.
mkdir -p "$STAGE/isolade"
mv "$STAGE/payload/usr/bin" "$STAGE/isolade/bin"
mv "$STAGE/payload/usr/lib" "$STAGE/isolade/lib"
# The desktop entry ships alongside rather than pre-installed, since where it
# belongs depends on whether the install is for one user or the machine.
mv "$STAGE/payload/usr/share/applications/Isolade.desktop" "$STAGE/isolade/"
if [ -d "$STAGE/payload/usr/share/icons" ]; then
  mv "$STAGE/payload/usr/share/icons" "$STAGE/isolade/icons"
fi
tar -C "$STAGE" -czf "$TAR_OUT" isolade

echo ""
echo "Done."
echo "  deb:     ${OUT}"
echo "  install: sudo apt install ./${OUT##*/}"
echo "  tarball: ${TAR_OUT}"
