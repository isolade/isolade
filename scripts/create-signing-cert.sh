#!/usr/bin/env bash
# One-time: create the stable, self-signed code-signing certificate used to sign
# the isolade app + sidecars.
#
# Why this exists: macOS attributes privacy/TCC prompts (e.g. "Isolade would
# like to find and connect to devices on your local network") to a process by
# its code-signing *designated requirement*, not its filename. An ad-hoc
# signature has no certificate, so the requirement collapses to the binary's
# content hash, which changes on every build — macOS then treats each build as a
# brand-new app: the prompt is misattributed to the cargo crate name ("app") and
# any prior "allow" grant stops applying. Signing with a *stable* certificate
# pins the requirement to the cert's hash, so every rebuild/update is the same
# identity: prompts read "Isolade" and grants keep sticking.
#
# NOTE: this is no longer about the Keychain. Stored secret *values* used to live
# in the login keychain and drove a recurring "Isolade wants to use your
# confidential information" prompt; they now live in on-disk per-profile files
# (packages/server/src/secrets-store.ts). A stable cert never fully fixed that
# anyway — the keychain has a second gate (the ACL partition list) keyed by
# cdhash for team-ID-less code, which a self-signed cert can't stabilize. TCC has
# no such second gate, which is why signing genuinely fixes attribution there.
#
# A self-signed cert is enough: these checks don't require chaining to Apple.
# (Apple's paid program buys Gatekeeper/notarization, which this app already
# bypasses via `curl | tar` — a separate concern.)
#
# Run once. Outputs (both gitignored — keep them secret):
#   <out>.p12         the certificate + private key
#   <out>.p12.base64  the same, base64-encoded for pasting into a CI secret
# then imports the identity into the local signing keychain so builds work
# immediately.
set -euo pipefail

cd "$(dirname "$0")/.." # repo root

IDENTITY="${ISOLADE_SIGNING_IDENTITY:-Isolade}"
OUT="${1:-isolade-signing.p12}"
# The .p12 password is a format requirement, not a secret: a PKCS#12 always
# wraps the private key in password-based encryption and macOS won't import an
# empty-password .p12. It guards nothing in our model (the password would always
# travel alongside the .p12 it "protects"), so it's a fixed constant shared with
# setup-signing-keychain.sh — you never need to store or pass it.
CERT_PASSWORD="${ISOLADE_SIGNING_CERT_PASSWORD:-isolade}"

if [ -f "$OUT" ]; then
  echo "error: $OUT already exists — refusing to overwrite an existing signing key." >&2
  echo "       Regenerating creates a *new* identity, so every existing install would" >&2
  echo "       prompt once more. Delete $OUT yourself if that's really what you want." >&2
  exit 1
fi

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
cat > "$TMP/req.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = $IDENTITY
[v3]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
EOF

echo "==> Generating self-signed code-signing certificate '$IDENTITY' (valid 10 years)..."
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout "$TMP/key.pem" -out "$TMP/cert.pem" -config "$TMP/req.cnf" >/dev/null 2>&1

# -legacy is load-bearing: OpenSSL 3 defaults to a PKCS#12 MAC/PBE algorithm that
# macOS `security import` rejects ("MAC verification failed during PKCS12
# import"). -legacy emits the older algorithms the Keychain can read.
echo "==> Exporting $OUT ..."
openssl pkcs12 -export -legacy -out "$OUT" \
  -inkey "$TMP/key.pem" -in "$TMP/cert.pem" \
  -name "$IDENTITY" -passout "pass:$CERT_PASSWORD"

base64 < "$OUT" | tr -d '\n' > "$OUT.base64"

echo "==> Importing into the local signing keychain..."
ISOLADE_SIGNING_CERT_P12="$OUT" \
ISOLADE_SIGNING_CERT_PASSWORD="$CERT_PASSWORD" \
ISOLADE_SIGNING_IDENTITY="$IDENTITY" \
  scripts/lib/setup-signing-keychain.sh

cat <<EOF

Done.
  identity : $IDENTITY
  key      : $OUT          (password: $CERT_PASSWORD)
  base64   : $OUT.base64   (for the CI secret)

Local builds now work: scripts/build.sh signs with '$IDENTITY' automatically.

CI needs exactly ONE secret (GitHub > Settings > Secrets and variables > Actions):
  ISOLADE_SIGNING_CERT_BASE64  <- the entire contents of $OUT.base64

Copy the base64 to the clipboard with:
  cat $OUT.base64 | pbcopy

Keep $OUT and $OUT.base64 OUT of git (they're already gitignored).
EOF
