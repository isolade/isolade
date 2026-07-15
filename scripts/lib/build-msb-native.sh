#!/usr/bin/env bash
# Build the fork's microsandbox NAPI binding (-> $FORK/sdk/node-ts/native/*.node).
#
# This is the native piece that carries our patches and isn't published to npm,
# so both local bootstrap (scripts/bootstrap-microsandbox.sh) and the CI
# provisioning (.github/actions/microsandbox) build it the same way — keeping the
# fragile package-lock workaround in exactly one place. Source of the fork:
# $ISOLADE_MICROSANDBOX_DIR, else the pinned submodule at third_party/microsandbox.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FORK="${ISOLADE_MICROSANDBOX_DIR:-$REPO_ROOT/third_party/microsandbox}"
[ -d "$FORK/sdk/node-ts" ] || {
  echo "error: microsandbox checkout not found at $FORK" >&2
  echo "       Run 'git submodule update --init third_party/microsandbox'," >&2
  echo "       or set ISOLADE_MICROSANDBOX_DIR=/path/to/microsandbox." >&2
  exit 1
}

echo "==> Building microsandbox native binding from $FORK"
(
  cd "$FORK/sdk/node-ts"

  # The fork's package-lock trips Bun's npm-lockfile migration for the
  # @superradcompany platform packages that carry libkrunfw. Hide it during
  # install, then restore it so the submodule stays clean for contributors
  # editing it in place.
  restore_lock() {
    [ ! -f package-lock.json.isolade-tmp ] || mv package-lock.json.isolade-tmp package-lock.json
  }
  trap restore_lock EXIT
  [ ! -f package-lock.json ] || mv package-lock.json package-lock.json.isolade-tmp

  bun install --no-save
  bun run build:native
)
