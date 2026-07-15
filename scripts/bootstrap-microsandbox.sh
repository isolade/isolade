#!/usr/bin/env bash
# Prepare the pinned microsandbox runtime used by local dev and release builds:
# init the submodule, build the fork's native binding + msb, then assemble both
# (plus libkrunfw) into app/binaries/msb-runtime.
set -euo pipefail

cd "$(dirname "$0")/.." # repo root

# Init the pinned submodule when using the default checkout. A custom
# ISOLADE_MICROSANDBOX_DIR is the caller's own tree, so leave it untouched.
if [ -z "${ISOLADE_MICROSANDBOX_DIR:-}" ]; then
  git submodule update --init third_party/microsandbox
fi

scripts/lib/build-msb-native.sh

echo "==> Assembling microsandbox runtime"
ISOLADE_REBUILD_MSB=1 scripts/lib/assemble-msb-runtime.sh app/binaries/msb-runtime

echo "==> Microsandbox runtime ready at app/binaries/msb-runtime"
