#!/usr/bin/env bash
# reap-orphan-opencode.sh — kill reparented opencode (models|run) processes that
# outlived their spawner.  Safe to run as a preflight step; always exits 0.
#
# Env knobs:
#   REAP_AGE_SEC   minimum elapsed seconds before a candidate is eligible (default 300)
#   REAP_DRY_RUN   set to 1 to log candidates without killing (default 0)
#   REAP_LOG       path of the append-only logfile (default /tmp/reap-orphan-opencode.log)
set -euo pipefail

REAP_AGE_SEC="${REAP_AGE_SEC:-300}"
REAP_DRY_RUN="${REAP_DRY_RUN:-0}"
REAP_LOG="${REAP_LOG:-/tmp/reap-orphan-opencode.log}"
GRACE_SEC=3

log() {
  local msg="$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"
  echo "$msg" | tee -a "$REAP_LOG"
}

# is_orphan pid ppid parent_comm etimes
# Returns 0 (true) if the process should be reaped, 1 otherwise.
# Exported so the test suite can source just this function.
is_orphan() {
  local pid="$1" ppid="$2" parent_comm="$3" etimes="$4"

  # Must be old enough.
  if [[ "$etimes" -lt "$REAP_AGE_SEC" ]]; then
    return 1
  fi

  # Belt-and-suspenders: never reap if parent is a live orchestration process.
  case "$parent_comm" in
    node|opencode|paperclipai|heartbeat*)
      return 1
      ;;
  esac

  # Orphaned: original spawner is dead — process reparented to init/systemd.
  if [[ "$ppid" -eq 1 ]]; then
    return 0
  fi
  case "$parent_comm" in
    systemd*|init*)
      return 0
      ;;
  esac

  return 1
}

reap_one() {
  local pid="$1" etimes="$2" cmd="$3"

  if [[ "$REAP_DRY_RUN" == "1" ]]; then
    log "DRY-RUN would-reap pid=$pid age=${etimes}s cmd=$cmd"
    return 0
  fi

  log "REAP pid=$pid age=${etimes}s cmd=$cmd sending SIGTERM"
  kill -TERM "$pid" 2>/dev/null || true

  local i
  for i in $(seq 1 "$GRACE_SEC"); do
    sleep 1
    if ! kill -0 "$pid" 2>/dev/null; then
      log "REAPED pid=$pid exited after ${i}s"
      return 0
    fi
  done

  log "KILL pid=$pid still alive after ${GRACE_SEC}s grace, sending SIGKILL"
  kill -KILL "$pid" 2>/dev/null || true
  log "REAPED pid=$pid SIGKILL sent"
}

main() {
  local reaped=0

  # Snapshot process table once; columns: pid ppid etimes args
  local ps_out
  ps_out="$(ps -eo pid=,ppid=,etimes=,args= 2>/dev/null)" || {
    log "ERROR ps failed; aborting scan"
    return 0
  }

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue

    local pid ppid etimes args
    read -r pid ppid etimes args <<< "$line"

    # Only examine opencode processes running "models" or "run" sub-command.
    case "$args" in
      *opencode*\ models*|*opencode*\ run\ *|*opencode*\ run)
        ;;
      *)
        continue
        ;;
    esac

    # Look up the parent process name.
    local parent_comm=""
    parent_comm="$(ps -p "$ppid" -o comm= 2>/dev/null | tr -d ' ')" || true

    if is_orphan "$pid" "$ppid" "$parent_comm" "$etimes"; then
      reap_one "$pid" "$etimes" "$args"
      ((reaped++)) || true
    fi
  done <<< "$ps_out"

  log "SCAN done reaped=$reaped"
}

# Allow tests to source this file without triggering main or exit.
# Detect sourcing: BASH_SOURCE[0] != $0 means we are being sourced.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
  exit 0
fi
