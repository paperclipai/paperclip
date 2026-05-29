#!/usr/bin/env bash
# Paperclip server health probe — PRO-6213
#
# Polls GET /api/health every invocation. Tracks consecutive failures in a
# state file; emits a syslog CRIT alert and a systemd journal entry after
# FAIL_THRESHOLD consecutive failures (default 2 × every-60s cron = ~2 min).
#
# Install (systemd timer — preferred on mst001):
#   1. Copy this script to /usr/local/bin/paperclip-health-probe.sh
#   2. chmod +x /usr/local/bin/paperclip-health-probe.sh
#   3. Create /etc/systemd/system/paperclip-health-probe.service:
#        [Unit]
#        Description=Paperclip server health probe
#        After=network-online.target
#
#        [Service]
#        Type=oneshot
#        ExecStart=/usr/local/bin/paperclip-health-probe.sh
#
#   4. Create /etc/systemd/system/paperclip-health-probe.timer:
#        [Unit]
#        Description=Run Paperclip health probe every 60 seconds
#
#        [Timer]
#        OnBootSec=60
#        OnUnitActiveSec=60
#        AccuracySec=5
#
#        [Install]
#        WantedBy=timers.target
#
#   5. systemctl daemon-reload
#      systemctl enable --now paperclip-health-probe.timer
#
# Alternative (cron — add to root crontab):
#   * * * * * /usr/local/bin/paperclip-health-probe.sh
#
# Environment overrides:
#   PAPERCLIP_HEALTH_URL    — default: http://localhost:3100/api/health
#   FAIL_THRESHOLD          — consecutive failures before alerting (default: 2)
#   STATE_FILE              — path to failure counter file (default: /run/paperclip-health-probe.state)

set -euo pipefail

HEALTH_URL="${PAPERCLIP_HEALTH_URL:-http://localhost:3100/api/health}"
FAIL_THRESHOLD="${FAIL_THRESHOLD:-2}"
STATE_FILE="${STATE_FILE:-/run/paperclip-health-probe.state}"
TIMEOUT=10

read_fails() {
  [[ -f "$STATE_FILE" ]] && cat "$STATE_FILE" || echo 0
}

write_fails() {
  echo "$1" > "$STATE_FILE"
}

http_status=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" "$HEALTH_URL" 2>/dev/null || echo "000")

if [[ "$http_status" == "200" ]]; then
  write_fails 0
  exit 0
fi

fails=$(( $(read_fails) + 1 ))
write_fails "$fails"

if (( fails >= FAIL_THRESHOLD )); then
  msg="Paperclip server health check FAILED for ${fails} consecutive polls (HTTP ${http_status}). URL: ${HEALTH_URL}"
  logger -t paperclip-health-probe -p daemon.crit "$msg"
  # Also write to systemd journal with a high-priority marker so alertmanager / Graylog can match it
  systemd-cat -t paperclip-health-probe -p crit echo "$msg" 2>/dev/null || true
  # Reset counter so we alert again after the next FAIL_THRESHOLD misses, not on every poll
  write_fails 0
  exit 1
fi

exit 0
