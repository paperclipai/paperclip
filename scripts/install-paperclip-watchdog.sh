#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

WATCHDOG_SRC="$REPO_ROOT/scripts/paperclip-watchdog.sh"
WATCHDOG_DST="/usr/local/bin/paperclip-watchdog"
SERVICE_SRC="$REPO_ROOT/ops/systemd/paperclip-watchdog.service"
TIMER_SRC="$REPO_ROOT/ops/systemd/paperclip-watchdog.timer"

echo "Installing watchdog script..."
cp "$WATCHDOG_SRC" "$WATCHDOG_DST"
chmod 755 "$WATCHDOG_DST"

echo "Installing systemd units..."
cp "$SERVICE_SRC" /etc/systemd/system/paperclip-watchdog.service
cp "$TIMER_SRC" /etc/systemd/system/paperclip-watchdog.timer

echo "Enabling and starting watchdog timer..."
systemctl daemon-reload
systemctl enable paperclip-watchdog.timer
systemctl start paperclip-watchdog.timer

echo "Watchdog installation complete."
echo "Run 'systemctl status paperclip-watchdog.timer' to verify."
