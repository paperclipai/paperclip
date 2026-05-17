#!/usr/bin/env bash
set -euo pipefail

DRY_RUN="${PAPERCLIP_DRY_RUN:-false}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_DIR="${HOME}/.config/systemd/user"
mkdir -p "${UNIT_DIR}"

SERVICE_SRC="${SCRIPT_DIR}/paperclip-backup-deadman-monitor.service"
TIMER_SRC="${SCRIPT_DIR}/paperclip-backup-deadman-monitor.timer"

SERVICE_DST="${UNIT_DIR}/paperclip-backup-deadman-monitor.service"
TIMER_DST="${UNIT_DIR}/paperclip-backup-deadman-monitor.timer"

echo "=== Paperclip Backup Dead-Man's-Switch Monitor — Systemd Install ==="
echo "Source:  ${SCRIPT_DIR}"
echo "Target:  ${UNIT_DIR}"
echo "Dry run: ${DRY_RUN}"
echo ""

if [ ! -f "${SERVICE_SRC}" ]; then
    echo "ERROR: Service unit not found: ${SERVICE_SRC}"
    exit 1
fi
if [ ! -f "${TIMER_SRC}" ]; then
    echo "ERROR: Timer unit not found: ${TIMER_SRC}"
    exit 1
fi

if [ "${DRY_RUN}" = "true" ]; then
    echo "[DRY RUN] Would copy:"
    echo "  ${SERVICE_SRC} → ${SERVICE_DST}"
    echo "  ${TIMER_SRC}   → ${TIMER_DST}"
    echo "[DRY RUN] Would run:"
    echo "  systemctl --user daemon-reload"
    echo "  systemctl --user enable paperclip-backup-deadman-monitor.timer"
    echo "  systemctl --user start paperclip-backup-deadman-monitor.timer"
else
    cp -v "${SERVICE_SRC}" "${SERVICE_DST}"
    cp -v "${TIMER_SRC}" "${TIMER_DST}"

    systemctl --user daemon-reload
    systemctl --user enable paperclip-backup-deadman-monitor.timer
    systemctl --user start paperclip-backup-deadman-monitor.timer

    echo ""
    echo "=== Timer status ==="
    systemctl --user status paperclip-backup-deadman-monitor.timer --no-pager || true
    echo ""
    echo "=== Next trigger ==="
    systemctl --user list-timers paperclip-backup-deadman-monitor.timer --no-pager || true
fi

echo ""
echo "=== Linger check ==="
LINGER=$(loginctl show-user "$USER" --property=Linger 2>/dev/null | cut -d= -f2 || echo "?")
if [ "$LINGER" = "yes" ]; then
    echo "  linger: enabled (timers run when logged out)"
else
    echo "  WARNING: linger is '$LINGER' — timers stop on logout"
    echo "  Fix: sudo loginctl enable-linger $USER"
fi

echo ""
echo "Install complete. To verify:"
echo "  systemctl --user status paperclip-backup-deadman-monitor.timer"
echo "  systemctl --user list-timers"
echo "  journalctl --user -u paperclip-backup-deadman-monitor.service -n 20"
echo ""
echo "To trigger a run immediately:"
echo "  systemctl --user start paperclip-backup-deadman-monitor.service"
