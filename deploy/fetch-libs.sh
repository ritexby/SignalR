#!/usr/bin/env bash
#
# Fetches the two browser libraries the frontend serves locally
# (@microsoft/signalr, signature_pad) into wwwroot/lib.
# They are not stored in git; this runs at deploy time (and once for local dev).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIBDIR="$SCRIPT_DIR/../src/SignatureKiosk/wwwroot/lib"
mkdir -p "$LIBDIR"

SIGNALR_VER="${SIGNALR_VER:-10.0.11}"
SIGPAD_VER="${SIGPAD_VER:-5.1.4}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "==> Fetching @microsoft/signalr@$SIGNALR_VER"
curl -fsSL "https://registry.npmjs.org/@microsoft/signalr/-/signalr-${SIGNALR_VER}.tgz" -o "$TMP/signalr.tgz"
tar -xzf "$TMP/signalr.tgz" -C "$TMP"
cp "$TMP/package/dist/browser/signalr.min.js" "$LIBDIR/signalr.min.js"
rm -rf "$TMP/package"

echo "==> Fetching signature_pad@$SIGPAD_VER"
curl -fsSL "https://registry.npmjs.org/signature_pad/-/signature_pad-${SIGPAD_VER}.tgz" -o "$TMP/sigpad.tgz"
tar -xzf "$TMP/sigpad.tgz" -C "$TMP"
cp "$TMP/package/dist/signature_pad.umd.min.js" "$LIBDIR/signature_pad.umd.min.js"

echo "==> Libraries ready in $LIBDIR:"
ls -la "$LIBDIR"
