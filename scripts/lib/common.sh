#!/usr/bin/env bash
# Shared bootstrap for the dev entry points (scripts/dev.sh, scripts/app.sh).
# Currently just microsandbox runtime assembly.
#
# This is sourced, not executed: callers `cd` to the repo root, `source` this,
# then call the functions below. Keeping the two dev flows on one bootstrap means
# the browser flow and the native-app flow can't drift apart.

# Ensure a microsandbox runtime is available and export the env the in-process
# sandbox needs. The assembled runtime is a static copy, so we REUSE it across
# dev runs rather than rebuilding every time — the cargo build is slow and, worse,
# thrashes the fork's target/ cache (our `--no-default-features` feature set
# differs from the SDK's napi build, so they recompile each other on every
# invocation). Rebuild from the fork only when the runtime is missing or you
# changed the fork: ISOLADE_REBUILD_MSB=1.
#
# If ISOLADE_SANDBOX_URL is set the server skips its in-process runtime and talks
# to that external sandbox instead, so there's nothing to assemble.
#
# NOTE: the default runtime path here MUST stay in sync with the one
# app/src/lib.rs points the dev sidecar at (app/binaries/msb-runtime — the
# gitignored build artifact, shared with the release bundle), or the Tauri dev
# app won't find msb.
isolade_prepare_sandbox() {
  if [ -n "${ISOLADE_SANDBOX_URL:-}" ]; then
    echo "[isolade] using external sandbox at $ISOLADE_SANDBOX_URL"
    return
  fi

  local runtime="${ISOLADE_MSB_RUNTIME:-$PWD/app/binaries/msb-runtime}"
  if [ -x "$runtime/bin/msb" ] && [ -z "${ISOLADE_REBUILD_MSB:-}" ]; then
    echo "[isolade] reusing microsandbox runtime at $runtime (ISOLADE_REBUILD_MSB=1 to rebuild from the fork)"
  else
    echo "[isolade] assembling microsandbox runtime -> $runtime"
    scripts/lib/assemble-msb-runtime.sh "$runtime" \
      || echo "[isolade] warning: msb runtime assembly failed; sandbox VM ops may not work" >&2
  fi

  # The sidecar's TS layer owns MSB_HOME / MSB_PATH and sets the real env
  # itself (it must, via setenv: Bun doesn't propagate process.env writes to
  # native getenv). We hand over only the binary location, read by the TS layer
  # from process.env.
  if [ -x "$runtime/bin/msb" ]; then
    export ISOLADE_MSB_BIN_DIR="$runtime/bin"
  fi
}
