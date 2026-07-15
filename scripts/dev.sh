#!/usr/bin/env bash
# Browser dev flow: API server + sandbox runtime + Vite, all in one terminal.
# Develop the UI at http://localhost:5173 (Vite proxies the API to the server).
# For the native desktop shell with HMR, use scripts/app.sh (bun run app) instead.
set -euo pipefail

cd "$(dirname "$0")/.." # repo root
source scripts/lib/common.sh

# The OCI registry runs in-process inside the sandbox (packages/sandbox/src/registry/)
# on an OS-assigned port; image refs are composed at runtime against the bound
# port. No external container needed.
isolade_prepare_sandbox

# The sandbox runs in-process inside the server now (no separate sidecar). Both
# the server and Vite share this terminal and are killed together on exit.
trap 'kill 0' EXIT
bun run --cwd packages/server dev &
bun run --cwd packages/web dev -- --clearScreen false &

wait
