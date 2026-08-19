#!/usr/bin/env bash
#
# Signature Kiosk deploy script — run on the Ubuntu server as root, from the repo root:
#     sudo ADMIN_PASSWORD='your-password' bash deploy/deploy.sh
#
# What it does:
#   1. installs the .NET 8 SDK (only if missing) via apt;
#   2. publishes a self-contained build to /opt/signaturekiosk/app;
#   3. creates the data dir and /etc/signaturekiosk.env (admin password, port);
#   4. installs + starts the systemd service `signaturekiosk`.
#
# After this, wire up nginx with deploy/nginx-signalr.zrobim.it.conf.
set -euo pipefail

SVC=signaturekiosk
APP_DIR=/opt/signaturekiosk/app
DATA_DIR=/var/lib/signaturekiosk
PORT="${PORT:-5080}"
RUN_USER="${RUN_USER:-www-data}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT="$REPO_ROOT/src/SignatureKiosk/SignatureKiosk.csproj"

if [ "$(id -u)" -ne 0 ]; then echo "Please run as root (sudo)." >&2; exit 1; fi

echo "==> [1/5] Ensuring .NET SDK 8 is installed"
if ! command -v dotnet >/dev/null 2>&1; then
    apt-get update
    apt-get install -y dotnet-sdk-8.0
else
    echo "    dotnet already present: $(dotnet --version)"
fi

echo "==> [2/5] Publishing self-contained build to $APP_DIR"
echo "    Fetching browser libraries (signalr, signature_pad)"
bash "$SCRIPT_DIR/fetch-libs.sh"
mkdir -p "$APP_DIR"
dotnet publish "$PROJECT" -c Release -r linux-x64 --self-contained true -o "$APP_DIR"

echo "==> [3/5] Preparing data directory $DATA_DIR"
mkdir -p "$DATA_DIR"
chown -R "$RUN_USER":"$RUN_USER" "$DATA_DIR"

echo "==> [4/5] Writing /etc/signaturekiosk.env"
if [ ! -f /etc/signaturekiosk.env ]; then
    PW="${ADMIN_PASSWORD:-$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 14)}"
    # Bind on all interfaces: the reverse proxy (Nginx Proxy Manager) reaches this
    # host over the LAN, so loopback-only would be unreachable. Keep port 5080
    # firewalled to the proxy host only.
    cat >/etc/signaturekiosk.env <<EOF
AdminPassword=$PW
ASPNETCORE_URLS=http://0.0.0.0:$PORT
DataDir=$DATA_DIR
EOF
    chmod 640 /etc/signaturekiosk.env
    chown root:"$RUN_USER" /etc/signaturekiosk.env
    echo "    ---------------------------------------------"
    echo "    Admin password: $PW"
    echo "    (saved in /etc/signaturekiosk.env — change it there anytime)"
    echo "    ---------------------------------------------"
else
    echo "    /etc/signaturekiosk.env already exists — leaving it untouched."
fi

echo "==> [5/5] Installing systemd service"
cp "$SCRIPT_DIR/$SVC.service" "/etc/systemd/system/$SVC.service"
systemctl daemon-reload
systemctl enable "$SVC" >/dev/null 2>&1 || true
systemctl restart "$SVC"

echo
echo "Done. Service status:"
systemctl --no-pager status "$SVC" | head -n 12 || true
echo
echo "Next steps:"
echo "  • Reverse proxy is already configured (Nginx Proxy Manager -> http://THIS_HOST:$PORT)."
echo "    Make sure port $PORT is reachable from the proxy host (firewall), e.g.:"
echo "      sudo ufw allow from <PROXY_IP> to any port $PORT proto tcp"
echo "  • Open https://signalr.zrobim.it/admin  (log in with the password above)"
echo "  • On each tablet, point freekiosk at:"
echo "      https://signalr.zrobim.it/?device=tablet-1&name=Reception"
echo "      https://signalr.zrobim.it/?device=tablet-2&name=Office"
echo "  • Logs: journalctl -u $SVC -f"
