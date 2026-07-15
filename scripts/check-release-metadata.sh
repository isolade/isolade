#!/usr/bin/env bash
# Validate that a release branch's version is internally consistent, and emit
# the version + release notes for the build to consume.
#
# Invoked by the release build (.github/workflows/ci.yml) for a release PR,
# BEFORE the ~20-minute Tauri compile, so a drifted version fails fast instead of
# shipping mislabeled artifacts. It enforces the
# single-source-of-truth invariant that the release ritual must uphold:
#
#     branch name         release/vX.Y.Z
#     app/tauri.conf.json  "version": "X.Y.Z"   (the app version, see lib.rs)
#     CHANGELOG.md         top released heading  "## [X.Y.Z]" / "## vX.Y.Z"
#
# all agree. The release PR is where the human bumps the version and rotates the
# changelog's Unreleased section into a dated X.Y.Z heading; this is the gate
# that they did it consistently.
#
# Side effects (only meaningful under GitHub Actions):
#   - appends VERSION=X.Y.Z to $GITHUB_ENV so later steps can reference it
#   - writes the changelog section for X.Y.Z to dist/RELEASE_NOTES.md, which the
#     upload step attaches as the release body
#
# Usage: check-release-metadata.sh [branch-name]
#   branch-name defaults to $GITHUB_REF_NAME (e.g. "release/v0.1.1").
set -euo pipefail

cd "$(dirname "$0")/.." # repo root

BRANCH="${1:-${GITHUB_REF_NAME:-}}"
if [ -z "$BRANCH" ]; then
  echo "error: no branch name given and \$GITHUB_REF_NAME is empty" >&2
  exit 1
fi

# release/v0.1.1 -> 0.1.1
case "$BRANCH" in
  release/v*) BRANCH_VERSION="${BRANCH#release/v}" ;;
  *)
    echo "error: '$BRANCH' is not a release branch (expected release/vX.Y.Z)" >&2
    exit 1
    ;;
esac

if ! printf '%s' "$BRANCH_VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "error: branch '$BRANCH' does not encode a vX.Y.Z version" >&2
  exit 1
fi

# The app version is the single source of truth (tauri.conf.json). Read it with
# a tight regex rather than a JSON parser so this runs with zero toolchain setup,
# right after checkout — the file is small and machine-generated, so the shape is
# stable.
CONF="app/tauri.conf.json"
APP_VERSION="$(grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]+"' "$CONF" | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+[^"]*')"
if [ -z "$APP_VERSION" ]; then
  echo "error: could not read \"version\" from $CONF" >&2
  exit 1
fi

if [ "$BRANCH_VERSION" != "$APP_VERSION" ]; then
  echo "error: version mismatch" >&2
  echo "       branch '$BRANCH' implies $BRANCH_VERSION" >&2
  echo "       but $CONF says $APP_VERSION" >&2
  echo "       bump $CONF to $BRANCH_VERSION or rename the branch to release/v$APP_VERSION." >&2
  exit 1
fi

# Pull the top *released* changelog section (the first "## " heading that isn't
# Unreleased) and require it to name exactly this version. Its body becomes the
# release notes. This is what forces the changelog rotation to actually happen in
# the PR — a stale or missing entry fails the build.
CHANGELOG="CHANGELOG.md"
if [ ! -f "$CHANGELOG" ]; then
  echo "error: $CHANGELOG not found — the release PR must rotate the changelog" >&2
  exit 1
fi

mkdir -p dist
NOTES="dist/RELEASE_NOTES.md"

# awk: skip to the first non-Unreleased "## " heading, capture the version token
# from it, then stream the body up to the next "## " heading into NOTES.
HEADING_VERSION="$(
  awk -v notes="$NOTES" '
    /^##[[:space:]]/ {
      if (started) exit
      if ($0 ~ /[Uu]nreleased/) next
      started = 1
      # first X.Y.Z token in the heading line
      if (match($0, /[0-9]+\.[0-9]+\.[0-9]+/)) {
        print substr($0, RSTART, RLENGTH) > "/dev/stderr"
      }
      next
    }
    started { print >> notes }
  ' "$CHANGELOG" 2>&1 >/dev/null
)"

if [ -z "$HEADING_VERSION" ]; then
  echo "error: no released section found in $CHANGELOG (only an Unreleased heading?)" >&2
  echo "       the release PR must promote Unreleased to '## [$APP_VERSION] - <date>'." >&2
  exit 1
fi

if [ "$HEADING_VERSION" != "$APP_VERSION" ]; then
  echo "error: changelog mismatch" >&2
  echo "       $CHANGELOG's top released entry is $HEADING_VERSION" >&2
  echo "       but this release is $APP_VERSION." >&2
  echo "       promote Unreleased to '## [$APP_VERSION] - <date>' at the top of $CHANGELOG." >&2
  exit 1
fi

echo "release metadata OK: v$APP_VERSION (branch, tauri.conf.json, and CHANGELOG agree)"

if [ -n "${GITHUB_ENV:-}" ]; then
  echo "VERSION=$APP_VERSION" >> "$GITHUB_ENV"
fi
