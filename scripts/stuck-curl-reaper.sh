#!/usr/bin/env bash
# stuck-curl-reaper.sh — Kill curl processes stuck on Paperclip's internal API port.
#
# Detects curl processes with an established TCP connection to 127.0.0.1:3100
# that are older than REAPER_MAX_AGE_SEC (default: 60s). Logs PID, PPID,
# command, and process age, then sends SIGTERM. After REAPER_KILL_GRACE_SEC
# (default: 5s), sends SIGKILL to any survivors.
#
# Intended to run every 30s via the paperclip-curl-reaper.timer systemd unit.
#
# Environment:
#   REAPER_MAX_AGE_SEC     — kill threshold in seconds (default: 60)
#   REAPER_KILL_GRACE_SEC  — SIGTERM→SIGKILL grace period in seconds (default: 5)
#   PAPERCLIP_PORT         — Paperclip API port (default: 3100)
#   REAPER_LOG_FILE        — append-only log file (default: /var/log/paperclip/curl-reaper.log)

set -euo pipefail

MAX_AGE_SEC="${REAPER_MAX_AGE_SEC:-60}"
KILL_GRACE_SEC="${REAPER_KILL_GRACE_SEC:-5}"
PAPERCLIP_PORT="${PAPERCLIP_PORT:-3100}"
LOG_FILE="${REAPER_LOG_FILE:-/var/log/paperclip/curl-reaper.log}"
PREFIX="[curl-reaper]"

log() {
  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$PREFIX $ts $*" | tee -a "$LOG_FILE" 2>/dev/null || echo "$PREFIX $ts $*"
}

# Ensure log directory exists
mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true

# Clock ticks per second (typically 100)
HZ="$(getconf CLK_TCK 2>/dev/null || echo 100)"

# Uptime in seconds (integer)
UPTIME_SEC="$(awk '{printf "%d", $1}' /proc/uptime 2>/dev/null || echo 0)"

# Find PIDs with ESTAB TCP connection to :$PAPERCLIP_PORT
declare -a CANDIDATE_PIDS=()
while IFS= read -r pid; do
  [[ -n "$pid" ]] && CANDIDATE_PIDS+=("$pid")
done < <(
  ss -tnp "dst :${PAPERCLIP_PORT}" 2>/dev/null \
    | grep ESTAB \
    | grep -oP 'pid=\K[0-9]+' \
    | sort -u \
  || true
)

if [[ ${#CANDIDATE_PIDS[@]} -eq 0 ]]; then
  exit 0
fi

REAP_COUNT=0
SCAN_COUNT=${#CANDIDATE_PIDS[@]}

for pid in "${CANDIDATE_PIDS[@]}"; do
  # Verify PID is curl
  [[ -f "/proc/$pid/exe" ]] || continue
  exe="$(readlink -f "/proc/$pid/exe" 2>/dev/null || echo "")"
  if [[ "$exe" != *curl* ]]; then
    continue
  fi

  # Read stat for start time (field 22) and PPID (field 4)
  [[ -f "/proc/$pid/stat" ]] || continue
  stat_line="$(cat "/proc/$pid/stat" 2>/dev/null || echo "")"
  [[ -n "$stat_line" ]] || continue

  # PPID is field 4, start_ticks is field 22
  ppid="$(echo "$stat_line" | awk '{print $4}')"
  start_ticks="$(echo "$stat_line" | awk '{print $22}')"

  # Age in seconds
  start_sec=$(( start_ticks / HZ ))
  age_sec=$(( UPTIME_SEC - start_sec ))

  if [[ $age_sec -lt $MAX_AGE_SEC ]]; then
    continue
  fi

  # Capture command line (truncated to 300 chars)
  cmd="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | cut -c1-300 || echo '?')"

  # Attempt to identify owning agent/run via parent chain
  run_context=""
  ppid_check="$ppid"
  for _ in 1 2 3 4; do
    [[ "$ppid_check" =~ ^[0-9]+$ ]] || break
    [[ -f "/proc/$ppid_check/cmdline" ]] || break
    pcmd="$(tr '\0' ' ' < "/proc/$ppid_check/cmdline" 2>/dev/null | cut -c1-150 || echo '')"
    if [[ "$pcmd" == *"PAPERCLIP_RUN_ID"* || "$pcmd" == *"paperclipai"* || "$pcmd" == *"claude"* ]]; then
      run_context=" parent_context=${pcmd:0:80}"
      break
    fi
    ppid_check="$(awk '{print $4}' "/proc/$ppid_check/stat" 2>/dev/null || echo '')"
  done

  log "REAP pid=$pid ppid=$ppid age=${age_sec}s exe=$exe$run_context cmd=$cmd"

  # SIGTERM
  kill -TERM "$pid" 2>/dev/null && REAP_COUNT=$(( REAP_COUNT + 1 )) || {
    log "SKIP pid=$pid — could not send SIGTERM (already gone?)"
    continue
  }

  # SIGKILL after grace period (background)
  (
    sleep "$KILL_GRACE_SEC"
    if kill -0 "$pid" 2>/dev/null; then
      log "SIGKILL pid=$pid (survived ${KILL_GRACE_SEC}s after SIGTERM)"
      kill -KILL "$pid" 2>/dev/null || true
    fi
  ) &
done

if [[ $REAP_COUNT -gt 0 ]]; then
  log "Done: scanned $SCAN_COUNT curl PIDs, reaped $REAP_COUNT stuck (>=${MAX_AGE_SEC}s)"
fi

exit 0
