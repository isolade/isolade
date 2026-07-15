#!/usr/bin/env bash
# Make the isolade code-signing identity available to `codesign`, non-
# interactively, in a dedicated keychain. Idempotent and safe to run on every
# build; scripts/build.sh calls it. Works identically on a dev Mac and on a CI
# runner — the only difference is where the certificate comes from.
#
# Why a dedicated keychain (not the login keychain): a CI runner has no unlocked
# login keychain, and importing into the login keychain needs the user's login
# password interactively. A dedicated keychain with a known password is fully
# scriptable and behaves the same everywhere.
#
# The certificate is supplied one of two ways:
#   ISOLADE_SIGNING_CERT_BASE64  base64 of the .p12   (CI secret), OR
#   ISOLADE_SIGNING_CERT_P12     path to the .p12     (local file)
# plus:
#   ISOLADE_SIGNING_CERT_PASSWORD      password protecting the .p12 (NOT a real
#                                       secret — see create-signing-cert.sh; just
#                                       needs to match what the .p12 was made with.
#                                       Default "isolade"; only override if you
#                                       chose a custom one at creation time.)
#   ISOLADE_SIGNING_KEYCHAIN_PASSWORD  password for the dedicated keychain
#                                       (arbitrary; default "isolade-signing")
#   ISOLADE_SIGNING_IDENTITY           cert common name (default below)
#   ISOLADE_SIGNING_KEYCHAIN_NAME      keychain filename (default below; override
#                                       only for tests)
#
# Once the identity is in the keychain no cert material is needed on later runs —
# the import is skipped and only an unlock + search-list refresh happen.
set -euo pipefail

IDENTITY="${ISOLADE_SIGNING_IDENTITY:-Isolade}"
KC_NAME="${ISOLADE_SIGNING_KEYCHAIN_NAME:-isolade-signing.keychain-db}"
KC_PASS="${ISOLADE_SIGNING_KEYCHAIN_PASSWORD:-isolade-signing}"
KC_PATH="$HOME/Library/Keychains/$KC_NAME"
# Fixed default, shared with create-signing-cert.sh. The .p12 password is a
# format requirement (macOS won't import an empty-password .p12), not a secret —
# wherever the .p12 travels its password travels too — so it lives as a constant
# rather than a per-environment secret.
CERT_PASS="${ISOLADE_SIGNING_CERT_PASSWORD:-isolade}"

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# Resolve the .p12 (a base64 secret wins over a file path), if one was provided.
P12=""
if [ -n "${ISOLADE_SIGNING_CERT_BASE64:-}" ]; then
  P12="$TMP/signing.p12"
  printf '%s' "$ISOLADE_SIGNING_CERT_BASE64" | base64 --decode > "$P12"
elif [ -n "${ISOLADE_SIGNING_CERT_P12:-}" ]; then
  P12="$ISOLADE_SIGNING_CERT_P12"
fi

# Create the dedicated keychain on first use; always unlock it and disable the
# auto-lock timeout so codesign never blocks on it later in the build.
if [ ! -f "$KC_PATH" ]; then
  echo "==> Creating signing keychain $KC_NAME"
  security create-keychain -p "$KC_PASS" "$KC_PATH"
fi
security set-keychain-settings "$KC_PATH"
security unlock-keychain -p "$KC_PASS" "$KC_PATH"

# Import the identity once. `find-identity -p codesigning` WITHOUT `-v` lists
# usable-but-untrusted certs; a self-signed cert is never "valid"/trusted, but
# codesign signs with it fine, so don't filter on validity here.
if security find-identity -p codesigning "$KC_PATH" | grep -qF "$IDENTITY"; then
  echo "==> Identity '$IDENTITY' already present in $KC_NAME"
else
  if [ -z "$P12" ]; then
    echo "error: identity '$IDENTITY' is not in $KC_NAME and no certificate was provided." >&2
    echo "       Set ISOLADE_SIGNING_CERT_BASE64 (CI) or ISOLADE_SIGNING_CERT_P12 (local)," >&2
    echo "       or run scripts/create-signing-cert.sh first." >&2
    exit 1
  fi
  echo "==> Importing '$IDENTITY' into $KC_NAME"
  # -T /usr/bin/codesign puts codesign on the private key's ACL; the partition
  # list then clears it for non-interactive use (no "codesign wants to sign
  # using key ... allow?" GUI prompt during the build).
  security import "$P12" -k "$KC_PATH" -P "$CERT_PASS" -T /usr/bin/codesign -T /usr/bin/security
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KC_PASS" "$KC_PATH" >/dev/null
fi

# Ensure the keychain is in the user search list — `codesign -s <name>` searches
# the list, not a single keychain, so an out-of-list keychain is invisible to it.
if ! security list-keychains -d user | sed 's/"//g' | grep -qF "$KC_NAME"; then
  echo "==> Adding $KC_NAME to the keychain search list"
  existing=()
  while IFS= read -r line; do
    line="${line#"${line%%[![:space:]]*}"}"; line="${line%\"}"; line="${line#\"}"
    [ -n "$line" ] && existing+=("$line")
  done < <(security list-keychains -d user)
  security list-keychains -d user -s "$KC_PATH" "${existing[@]}"
fi

echo "Signing identity '$IDENTITY' ready."
