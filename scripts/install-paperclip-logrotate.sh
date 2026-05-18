#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

LOGROTATE_SRC="$REPO_ROOT/ops/logrotate/paperclip"
LOGROTATE_DST="/etc/logrotate.d/paperclip"

if [ ! -f "$LOGROTATE_SRC" ]; then
  echo "ERROR: logrotate config not found at $LOGROTATE_SRC"
  exit 1
fi

echo "Installing logrotate config to $LOGROTATE_DST..."
cp "$LOGROTATE_SRC" "$LOGROTATE_DST"
chmod 644 "$LOGROTATE_DST"

echo "Validating logrotate config..."
if logrotate -d "$LOGROTATE_DST" > /dev/null 2>&1; then
  echo "Logrotate config is valid."
else
  echo "WARNING: logrotate config validation failed. Check $LOGROTATE_DST manually."
fi

echo "Logrotate installation complete."
