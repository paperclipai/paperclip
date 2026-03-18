#!/usr/bin/env bash
#
# Kill all local Paperclip dev server processes (across all worktrees).
#
# Usage:
#   scripts/kill-dev.sh        # kill all paperclip dev processes
#   scripts/kill-dev.sh --dry  # preview what would be killed
#

set -euo pipefail

DRY_RUN=false
if [[ "${1:-}" == "--dry" || "${1:-}" == "--dry-run" || "${1:-}" == "-n" ]]; then
  DRY_RUN=true
fi

# Collect PIDs of node processes running from any paperclip directory.
# Matches paths like /Users/*/paperclip/... or /Users/*/paperclip-*/...
# Excludes postgres-related processes.
pids=()
lines=()

while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  # skip postgres processes
  [[ "$line" == *postgres* ]] && continue
  pid=$(echo "$line" | awk '{print $2}')
  pids+=("$pid")
  lines+=("$line")
done < <(ps aux | grep -E '/paperclip(-[^/]+)?/' | grep node | grep -v grep || true)

if [[ ${#pids[@]} -eq 0 ]]; then
  echo "No Paperclip dev processes found."
  exit 0
fi

echo "Found ${#pids[@]} Paperclip dev process(es):"
echo ""

for i in "${!pids[@]}"; do
  line="${lines[$i]}"
  pid=$(echo "$line" | awk '{print $2}')
  start=$(echo "$line" | awk '{print $9}')
  cmd=$(echo "$line" | awk '{for(i=11;i<=NF;i++) printf "%s ", $i; print ""}')
  # Shorten the command for readability
  cmd=$(echo "$cmd" | sed "s|$HOME/||g")
  printf "  PID %-7s  started %-10s  %s\n" "$pid" "$start" "$cmd"
done

echo ""

if [[ "$DRY_RUN" == true ]]; then
  echo "Dry run — re-run without --dry to kill these processes."
  exit 0
fi

echo "Sending SIGTERM..."
for pid in "${pids[@]}"; do
  kill "$pid" 2>/dev/null && echo "  killed $pid" || echo "  $pid already gone"
done

# Give processes a moment to exit, then SIGKILL any stragglers
sleep 2
for pid in "${pids[@]}"; do
  if kill -0 "$pid" 2>/dev/null; then
    echo "  $pid still alive, sending SIGKILL..."
    kill -9 "$pid" 2>/dev/null || true
  fi
done

echo "Done."
