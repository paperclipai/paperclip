#!/usr/bin/env bash
set -euo pipefail

NOW_EPOCH="$(date +%s)"
STATE_DIR="${WATCHDOG_STATE_DIR:-/var/lib/paperclip-watchdog}"
STATE_FILE="${STATE_DIR}/state.env"
LOG_FILE="${WATCHDOG_LOG_FILE:-/var/log/paperclip-watchdog.log}"
HEALTH_URL="${WATCHDOG_HEALTH_URL:-http://127.0.0.1:3101/healthz}"
SERVER_LOG_FILE="${WATCHDOG_SERVER_LOG_FILE:-/home/paperclip/.paperclip/instances/default/logs/server.log}"
DRY_RUN_HOURS="${WATCHDOG_DRY_RUN_HOURS:-48}"
DRY_RUN_SECONDS="$(( DRY_RUN_HOURS * 3600 ))"
FLAP_WINDOW_SECONDS=900
FLAP_MAX_RESTARTS=3

TELEGRAM_BOT_TOKEN="${WATCHDOG_TELEGRAM_BOT_TOKEN:-${TELEGRAM_BOT_TOKEN:-}}"
TELEGRAM_CHAT_ID="${WATCHDOG_TELEGRAM_CHAT_ID:-${TELEGRAM_CHAT_ID:-}}"
PAPERCLIP_API_URL="${WATCHDOG_PAPERCLIP_API_URL:-${PAPERCLIP_API_URL:-}}"
PAPERCLIP_API_KEY="${WATCHDOG_PAPERCLIP_API_KEY:-${PAPERCLIP_API_KEY:-}}"
PAPERCLIP_COMPANY_ID="${WATCHDOG_PAPERCLIP_COMPANY_ID:-${PAPERCLIP_COMPANY_ID:-}}"
PAPERCLIP_ALERT_ASSIGNEE="${WATCHDOG_PAPERCLIP_ALERT_ASSIGNEE:-}"

mkdir -p "$STATE_DIR"
touch "$LOG_FILE"

if [[ -f "$STATE_FILE" ]]; then
  # shellcheck source=/dev/null
  source "$STATE_FILE"
fi

STATE_INITIALIZED_AT="${STATE_INITIALIZED_AT:-$NOW_EPOCH}"
STATE_UNHEALTHY_STREAK="${STATE_UNHEALTHY_STREAK:-0}"
STATE_PAPERCLIP_RESTARTS="${STATE_PAPERCLIP_RESTARTS:-}"
STATE_CLOUDFLARED_RESTARTS="${STATE_CLOUDFLARED_RESTARTS:-}"
STATE_ENFORCEMENT="${STATE_ENFORCEMENT:-dry_run}"

if (( NOW_EPOCH - STATE_INITIALIZED_AT >= DRY_RUN_SECONDS )); then
  if [[ "$STATE_ENFORCEMENT" != "enforce" ]]; then
    STATE_ENFORCEMENT="enforce"
    DRY_RUN_SWITCHED=true
  fi
fi

MODE="$STATE_ENFORCEMENT"
if [[ "$MODE" != "enforce" ]]; then
  MODE="dry_run"
fi

log_line() {
  local level="$1"
  shift
  printf '%s [%s] %s\n' "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" "$level" "$*" | tee -a "$LOG_FILE" >/dev/null
}

send_telegram() {
  local text="$1"
  if [[ -z "$TELEGRAM_BOT_TOKEN" || -z "$TELEGRAM_CHAT_ID" ]]; then
    return 0
  fi
  curl -sS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -H "Content-Type: application/json" \
    -d "{\"chat_id\":\"${TELEGRAM_CHAT_ID}\",\"text\":\"${text//\"/\\\"}\"}" >/dev/null || true
}

create_proposal() {
  local title="$1"
  local body="$2"
  if [[ -z "$PAPERCLIP_API_URL" || -z "$PAPERCLIP_API_KEY" || -z "$PAPERCLIP_COMPANY_ID" ]]; then
    return 0
  fi
  local payload="{\"title\":\"${title//\"/\\\"}\",\"description\":\"${body//\"/\\\"}\",\"status\":\"todo\",\"priority\":\"high\""
  if [[ -n "$PAPERCLIP_ALERT_ASSIGNEE" ]]; then
    payload="${payload},\"assigneeAgentId\":\"${PAPERCLIP_ALERT_ASSIGNEE}\""
  fi
  payload="${payload}}"
  curl -sS -X POST "${PAPERCLIP_API_URL}/api/companies/${PAPERCLIP_COMPANY_ID}/issues" \
    -H "Authorization: Bearer ${PAPERCLIP_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "$payload" >/dev/null || true
}

collect_log_tail() {
  tail -n 20 "$SERVER_LOG_FILE" 2>/dev/null || echo "server log unavailable"
}

save_state() {
  cat >"$STATE_FILE" <<EOF
STATE_INITIALIZED_AT=$STATE_INITIALIZED_AT
STATE_UNHEALTHY_STREAK=$STATE_UNHEALTHY_STREAK
STATE_PAPERCLIP_RESTARTS=$STATE_PAPERCLIP_RESTARTS
STATE_CLOUDFLARED_RESTARTS=$STATE_CLOUDFLARED_RESTARTS
STATE_ENFORCEMENT=$STATE_ENFORCEMENT
EOF
}

trim_restart_series() {
  local series="$1"
  local cutoff="$(( NOW_EPOCH - FLAP_WINDOW_SECONDS ))"
  local out=""
  IFS=',' read -r -a parts <<<"$series"
  for ts in "${parts[@]}"; do
    [[ -z "$ts" ]] && continue
    if (( ts >= cutoff )); then
      out="${out:+$out,}$ts"
    fi
  done
  echo "$out"
}

restart_guarded() {
  local service="$1"
  local reason="$2"
  local severity="$3"
  local state_key="$4"
  local current_series="$5"
  local trimmed
  trimmed="$(trim_restart_series "$current_series")"
  local count=0
  if [[ -n "$trimmed" ]]; then
    IFS=',' read -r -a arr <<<"$trimmed"
    count="${#arr[@]}"
  fi
  if (( count >= FLAP_MAX_RESTARTS )); then
    local msg="CRITICAL: flap protection active for ${service}. ${count} restarts in last 15m. reason=${reason}"
    log_line "CRITICAL" "$msg"
    send_telegram "$msg"
    create_proposal "Paperclip watchdog flap protection (${service})" "$msg\n\nRecent logs:\n$(collect_log_tail)"
    return 1
  fi

  if [[ "$MODE" == "enforce" ]]; then
    systemctl restart "$service"
    log_line "$severity" "action=restart service=$service reason=$reason mode=enforce"
  else
    log_line "$severity" "action=restart service=$service reason=$reason mode=dry_run (not executed)"
  fi

  local next_series="${trimmed:+$trimmed,}$NOW_EPOCH"
  if [[ "$state_key" == "paperclip" ]]; then
    STATE_PAPERCLIP_RESTARTS="$next_series"
  else
    STATE_CLOUDFLARED_RESTARTS="$next_series"
  fi
  local msg="${severity}: watchdog ${service} restart ${MODE} reason=${reason}"
  send_telegram "$msg"
  create_proposal "Paperclip watchdog action (${service})" "$msg\n\nRecent logs:\n$(collect_log_tail)"
  return 0
}

if [[ "${DRY_RUN_SWITCHED:-false}" == "true" ]]; then
  local_msg="INFO: watchdog auto-switched to enforcement after ${DRY_RUN_HOURS}h dry-run window."
  log_line "INFO" "$local_msg"
  send_telegram "$local_msg"
  create_proposal "Paperclip watchdog enforcement enabled" "$local_msg"
fi

HEALTH_STATUS=1
if curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then
  HEALTH_STATUS=0
fi

if (( HEALTH_STATUS == 0 )); then
  STATE_UNHEALTHY_STREAK=0
else
  STATE_UNHEALTHY_STREAK=$(( STATE_UNHEALTHY_STREAK + 1 ))
fi

if (( STATE_UNHEALTHY_STREAK >= 3 )); then
  restart_guarded "paperclip.service" "healthz_unhealthy_3m" "CRITICAL" "paperclip" "$STATE_PAPERCLIP_RESTARTS" || true
fi

DISK_USED="$(df -P / | awk 'NR==2 {gsub("%","",$5); print $5+0}')"
if (( DISK_USED > 90 )); then
  if [[ "$MODE" == "enforce" ]]; then
    logrotate -f /etc/logrotate.d/paperclip || true
    log_line "CRITICAL" "action=logrotate reason=disk>${DISK_USED}% mode=enforce"
  else
    log_line "CRITICAL" "action=logrotate reason=disk>${DISK_USED}% mode=dry_run (not executed)"
  fi
  msg="CRITICAL: disk usage ${DISK_USED}% exceeded 90% threshold."
  send_telegram "$msg"
  create_proposal "Paperclip watchdog disk pressure" "$msg\n\nRecent logs:\n$(collect_log_tail)"
fi

ESTABLISHED_COUNT="$(ss -Htan | awk '$1 == "ESTAB" && ($4 ~ /:3101$/ || $5 ~ /:3101$/) {c++} END {print c+0}')"
if (( ESTABLISHED_COUNT > 200 )); then
  warn_msg="WARNING: established connections on :3101 = ${ESTABLISHED_COUNT} (threshold 200)."
  log_line "WARN" "$warn_msg"
  if (( ESTABLISHED_COUNT > 500 )); then
    restart_guarded "cloudflared-paperclip.service" "established_connections>${ESTABLISHED_COUNT}" "CRITICAL" "cloudflared" "$STATE_CLOUDFLARED_RESTARTS" || true
  else
    create_proposal "Paperclip watchdog warning: high connections" "$warn_msg\n\nRecent logs:\n$(collect_log_tail)"
  fi
fi

CLOSE_WAIT_COUNT="$(ss -Htan | awk '$1 == "CLOSE-WAIT" && ($4 ~ /:3101$/ || $5 ~ /:3101$/) {c++} END {print c+0}')"
if (( CLOSE_WAIT_COUNT > 50 )); then
  restart_guarded "cloudflared-paperclip.service" "close_wait>${CLOSE_WAIT_COUNT}" "CRITICAL" "cloudflared" "$STATE_CLOUDFLARED_RESTARTS" || true
fi

save_state
exit 0
