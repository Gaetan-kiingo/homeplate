#!/usr/bin/env sh
# scripts/gen-dev-certs.sh — self-signed TLS material for local development (NFR-03; U1-HTTP,
# build-plan §2). Output goes to certs/ which is git-ignored; NEVER commit certificates or keys.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CERT_DIR="$ROOT/certs"
CERT="$CERT_DIR/dev-cert.pem"
KEY="$CERT_DIR/dev-key.pem"

mkdir -p "$CERT_DIR"

if [ -f "$CERT" ] && [ -f "$KEY" ]; then
  echo "gen-dev-certs: $CERT and $KEY already exist — delete them to regenerate"
  exit 0
fi

openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 365 \
  -keyout "$KEY" -out "$CERT" \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"

echo "gen-dev-certs: wrote $CERT and $KEY (self-signed, 365 days, CN=localhost)"
