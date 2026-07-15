#!/usr/bin/env bash
# Build the fork's `msb` supervisor binary (-> $FORK/target/release/msb).
#
# Shared by lib/assemble-msb-runtime.sh and the CI microsandbox provisioning
# (.github/actions/microsandbox builds + caches it before the Tauri build), so
# the exact build flags live in one place. Source of the fork:
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
command -v cargo >/dev/null || { echo "error: cargo not found; install Rust or set ISOLADE_SKIP_MSB_BUILD=1" >&2; exit 1; }

echo "building msb from fork ($FORK)..."
# Build with the cli `prebuilt` feature OFF, but microsandbox-runtime's prebuilt
# ON. `prebuilt` bundles two unrelated things:
#   * microsandbox/prebuilt — microsandbox/build.rs downloads a host msb+libkrunfw
#     bundle to $MSB_HOME (default ~/.microsandbox). We do NOT want this; we supply
#     msb (this build) and libkrunfw (platform package) ourselves.
#   * microsandbox-runtime/prebuilt -> filesystem/prebuilt — downloads the
#     published agentd into OUT_DIR and embeds it into msb. We DO want this: it
#     avoids a local `just build-agentd` (Docker) and never touches ~/.microsandbox.
# Enabling only the runtime's prebuilt keeps the host download off while keeping
# agentd embedded.
( cd "$FORK" && cargo build --release -p microsandbox-cli --bin msb \
    --no-default-features --features net,keyring,ssh,microsandbox-runtime/prebuilt )
