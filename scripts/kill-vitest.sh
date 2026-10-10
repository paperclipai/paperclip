#!/usr/bin/env bash
#
# Kill all running vitest processes.
#
# Usage:
#   scripts/kill-vitest.sh        # kill all
#   scripts/kill-vitest.sh --dry   # preview what would be killed
#

set -euo pipefail

DRY_RUN=false
if [[ "${1:-}" == "--dry" || "${1:-}" == "--dry-run" || "${1:-}" == "-n" ]]; then
  DRY_RUN=true
fi

pids=()
lines=()

while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  pid=$(echo "$line" | awk '{print $2}')
  pids+=("$pid")
  lines+=("$line")
done < <(ps aux | grep -E '(^|/)(vitest|node .*/vitest)( |$)|/\.bin/vitest|vitest/dist|vitest\.mjs' | grep -v grep || true)

if [[ ${#pids[@]} -eq 0 ]]; then
  echo "No vitest processes found."
  exit 0
fi

echo "Found ${#pids[@]} vitest process(es):"
echo ""

for i in "${!pids[@]}"; do
  line="${lines[$i]}"
  pid=$(echo "$line" | awk '{print $2}')
  start=$(echo "$line" | awk '{print $9}')
  cmd=$(echo "$line" | awk '{for(i=11;i<=NF;i++) printf "%s ", $i; print ""}')
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
  kill -TERM "$pid" 2>/dev/null && echo "  signaled $pid" || echo "  $pid already gone"
done

sleep 2

for pid in "${pids[@]}"; do
  if kill -0 "$pid" 2>/dev/null; then
    echo "  $pid still alive, sending SIGKILL..."
    kill -KILL "$pid" 2>/dev/null || true
  fi
done

echo "Done."
