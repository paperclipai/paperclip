#!/usr/bin/env bash
# FUL-3946: deploy missing agent-permissions.js to complete FUL-3939 partial deployment
# Run with: sudo bash /home/paperclipadmin/paperclip-src/deploy-agent-permissions.sh
set -euo pipefail

SRC=/home/paperclipadmin/paperclip-src/server/dist/services
DEST=/usr/lib/node_modules/paperclipai/node_modules/@paperclipai/server/dist/services

echo "[1/3] Backing up existing agent-permissions.js..."
cp "$DEST/agent-permissions.js" "$DEST/agent-permissions.js.bak-$(date +%Y%m%d%H%M%S)" 2>/dev/null || true

echo "[2/3] Installing updated agent-permissions.js..."
cp "$SRC/agent-permissions.js" "$DEST/agent-permissions.js"
cp "$SRC/agent-permissions.js.map" "$DEST/agent-permissions.js.map" 2>/dev/null || true

echo "[3/3] Restarting paperclip.service..."
systemctl restart paperclip.service

echo "Waiting for health check..."
sleep 4
curl -sf --connect-timeout 2 --max-time 10 http://localhost:3100/api/health | python3 -m json.tool | head -3 && echo "Health: OK"

echo "Done. Verify: grep canCreateInteractions $DEST/agent-permissions.js"
