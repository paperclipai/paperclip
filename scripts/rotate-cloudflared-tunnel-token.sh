#!/usr/bin/env bash
set -euo pipefail

TUNNEL_NAME="paperclip-tunnel"
SERVICE_NAME="cloudflared-paperclip.service"

echo "Rotating tunnel token for $TUNNEL_NAME..."

NEW_TOKEN=$(cloudflared tunnel token $TUNNEL_NAME 2>/dev/null || {
  echo "ERROR: Failed to get new tunnel token. Check cloudflared CLI and authentication."
  exit 1
})

if [ -z "$NEW_TOKEN" ]; then
  echo "ERROR: Empty token returned."
  exit 1
fi

# Update the systemd credential
systemctl set-environment CLOUDFLARED_TUNNEL_TOKEN="$NEW_TOKEN"

# Restart the tunnel
systemctl restart "$SERVICE_NAME"

sleep 5

if systemctl is-active --quiet "$SERVICE_NAME"; then
  echo "Tunnel restarted successfully with new token."
else
  echo "ERROR: Tunnel failed to restart. Check: journalctl -u $SERVICE_NAME --no-pager -n 20"
  exit 1
fi

echo "Token rotation complete."
