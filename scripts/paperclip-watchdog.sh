#!/usr/bin/env bash
set -euo pipefail

STATE_DIR="/var/lib/paperclip-watchdog"
STATE_FILE="$STATE_DIR/state.env"
LOG_FILE="/var/log/paperclip-watchdog.log"
DRY_RUN_DURATION_HOURS=48
HEALTHZ_URL="http://127.0.0.1:3101/healthz"

mkdir -p "$STATE_DIR"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$LOG_FILE"; }

load_state() {
  if [ -f "$STATE_FILE" ]; then
    set -a; source "$STATE_FILE"; set +a
  fi
  CONSECUTIVE_HEALTHZ_FAILS="${CONSECUTIVE_HEALTHZ_FAILS:-0}"
  RESTART_COUNT_15M="${RESTART_COUNT_15M:-0}"
  RESTART_WINDOW_START="${RESTART_WINDOW_START:-0}"
  INSTALLED_AT="${INSTALLED_AT:-$(date +%s)}"
  ENFORCEMENT_MODE="${ENFORCEMENT_MODE:-dry-run}"
}

save_state() {
  cat > "$STATE_FILE" <<STATE
CONSECUTIVE_HEALTHZ_FAILS=$CONSECUTIVE_HEALTHZ_FAILS
RESTART_COUNT_15M=$RESTART_COUNT_15M
RESTART_WINDOW_START=$RESTART_WINDOW_START
INSTALLED_AT=$INSTALLED_AT
ENFORCEMENT_MODE=$ENFORCEMENT_MODE
STATE
}

send_alert() {
  local severity="$1" message="$2"
  log "$severity: $message"
}

check_enforcement_mode() {
  local now; now=$(date +%s)
  local elapsed=$(( (now - INSTALLED_AT) / 3600 ))
  if [ "$ENFORCEMENT_MODE" = "dry-run" ] && [ "$elapsed" -ge "$DRY_RUN_DURATION_HOURS" ]; then
    ENFORCEMENT_MODE="enforcement"
    log "Switching to enforcement mode after $elapsed hours of dry-run."
    send_alert "INFO" "Watchdog switched to enforcement mode after ${elapsed}h dry-run."
  fi
}

check_flap_protection() {
  local now; now=$(date +%s)
  if [ "$RESTART_WINDOW_START" -eq 0 ] || [ $(( now - RESTART_WINDOW_START )) -gt 900 ]; then
    RESTART_COUNT_15M=0
    RESTART_WINDOW_START=$now
  fi
  if [ "$RESTART_COUNT_15M" -ge 3 ]; then
    send_alert "CRITICAL" "Flap protection: 3 restarts in 15 minutes. Auto-remediation suspended."
    return 1
  fi
  return 0
}

restart_service() {
  local service="$1" reason="$2"
  if [ "$ENFORCEMENT_MODE" != "enforcement" ]; then
    log "DRY-RUN: Would restart $service because: $reason"
    send_alert "INFO" "DRY-RUN: Would restart $service — $reason"
    return 0
  fi
  if ! check_flap_protection; then return 1; fi
  log "Restarting $service: $reason"
  systemctl restart "$service"
  RESTART_COUNT_15M=$((RESTART_COUNT_15M + 1))
  send_alert "CRITICAL" "Restarted $service — $reason (restart $RESTART_COUNT_15M/3 in 15min window)"
}

check_health() {
  local status
  status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$HEALTHZ_URL" 2>/dev/null || echo "000")
  if [ "$status" != "200" ]; then
    CONSECUTIVE_HEALTHZ_FAILS=$((CONSECUTIVE_HEALTHZ_FAILS + 1))
    log "Health check failed (${CONSECUTIVE_HEALTHZ_FAILS}/3 consecutive): HTTP $status"
    if [ "$CONSECUTIVE_HEALTHZ_FAILS" -ge 3 ]; then
      restart_service "paperclip.service" "healthz failed ${CONSECUTIVE_HEALTHZ_FAILS} consecutive times (HTTP $status)"
      CONSECUTIVE_HEALTHZ_FAILS=0
    fi
  else
    CONSECUTIVE_HEALTHZ_FAILS=0
  fi
}

check_disk() {
  local usage
  usage=$(df / | awk 'NR==2 {print $5}' | tr -d '%')
  if [ "${usage:-0}" -gt 90 ]; then
    log "Disk usage at ${usage}% — forcing logrotate"
    if [ "$ENFORCEMENT_MODE" = "enforcement" ]; then
      logrotate -f /etc/logrotate.d/paperclip 2>/dev/null || true
    else
      log "DRY-RUN: Would force logrotate (disk ${usage}%)"
    fi
    send_alert "CRITICAL" "Disk ${usage}% — forced logrotate"
  fi
}

check_connections() {
  local established count
  established=$(ss -tn state established "( dport = :3101 or sport = :3101 )" 2>/dev/null | tail -n +2 | wc -l)
  count=${established:-0}
  if [ "$count" -gt 500 ]; then
    restart_service "cloudflared-paperclip.service" "${count} established connections to :3101"
  elif [ "$count" -gt 200 ]; then
    log "WARNING: ${count} established connections to :3101"
    send_alert "WARNING" "${count} established connections to :3101"
  fi
}

check_close_wait() {
  local count
  count=$(ss -tn state close-wait "( dport = :3101 or sport = :3101 )" 2>/dev/null | tail -n +2 | wc -l)
  if [ "${count:-0}" -gt 50 ]; then
    restart_service "cloudflared-paperclip.service" "${count} CLOSE_WAIT sockets on :3101"
  fi
}

main() {
  load_state
  check_enforcement_mode
  check_health
  check_disk
  check_connections
  check_close_wait
  save_state
}

main "$@"
