#!/usr/bin/env bash
set -euo pipefail

SERVICE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="$HOME/Library/LaunchAgents/ai.whitestag.paperclip-dpo.plist"
NODE_BIN="$(command -v node)"

if [[ -z "$NODE_BIN" ]]; then
  echo "node not found in PATH" >&2
  exit 1
fi

mkdir -p /var/paperclip/dpo /var/log/paperclip-dpo 2>/dev/null || {
  echo "Need write access to /var/paperclip and /var/log. Run with sudo once to create these, then chown to your user." >&2
  exit 1
}

if [[ -z "${DPO_SHARED_KEY:-}" ]]; then
  echo "Set DPO_SHARED_KEY before running (generate via ./scripts/generate-shared-key.sh)" >&2
  exit 1
fi

sed \
  -e "s|__NODE_BIN__|$NODE_BIN|g" \
  -e "s|__INSTALL_DIR__|$SERVICE_DIR|g" \
  -e "s|__SHARED_KEY__|$DPO_SHARED_KEY|g" \
  "$SERVICE_DIR/ai.whitestag.paperclip-dpo.plist" > "$TARGET"

launchctl unload "$TARGET" 2>/dev/null || true
launchctl load -w "$TARGET"
echo "Installed. Check: curl http://localhost:4711/health"
