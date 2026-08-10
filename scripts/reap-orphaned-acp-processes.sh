#!/usr/bin/env bash
#
# reap-orphaned-acp-processes.sh — kill leaked paperclip-process-session-remote.mjs
# processes from any local adapter that outlived the run they belonged to.
#
# The bridge processes are intentionally detached for sandbox execution. A process
# which has been reparented to launchd and survived for hours after its coordinator
# exited is therefore an orphan, not ongoing work.  We require both signatures so
# ordinary long-running work remains untouched.
set -euo pipefail

# A three-hour grace period is deliberately longer than normal run limits and avoids
# touching an unusually long legitimate run that is still completing its hand-off.
GRACE_HOURS=3
# If this age is reached, the hourly cleanup itself needs attention.
STALE_GUARD_HOURS=6

# This remote bridge is shared by ACPX, Codex, Claude, Gemini, and other local
# adapters. The previous ACPX-only matcher left equivalent Codex/Gemini/Claude
# process leaks behind. Keep the path-shaped match and PPID/age guards below:
# broaden adapter coverage, not the definition of an orphan.
PATTERN='paperclip-[^[:space:]]*/remote-workspace/\.paperclip-runtime/[^[:space:]]+/process-sessions/paperclip-process-session-remote\.mjs'

APPLY=0
CHECK_LIVE_STALE=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --check-live-stale) CHECK_LIVE_STALE=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# pid \t ppid \t etime \t args (etime: D-HH:MM:SS, HH:MM:SS, or MM:SS)
snapshot() {
  ps -Ao pid,ppid,etime,args | grep -E "$PATTERN" | grep -v grep || true
}

etime_to_hours() {
  local et="$1" days=0 rest="$1"
  if [[ "$et" == *-* ]]; then
    days="${et%%-*}"
    rest="${et#*-}"
  fi
  local h=0
  case "$(grep -o ':' <<<"$rest" | wc -l | tr -d ' ')" in
    2) h="${rest%%:*}" ;;
    1) h=0 ;;
    *) h=0 ;;
  esac
  echo $((days * 24 + 10#$h))
}

find_orphans() {
  local min_hours="$1"
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    local pid ppid etime rest hours
    pid=$(awk '{print $1}' <<<"$line")
    ppid=$(awk '{print $2}' <<<"$line")
    etime=$(awk '{print $3}' <<<"$line")
    rest=$(cut -d' ' -f4- <<<"$line")
    [[ "$ppid" != "1" ]] && continue
    hours=$(etime_to_hours "$etime")
    if ((hours >= min_hours)); then
      printf '%s\t%s\t%s\t%sh\t%s\n' "$pid" "$ppid" "$etime" "$hours" "$rest"
    fi
  done <<<"$(snapshot)"
}

if [[ "$CHECK_LIVE_STALE" -eq 1 ]]; then
  ORPHANS=$(find_orphans "$STALE_GUARD_HOURS")
  TOTAL=$(grep -c . <<<"$ORPHANS" 2>/dev/null || true)
  [[ -z "$ORPHANS" ]] && TOTAL=0
  echo "== orphaned adapter bridge processes >${STALE_GUARD_HOURS}h (cleanup may be stuck) =="
  [[ -n "$ORPHANS" ]] && echo "$ORPHANS"
  echo "stale_orphaned=${TOTAL}"
  [[ "$TOTAL" != "0" ]] && exit 1
  exit 0
fi

CANDIDATES=$(find_orphans "$GRACE_HOURS")
COUNT=$(grep -c . <<<"$CANDIDATES" 2>/dev/null || true)
[[ -z "$CANDIDATES" ]] && COUNT=0

echo "== orphaned adapter bridge processes (PPID=1, age >= ${GRACE_HOURS}h) =="
[[ -n "$CANDIDATES" ]] && echo "$CANDIDATES"
echo "total orphaned: ${COUNT}"

if [[ "$COUNT" == "0" ]]; then
  echo "nothing to do."
  exit 0
fi

if [[ "$APPLY" -ne 1 ]]; then
  echo
  echo "DRY-RUN — nothing changed. Re-run with --apply to kill the ${COUNT} above."
  exit 0
fi

echo
echo "Applying: SIGTERM ${COUNT} process(es)..."
PIDS=$(cut -f1 <<<"$CANDIDATES")
for pid in $PIDS; do
  kill -TERM "$pid" 2>/dev/null || true
done

sleep 5

SURVIVORS=""
for pid in $PIDS; do
  kill -0 "$pid" 2>/dev/null && SURVIVORS="${SURVIVORS}${pid} "
done

if [[ -n "$SURVIVORS" ]]; then
  echo "SIGKILL survivors: ${SURVIVORS}"
  for pid in $SURVIVORS; do
    kill -KILL "$pid" 2>/dev/null || true
  done
  sleep 2
fi

REMAINING=0
for pid in $PIDS; do
  kill -0 "$pid" 2>/dev/null && REMAINING=$((REMAINING + 1))
done
echo "remaining=${REMAINING}"
if [[ "$REMAINING" != "0" ]]; then
  echo "ERROR: reaper left ${REMAINING} orphaned process(es) behind" >&2
  exit 1
fi
echo "done."
