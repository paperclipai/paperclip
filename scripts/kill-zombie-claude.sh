#!/bin/bash
# Safety net: kill claude processes with >360 accumulated CPU-minutes.
# Runs via launchd every 30 minutes.
#
# Targets orphaned "claude" child processes that the adapter lost track of.
# Excludes the Paperclip server itself (matches "paperclip" in command).

set -euo pipefail

LOG="$HOME/Library/Logs/claude-zombie-cleanup.log"
THRESHOLD_SECONDS=21600  # 360 minutes * 60

log() {
  echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"
}

# Parse ps output: cputime pid command
# cputime format is HH:MM:SS (or H:MM:SS)
ps -eo cputime=,pid=,command= 2>/dev/null | while IFS= read -r line; do
  # Skip empty lines
  [ -z "$line" ] && continue

  # Extract HH:MM:SS, PID, and command
  cputime=$(echo "$line" | awk '{print $1}')
  pid=$(echo "$line" | awk '{print $2}')
  command=$(echo "$line" | awk '{for(i=3;i<=NF;i++) printf "%s ", $i; print ""}')

  # Only target claude processes (case-insensitive)
  echo "$command" | grep -qi "claude" || continue

  # Exclude the Paperclip server itself
  echo "$command" | grep -qi "paperclip" && continue

  # Convert HH:MM:SS to seconds
  hours=$(echo "$cputime" | cut -d: -f1)
  minutes=$(echo "$cputime" | cut -d: -f2)
  seconds=$(echo "$cputime" | cut -d: -f3)
  total_seconds=$(( 10#$hours * 3600 + 10#$minutes * 60 + 10#$seconds ))

  # Check threshold
  if [ "$total_seconds" -gt "$THRESHOLD_SECONDS" ]; then
    log "KILL pid=$pid cpu=${cputime} (${total_seconds}s) cmd=$command"

    # Send SIGTERM first
    kill -TERM "$pid" 2>/dev/null || {
      log "  SIGTERM failed for pid=$pid (already dead?)"
      continue
    }

    # Wait 5 seconds then check if still alive
    sleep 5
    if kill -0 "$pid" 2>/dev/null; then
      kill -KILL "$pid" 2>/dev/null || true
      log "  Escalated to SIGKILL for pid=$pid"
    else
      log "  pid=$pid exited after SIGTERM"
    fi
  fi
done

exit 0
