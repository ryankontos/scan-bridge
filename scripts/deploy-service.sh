#!/bin/zsh
set -euo pipefail

WORKSPACE_DIR="/Users/ryan/Documents/New project/scan-bridge"
SERVICE_DIR="$HOME/Services/scan-bridge"
PLIST="$HOME/Library/LaunchAgents/com.ryankontos.scan-bridge.plist"

cd "$WORKSPACE_DIR"
npm run build

mkdir -p "$SERVICE_DIR"
rsync -a --delete --exclude '.git' --exclude 'dist' "$WORKSPACE_DIR/" "$SERVICE_DIR/"
rsync -a --delete "$WORKSPACE_DIR/dist/" "$SERVICE_DIR/dist/"

cd "$SERVICE_DIR"
npm ci
chmod +x "$SERVICE_DIR/run-service.sh"

launchctl kickstart -k gui/501/com.ryankontos.scan-bridge
echo "Deployed Scan Bridge service with $PLIST"
