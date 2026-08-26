#!/usr/bin/env bash
# Сборка под общим замком. Два прогона, начавшие сборку одновременно, писали в один каталог
# bin/Release и получали половину чужих файлов.
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
LOCK="${TMPDIR:-/tmp}/sk_build.lock"
exec 9>"$LOCK"
flock 9
cd "$REPO"
dotnet build src/SignatureKiosk/SignatureKiosk.csproj -c Release "$@"
