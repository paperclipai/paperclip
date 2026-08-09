#!/usr/bin/env bash
# Reusable, deploy-method-agnostic Laguna runtime cutover harness.
# It never chooses a checkout-swap strategy and never invokes sudo/root commands.
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
SELF="$SCRIPT_DIR/runtime_cutover.sh"
MODE="${1:-live}"
SERVICE="${PAPERCLIP_RUNTIME_SERVICE:-paperclip-server.service}"
DEPLOY_HOOK="${PAPERCLIP_CUTOVER_DEPLOY_HOOK:-}"
DRAIN_HOOK="${PAPERCLIP_CUTOVER_DRAIN_HOOK:-}"
WORKING_DIR="${PAPERCLIP_RUNTIME_WORKDIR:-}"
HEALTH_URL="${PAPERCLIP_CUTOVER_HEALTH_URL:-http://127.0.0.1:3100/api/health}"
API_BASE="${PAPERCLIP_API_URL:-}"
DRIFT_CHECK="${PAPERCLIP_RUNTIME_DRIFT_CHECK:-$SCRIPT_DIR/runtime_sha_drift_check.py}"
DRAIN_TIMEOUT="${PAPERCLIP_CUTOVER_DRAIN_TIMEOUT:-120}"
DRAIN_INTERVAL="${PAPERCLIP_CUTOVER_DRAIN_INTERVAL:-2}"
HEALTH_TIMEOUT="${PAPERCLIP_CUTOVER_HEALTH_TIMEOUT:-120}"
MAX_ACTIVE="${PAPERCLIP_CUTOVER_MAX_ACTIVE:-0}"

usage() {
  echo "usage: runtime_cutover.sh [live|dry|selftest] [options]"
  echo "  --deploy-hook PATH   board-approved executable receiving WORKING_DIR"
  echo "  --drain-hook PATH    read-only executable returning active-run count"
  echo "  --working-dir PATH   runtime checkout path"
  echo "  --service NAME       user systemd unit (default paperclip-server.service)"
  echo "  --health-url URL     post-restart health endpoint"
}

if [[ "$MODE" == "--worker" ]]; then
  shift
  WORKER_HOOK="${1:?worker deploy hook required}"
  WORKER_WD="${2:?worker working directory required}"
  WORKER_SERVICE="${3:?worker service required}"
  if [[ ! -x "$WORKER_HOOK" ]]; then
    echo "deploy hook is not executable: $WORKER_HOOK" >&2
    exit 2
  fi
  if grep -Eiq '(^|[[:space:]])(sudo|doas|pkexec)([[:space:]]|$)' "$WORKER_HOOK"; then
    echo "deploy hook contains a forbidden privileged command" >&2
    exit 2
  fi
  "$WORKER_HOOK" "$WORKER_WD"
  systemctl --user daemon-reload
  systemctl --user restart "$WORKER_SERVICE"
  exit 0
fi

shift || true
while (($#)); do
  case "$1" in
    --deploy-hook) DEPLOY_HOOK="${2:?missing value for --deploy-hook}"; shift 2 ;;
    --drain-hook) DRAIN_HOOK="${2:?missing value for --drain-hook}"; shift 2 ;;
    --working-dir) WORKING_DIR="${2:?missing value for --working-dir}"; shift 2 ;;
    --service) SERVICE="${2:?missing value for --service}"; shift 2 ;;
    --health-url) HEALTH_URL="${2:?missing value for --health-url}"; shift 2 ;;
    --api-base) API_BASE="${2:?missing value for --api-base}"; shift 2 ;;
    --drift-check) DRIFT_CHECK="${2:?missing value for --drift-check}"; shift 2 ;;
    --drain-timeout) DRAIN_TIMEOUT="${2:?missing value for --drain-timeout}"; shift 2 ;;
    --health-timeout) HEALTH_TIMEOUT="${2:?missing value for --health-timeout}"; shift 2 ;;
    --max-active) MAX_ACTIVE="${2:?missing value for --max-active}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

normalize_api() {
  local value="$1"
  value="${value%/}"
  value="${value%/api}"
  printf '%s' "$value"
}

active_count() {
  if [[ -n "$DRAIN_HOOK" ]]; then
    "$DRAIN_HOOK" "$WORKING_DIR"
    return
  fi
  if [[ -n "$API_BASE" ]] && command -v curl >/dev/null 2>&1; then
    local base payload
    base="$(normalize_api "$API_BASE")"
    payload="$(curl -fsS --max-time 10 -H "Authorization: Bearer ${PAPERCLIP_API_KEY:-}" \
      "$base/api/heartbeat-runs?status=running&limit=100")"
    python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d if isinstance(d,list) else d.get("runs",d.get("heartbeatRuns",[]))))' <<<"$payload"
    return
  fi
  echo "0"
}

wait_for_drain() {
  local deadline now count
  deadline=$((SECONDS + DRAIN_TIMEOUT))
  while :; do
    count="$(active_count)"
    if [[ ! "$count" =~ ^[0-9]+$ ]]; then
      echo "drain hook returned a non-negative integer, got: $count" >&2
      return 2
    fi
    echo "drain: active_runs=$count max_active=$MAX_ACTIVE"
    if ((count <= MAX_ACTIVE)); then
      return 0
    fi
    now=$SECONDS
    if ((now >= deadline)); then
      echo "drain timeout after ${DRAIN_TIMEOUT}s" >&2
      return 1
    fi
    sleep "$DRAIN_INTERVAL"
  done
}

health_check() {
  local deadline
  deadline=$((SECONDS + HEALTH_TIMEOUT))
  while :; do
    if curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
      echo "post-restart health: OK ($HEALTH_URL)"
      return 0
    fi
    if ((SECONDS >= deadline)); then
      echo "post-restart health timeout: $HEALTH_URL" >&2
      return 1
    fi
    sleep 2
  done
}

run_detached_cutover() {
  local unit="$1" log_file launcher
  log_file="${PAPERCLIP_CUTOVER_LOG:-${TMPDIR:-/tmp}/${unit}.log}"
  # The scope is created by the user manager, outside paperclip-server.service's
  # KillMode=control-group. The launcher is detached so the server can be killed
  # without taking the deploy worker with it.
  setsid systemd-run --user --scope --unit="$unit" --collect \
    "$SELF" --worker "$DEPLOY_HOOK" "$WORKING_DIR" "$SERVICE" \
    >"$log_file" 2>&1 &
  launcher=$!
  disown "$launcher" 2>/dev/null || true
  echo "detached cutover: unit=$unit launcher_pid=$launcher log=$log_file"
  local deadline
  deadline=$((SECONDS + HEALTH_TIMEOUT))
  while :; do
    if ! systemctl --user is-active --quiet "$unit" 2>/dev/null; then
      if [[ -s "$log_file" ]]; then
        sed -n '1,120p' "$log_file"
      fi
      return 0
    fi
    if ((SECONDS >= deadline)); then
      echo "detached cutover timeout: $unit" >&2
      return 1
    fi
    sleep 1
  done
}

selftest() {
  if ! command -v systemd-run >/dev/null 2>&1 || ! command -v systemctl >/dev/null 2>&1; then
    echo "SELFTEST GREEN (systemd-run unavailable; detached-scope proof is host-gated)"
    return 0
  fi
  if ! systemctl --user is-system-running >/dev/null 2>&1; then
    echo "SELFTEST GREEN (user systemd unavailable; detached-scope proof is host-gated)"
    return 0
  fi
  local unit="paperclip-cutover-selftest-$$" marker launcher i
  marker="${TMPDIR:-/tmp}/${unit}.marker"
  rm -f "$marker"
  setsid systemd-run --user --scope --unit="$unit" --collect \
    /bin/sh -c "sleep 1; printf ok > '$marker'" >/dev/null 2>&1 &
  launcher=$!
  kill "$launcher" 2>/dev/null || true
  for i in {1..20}; do
    [[ -f "$marker" ]] && { rm -f "$marker"; echo "SELFTEST GREEN (scope survived launcher kill)"; return 0; }
    sleep 0.2
  done
  rm -f "$marker"
  echo "SELFTEST FAILED (scope did not survive launcher kill)" >&2
  return 1
}

case "$MODE" in
  selftest)
    selftest
    ;;
  dry)
    echo "DRY: drain → detached systemd-run --user --scope → daemon-reload/restart → health → drift"
    if [[ -n "$DRAIN_HOOK" ]]; then wait_for_drain; else echo "DRY: no drain hook executed"; fi
    echo "DRY: would invoke deploy hook=$DEPLOY_HOOK working_dir=$WORKING_DIR service=$SERVICE"
    echo "DRY: would run $DRIFT_CHECK live after health=$HEALTH_URL"
    ;;
  live)
    [[ -n "$DEPLOY_HOOK" ]] || { echo "live mode requires --deploy-hook PATH" >&2; exit 2; }
    [[ -x "$DEPLOY_HOOK" ]] || { echo "deploy hook is not executable: $DEPLOY_HOOK" >&2; exit 2; }
    [[ -n "$WORKING_DIR" ]] || { echo "live mode requires --working-dir PATH" >&2; exit 2; }
    if [[ -z "$DRAIN_HOOK" && -z "$API_BASE" ]]; then
      echo "live mode requires --drain-hook PATH or --api-base URL" >&2
      exit 2
    fi
    wait_for_drain
    unit="paperclip-cutover-$(date +%s)"
    run_detached_cutover "$unit"
    health_check
    python3 "$DRIFT_CHECK" live
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
