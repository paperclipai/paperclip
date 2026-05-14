#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_SRC="$REPO_ROOT/scripts/paperclip-watchdog.sh"
SERVICE_SRC="$REPO_ROOT/ops/systemd/paperclip-watchdog.service"
TIMER_SRC="$REPO_ROOT/ops/systemd/paperclip-watchdog.timer"

SCRIPT_DST="/usr/local/bin/paperclip-watchdog"
SERVICE_DST="/etc/systemd/system/paperclip-watchdog.service"
TIMER_DST="/etc/systemd/system/paperclip-watchdog.timer"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root (sudo)." >&2
  exit 1
fi

install -m 0755 "$SCRIPT_SRC" "$SCRIPT_DST"
install -m 0644 "$SERVICE_SRC" "$SERVICE_DST"
install -m 0644 "$TIMER_SRC" "$TIMER_DST"

mkdir -p /var/lib/paperclip-watchdog
touch /var/log/paperclip-watchdog.log

systemctl daemon-reload
systemctl enable --now paperclip-watchdog.timer

echo "Installed watchdog script and systemd timer."
systemctl status paperclip-watchdog.timer --no-pager || true
