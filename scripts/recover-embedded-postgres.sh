#!/usr/bin/env bash
#
# Best-effort recovery for embedded PostgreSQL startup failures caused by
# stale local processes and exhausted SysV shared-memory slots.
#
# Usage:
#   scripts/recover-embedded-postgres.sh
#   scripts/recover-embedded-postgres.sh --start
#   scripts/recover-embedded-postgres.sh --aggressive-ipc --start
#   scripts/recover-embedded-postgres.sh --dry
#

set -euo pipefail
shopt -s nullglob

DRY_RUN=false
START_DEV=false
AGGRESSIVE_IPC=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry|-n|--dry-run)
      DRY_RUN=true
      ;;
    --start)
      START_DEV=true
      ;;
    --aggressive-ipc)
      AGGRESSIVE_IPC=true
      ;;
    --help|-h)
      cat <<'EOF'
Usage: scripts/recover-embedded-postgres.sh [options]

Options:
  --dry, -n         Show what would run without modifying the system
  --start           Run "pnpm dev" after recovery
  --aggressive-ipc  Remove all current-user SysV shared-memory segments if
                    orphan detection is unavailable
  --help, -h        Show help
EOF
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
  shift
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_PARENT="$(dirname "$REPO_ROOT")"

run_cmd() {
  if [[ "$DRY_RUN" == true ]]; then
    printf '[dry-run] '
    printf '%q ' "$@"
    printf '\n'
    return 0
  fi
  "$@"
}

is_pid_running() {
  local pid="$1"
  if [[ "$pid" =~ ^[0-9]+$ ]] && (( pid > 0 )); then
    kill -0 "$pid" 2>/dev/null
    return
  fi
  return 1
}

read_pidfile_pid() {
  local pidfile="$1"
  local pid=""
  pid="$(head -n 1 "$pidfile" 2>/dev/null | tr -d '[:space:]' || true)"
  if [[ "$pid" =~ ^[0-9]+$ ]] && (( pid > 0 )); then
    printf '%s\n' "$pid"
    return 0
  fi
  return 1
}

echo "==> Stopping managed Paperclip dev processes"
if [[ -x "$REPO_ROOT/scripts/kill-dev.sh" ]]; then
  if [[ "$DRY_RUN" == true ]]; then
    run_cmd "$REPO_ROOT/scripts/kill-dev.sh" --dry
  else
    run_cmd "$REPO_ROOT/scripts/kill-dev.sh"
  fi
else
  echo "kill-dev helper not found at scripts/kill-dev.sh; skipping managed process stop"
fi

echo
echo "==> Removing stale postmaster.pid files"
candidate_pidfiles=(
  "$HOME"/.paperclip/instances/*/db/postmaster.pid
  "$HOME"/.paperclip-worktrees/instances/*/db/postmaster.pid
  "$REPO_ROOT"/.paperclip/instances/*/db/postmaster.pid
  "$REPO_ROOT"/.paperclip/runtime-services/instances/*/db/postmaster.pid
  "$REPO_ROOT"/.paperclip-worktrees/instances/*/db/postmaster.pid
)

for sibling_root in "$REPO_PARENT"/paperclip*; do
  [[ -d "$sibling_root" ]] || continue
  candidate_pidfiles+=(
    "$sibling_root"/.paperclip/instances/*/db/postmaster.pid
    "$sibling_root"/.paperclip/runtime-services/instances/*/db/postmaster.pid
    "$sibling_root"/.paperclip-worktrees/instances/*/db/postmaster.pid
  )
done

deleted_pidfiles=0
for pidfile in "${candidate_pidfiles[@]:-}"; do
  [[ -f "$pidfile" ]] || continue
  pid="$(read_pidfile_pid "$pidfile" || true)"
  if [[ -n "$pid" ]] && is_pid_running "$pid"; then
    echo "Skipping live pidfile: $pidfile (pid $pid still running)"
    continue
  fi
  run_cmd rm -f "$pidfile"
  echo "Removed stale pidfile: $pidfile"
  ((deleted_pidfiles += 1))
done

if (( deleted_pidfiles == 0 )); then
  echo "No stale pidfiles found."
fi

echo
echo "==> Releasing orphan SysV shared-memory segments"
if ! command -v ipcs >/dev/null 2>&1 || ! command -v ipcrm >/dev/null 2>&1; then
  echo "ipcs/ipcrm not available; skipping SysV IPC cleanup."
else
  orphan_ids=()
  parsed_rows=0

  while read -r shmid owner cpid lpid; do
    [[ -n "${shmid:-}" ]] || continue
    ((parsed_rows += 1))
    [[ "$owner" == "$USER" ]] || continue
    creator_alive=false
    lastop_alive=false
    if [[ "${cpid:-0}" =~ ^[0-9]+$ ]] && (( cpid > 0 )) && is_pid_running "$cpid"; then
      creator_alive=true
    fi
    if [[ "${lpid:-0}" =~ ^[0-9]+$ ]] && (( lpid > 0 )) && is_pid_running "$lpid"; then
      lastop_alive=true
    fi
    if [[ "$creator_alive" == false && "$lastop_alive" == false ]]; then
      orphan_ids+=("$shmid")
    fi
  done < <(
    ipcs -m -p 2>/dev/null | awk '
      ($1 ~ /^[0-9]+$/ && NF >= 4) { print $1, $2, $3, $4 }
    '
  )

  if (( parsed_rows == 0 )) && [[ "$AGGRESSIVE_IPC" == true ]]; then
    echo "Could not parse creator/last-op PIDs; aggressive mode enabled."
    while read -r shmid owner; do
      [[ -n "${shmid:-}" ]] || continue
      [[ "$owner" == "$USER" ]] || continue
      orphan_ids+=("$shmid")
    done < <(
      ipcs -m 2>/dev/null | awk '
        ($1 == "m" && NF >= 5) { print $2, $5 }
        ($1 ~ /^[0-9]+$/ && NF >= 3) { print $2, $3 }
      '
    )
  fi

  if (( parsed_rows == 0 )) && [[ "$AGGRESSIVE_IPC" == false ]]; then
    echo "Could not parse orphan IPC rows from \"ipcs -m -p\"."
    echo "Run again with --aggressive-ipc to remove all current-user SysV shared-memory segments."
  fi

  if (( ${#orphan_ids[@]:-0} == 0 )); then
    echo "No removable shared-memory segments found."
  else
    # Deduplicate and remove (portable for macOS bash 3.2).
    unique_orphans=()
    while IFS= read -r shmid; do
      [[ -n "${shmid:-}" ]] || continue
      unique_orphans+=("$shmid")
    done < <(printf '%s\n' "${orphan_ids[@]:-}" | awk '!seen[$0]++')

    for shmid in "${unique_orphans[@]:-}"; do
      run_cmd ipcrm -m "$shmid"
      echo "Released shared-memory segment: $shmid"
    done
  fi
fi

if [[ "$START_DEV" == true ]]; then
  echo
  echo "==> Starting Paperclip dev server"
  cd "$REPO_ROOT"
  run_cmd pnpm dev
fi

echo
echo "Recovery complete."
