#!/usr/bin/env bash
# =============================================================================
# clawhq-health-monitor.sh
# External health monitor for claw-hq (Mission Control / Crawl4AI host).
# Runs on ironworks-vps and checks claw-hq's health endpoint via Tailscale.
#
# Mirrors the existing ironworks-health-monitor.sh that runs on claw-hq.
# Each server now monitors the other; they should not both go down at the
# same time, so they serve as each other's external watchdog.
#
# SETUP ON ironworks-vps:
# 1. Place this script at /opt/monitors/clawhq-health-monitor.sh
# 2. chmod +x /opt/monitors/clawhq-health-monitor.sh
# 3. Install cron entry (every minute):
#    * * * * * CLAWHQ_HEALTH_URL=http://100.90.180.107:3000/api/health \
#              TELEGRAM_BOT_TOKEN=<token> \
#              TELEGRAM_CHAT_ID=<chat_id> \
#              /opt/monitors/clawhq-health-monitor.sh
#
# HOW IT WORKS:
# - Checks claw-hq's Mission Control /api/health endpoint via Tailscale every minute.
# - Tracks consecutive failures in /tmp/clawhq-health-failures.
# - Sends a Telegram ALERT after 3 consecutive failures.
# - Sends a Telegram RECOVERY message when the server comes back online.
# - Logs all events to /var/log/clawhq-health.log with CT timestamps.
#
# Note: the /api/health endpoint may return JSON with status="degraded" if
# specific services on claw-hq are down - that is OK for our purposes.
# We only care about HTTP 200; the endpoint responding at all means the
# Tailscale tunnel and the host's web layer are alive.
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
HEALTH_URL="${CLAWHQ_HEALTH_URL:-http://100.90.180.107:3000/api/health}"
BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
CHAT_ID="${TELEGRAM_CHAT_ID:-}"
FAILURE_FILE="/tmp/clawhq-health-failures"
LOG_FILE="/var/log/clawhq-health.log"
ALERT_THRESHOLD=3
CURL_TIMEOUT=10

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
ct_timestamp() {
  TZ="America/Chicago" date "+%Y-%m-%d %H:%M:%S CT"
}

log() {
  local msg="$1"
  local ts
  ts="$(ct_timestamp)"
  echo "[$ts] $msg" >> "$LOG_FILE" 2>/dev/null || true
}

send_telegram() {
  local message="$1"
  if [[ -z "$BOT_TOKEN" || -z "$CHAT_ID" ]]; then
    log "WARN: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set - skipping Telegram alert"
    return 0
  fi

  curl -s --max-time 10 \
    -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    -d "chat_id=${CHAT_ID}" \
    -d "parse_mode=Markdown" \
    --data-urlencode "text=${message}" \
    > /dev/null 2>&1 || log "WARN: Failed to send Telegram message"
}

get_failure_count() {
  if [[ -f "$FAILURE_FILE" ]]; then
    cat "$FAILURE_FILE" 2>/dev/null || echo "0"
  else
    echo "0"
  fi
}

set_failure_count() {
  echo "$1" > "$FAILURE_FILE"
}

reset_failures() {
  rm -f "$FAILURE_FILE"
}

# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------
http_status=$(curl -s -o /dev/null -w "%{http_code}" \
  --max-time "$CURL_TIMEOUT" \
  --connect-timeout "$CURL_TIMEOUT" \
  "$HEALTH_URL" 2>/dev/null || echo "000")

if [[ "$http_status" == "200" ]]; then
  # --- Healthy ---
  prev_failures=$(get_failure_count)

  if [[ "$prev_failures" -ge "$ALERT_THRESHOLD" ]]; then
    ts=$(ct_timestamp)
    recovery_msg="Boss, claw-hq is back online. (${ts})"
    log "RECOVERY: claw-hq is back online after ${prev_failures} consecutive failure(s)"
    send_telegram "$recovery_msg"
  else
    log "OK: claw-hq health check passed (HTTP ${http_status})"
  fi

  reset_failures

else
  # --- Unhealthy ---
  prev_failures=$(get_failure_count)
  new_failures=$(( prev_failures + 1 ))
  set_failure_count "$new_failures"

  log "FAIL: claw-hq health check failed (HTTP ${http_status}) - consecutive failures: ${new_failures}"

  if [[ "$new_failures" -eq "$ALERT_THRESHOLD" ]]; then
    ts=$(ct_timestamp)
    alert_msg="Boss, claw-hq appears to be down. I'm monitoring and will let you know when it's back. (${ts})"
    log "ALERT: Sending Telegram alert after ${new_failures} consecutive failures"
    send_telegram "$alert_msg"
  elif [[ "$new_failures" -gt "$ALERT_THRESHOLD" ]]; then
    log "INFO: Still down - alert already sent (failure count: ${new_failures})"
  else
    log "INFO: Failure ${new_failures}/${ALERT_THRESHOLD} - waiting for threshold before alerting"
  fi
fi
