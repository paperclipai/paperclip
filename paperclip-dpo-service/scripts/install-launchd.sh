#!/usr/bin/env bash
set -euo pipefail

SERVICE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="$HOME/Library/LaunchAgents/ai.whitestag.paperclip-dpo.plist"
DATA_DIR="$HOME/Library/Application Support/paperclip-dpo"
LOG_DIR="$HOME/Library/Logs/paperclip-dpo"
NODE_BIN="$(command -v node)"

if [[ -z "$NODE_BIN" ]]; then
  echo "node not found in PATH" >&2
  exit 1
fi

mkdir -p "$DATA_DIR/audit" "$LOG_DIR"

if [[ -z "${DPO_SHARED_KEY:-}" ]]; then
  echo "Set DPO_SHARED_KEY before running (generate via ./scripts/generate-shared-key.sh)" >&2
  exit 1
fi

sed \
  -e "s|__NODE_BIN__|$NODE_BIN|g" \
  -e "s|__INSTALL_DIR__|$SERVICE_DIR|g" \
  -e "s|__SHARED_KEY__|$DPO_SHARED_KEY|g" \
  -e "s|__DATA_DIR__|$DATA_DIR|g" \
  -e "s|__LOG_DIR__|$LOG_DIR|g" \
  "$SERVICE_DIR/ai.whitestag.paperclip-dpo.plist" > "$TARGET"

launchctl unload "$TARGET" 2>/dev/null || true
launchctl load -w "$TARGET"
echo "Installed. Check: curl http://localhost:4711/health"
