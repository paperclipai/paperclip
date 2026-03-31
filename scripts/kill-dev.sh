#!/usr/bin/env bash
#
# Kill all local Paperclip dev server processes (across all worktrees).
#
# Usage:
#   scripts/kill-dev.sh        # kill all paperclip dev processes
#   scripts/kill-dev.sh --dry  # preview what would be killed
#

set -euo pipefail
shopt -s nullglob

DRY_RUN=false
if [[ "${1:-}" == "--dry" || "${1:-}" == "--dry-run" || "${1:-}" == "-n" ]]; then
  DRY_RUN=true
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_PARENT="$(dirname "$REPO_ROOT")"

node_pids=()
node_lines=()
pg_pids=()
pg_pidfiles=()
pg_data_dirs=()

is_pid_running() {
  local pid="$1"
  kill -0 "$pid" 2>/dev/null
}

read_pidfile_pid() {
  local pidfile="$1"
  local first_line
  first_line="$(head -n 1 "$pidfile" 2>/dev/null | tr -d '[:space:]' || true)"
  if [[ "$first_line" =~ ^[0-9]+$ ]] && (( first_line > 0 )); then
    printf '%s\n' "$first_line"
    return 0
  fi
  return 1
}

command_for_pid() {
  local pid="$1"
  ps -o command= -p "$pid" 2>/dev/null || true
}

append_postgres_from_pidfile() {
  local pidfile="$1"
  local pid cmd data_dir
  pid="$(read_pidfile_pid "$pidfile" || true)"
  [[ -n "$pid" ]] || return 0
  is_pid_running "$pid" || return 0
  cmd="$(command_for_pid "$pid")"
  [[ "$cmd" == *postgres* ]] || return 0

  for existing_pid in "${pg_pids[@]:-}"; do
    [[ "$existing_pid" == "$pid" ]] && return 0
  done

  data_dir="$(dirname "$pidfile")"
  pg_pids+=("$pid")
  pg_pidfiles+=("$pidfile")
  pg_data_dirs+=("$data_dir")
}

wait_for_pid_exit() {
  local pid="$1"
  local timeout_sec="$2"
  local waited=0
  while is_pid_running "$pid"; do
    if (( waited >= timeout_sec * 10 )); then
      return 1
    fi
    sleep 0.1
    ((waited += 1))
  done
  return 0
}

while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  [[ "$line" == *postgres* ]] && continue
  pid=$(echo "$line" | awk '{print $2}')
  node_pids+=("$pid")
  node_lines+=("$line")
done < <(ps aux | grep -E '/paperclip(-[^/]+)?/' | grep node | grep -v grep || true)

candidate_pidfiles=()
candidate_pidfiles+=(
  "$HOME"/.paperclip/instances/*/db/postmaster.pid
  "$REPO_ROOT"/.paperclip/instances/*/db/postmaster.pid
  "$REPO_ROOT"/.paperclip/runtime-services/instances/*/db/postmaster.pid
)

for sibling_root in "$REPO_PARENT"/paperclip*; do
  [[ -d "$sibling_root" ]] || continue
  candidate_pidfiles+=(
    "$sibling_root"/.paperclip/instances/*/db/postmaster.pid
    "$sibling_root"/.paperclip/runtime-services/instances/*/db/postmaster.pid
  )
done

for pidfile in "${candidate_pidfiles[@]:-}"; do
  [[ -f "$pidfile" ]] || continue
  append_postgres_from_pidfile "$pidfile"
done

if [[ ${#node_pids[@]} -eq 0 && ${#pg_pids[@]} -eq 0 ]]; then
  echo "No Paperclip dev processes found."
  exit 0
fi

if [[ ${#node_pids[@]} -gt 0 ]]; then
  echo "Found ${#node_pids[@]} Paperclip dev node process(es):"
  echo ""

  for i in "${!node_pids[@]:-}"; do
    line="${node_lines[$i]}"
    pid=$(echo "$line" | awk '{print $2}')
    start=$(echo "$line" | awk '{print $9}')
    cmd=$(echo "$line" | awk '{for(i=11;i<=NF;i++) printf "%s ", $i; print ""}')
    cmd=$(echo "$cmd" | sed "s|$HOME/||g")
    printf "  PID %-7s  started %-10s  %s\n" "$pid" "$start" "$cmd"
  done

  echo ""
fi

if [[ ${#pg_pids[@]} -gt 0 ]]; then
  echo "Found ${#pg_pids[@]} embedded PostgreSQL master process(es):"
  echo ""

  for i in "${!pg_pids[@]:-}"; do
    pid="${pg_pids[$i]}"
    data_dir="${pg_data_dirs[$i]}"
    pidfile="${pg_pidfiles[$i]}"
    short_data_dir="${data_dir/#$HOME\//}"
    short_pidfile="${pidfile/#$HOME\//}"
    printf "  PID %-7s  data %-55s  pidfile %s\n" "$pid" "$short_data_dir" "$short_pidfile"
  done

  echo ""
fi

if [[ "$DRY_RUN" == true ]]; then
  echo "Dry run — re-run without --dry to kill these processes."
  exit 0
fi

if [[ ${#node_pids[@]} -gt 0 ]]; then
  echo "Sending SIGTERM to Paperclip node processes..."
  for pid in "${node_pids[@]}"; do
    kill -TERM "$pid" 2>/dev/null && echo "  signaled $pid" || echo "  $pid already gone"
  done
  echo "Waiting briefly for node processes to exit..."
  sleep 2
fi

leftover_pg_pids=()
leftover_pg_data_dirs=()
for i in "${!pg_pids[@]:-}"; do
  pid="${pg_pids[$i]}"
  if is_pid_running "$pid"; then
    leftover_pg_pids+=("$pid")
    leftover_pg_data_dirs+=("${pg_data_dirs[$i]}")
  fi
done

if [[ ${#leftover_pg_pids[@]} -gt 0 ]]; then
  echo "Sending SIGTERM to leftover embedded PostgreSQL processes..."
  for i in "${!leftover_pg_pids[@]:-}"; do
    pid="${leftover_pg_pids[$i]}"
    data_dir="${leftover_pg_data_dirs[$i]}"
    kill -TERM "$pid" 2>/dev/null \
      && echo "  signaled $pid ($data_dir)" \
      || echo "  $pid already gone"
  done
  echo "Waiting up to 15s for PostgreSQL to shut down cleanly..."
  for pid in "${leftover_pg_pids[@]:-}"; do
    if wait_for_pid_exit "$pid" 15; then
      echo "  postgres $pid exited cleanly"
    fi
  done
fi

if [[ ${#node_pids[@]} -gt 0 ]]; then
  for pid in "${node_pids[@]:-}"; do
    if kill -0 "$pid" 2>/dev/null; then
      echo "  node $pid still alive, sending SIGKILL..."
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done
fi

if [[ ${#pg_pids[@]} -gt 0 ]]; then
  for pid in "${pg_pids[@]:-}"; do
    if kill -0 "$pid" 2>/dev/null; then
      echo "  postgres $pid still alive, sending SIGKILL..."
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done
fi

echo "Done."
