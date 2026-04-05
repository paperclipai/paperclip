#!/usr/bin/env bash
#
# Kill all local Paperclip dev server processes (across all worktrees).
#
# Does NOT kill processes started under LaunchAgent when they set
# PAPERCLIP_MANAGED_BY_LAUNCHD=1 (see contrib/macos-launchagent/). To stop
# that service use: launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/io.paperclip.local.plist
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

# macOS: wide ps output includes process environment; LaunchAgent should set PAPERCLIP_MANAGED_BY_LAUNCHD=1.
is_launchagent_paperclip_service() {
  local pid="$1"
  local cmd
  cmd=$(ps wwwe -p "$pid" -o command= 2>/dev/null || true)
  [[ "$cmd" == *"PAPERCLIP_MANAGED_BY_LAUNCHD=1"* ]] && return 0
  [[ "$cmd" == *"PAPERCLIP_MANAGED_BY_LAUNCHD=true"* ]] && return 0
  return 1
}

# Collect PIDs of node processes running from any paperclip directory.
# Matches paths like /Users/*/paperclip/... or /Users/*/paperclip-*/...
# Excludes postgres-related processes.
pids=()
lines=()
skipped_launchd=0

while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  # skip postgres processes
  [[ "$line" == *postgres* ]] && continue
  pid=$(echo "$line" | awk '{print $2}')
  if is_launchagent_paperclip_service "$pid"; then
    skipped_launchd=$((skipped_launchd + 1))
    continue
  fi
  pids+=("$pid")
  lines+=("$line")
done < <(ps aux | grep -E '/paperclip(-[^/]+)?/' | grep node | grep -v grep || true)

if [[ $skipped_launchd -gt 0 ]]; then
  echo "Skipped $skipped_launchd process(es) marked PAPERCLIP_MANAGED_BY_LAUNCHD (LaunchAgent service)."
  echo ""
fi

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
