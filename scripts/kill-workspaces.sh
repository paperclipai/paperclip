#!/usr/bin/env bash
#
# Kill all local Paperclip workspace runtime service processes.
#
# This targets managed workspace services such as preview/dev commands started
# from project or execution workspaces. Use scripts/kill-dev.sh for Paperclip
# server processes.
#
# Usage:
#   scripts/kill-workspaces.sh        # kill workspace runtime services
#   scripts/kill-workspaces.sh --dry  # preview what would be killed
#

set -euo pipefail
shopt -s nullglob

DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --dry|--dry-run|-n)
      DRY_RUN=true
      ;;
    --help|-h)
      sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      echo "Usage: scripts/kill-workspaces.sh [--dry]" >&2
      exit 2
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_PARENT="$(dirname "$REPO_ROOT")"
CURRENT_PID="$$"
CURRENT_PGID="$(ps -o pgid= -p "$CURRENT_PID" 2>/dev/null | tr -d '[:space:]' || true)"

expand_home() {
  local value="$1"
  if [[ "$value" == "~" ]]; then
    printf '%s\n' "$HOME"
  elif [[ "$value" == "~/"* ]]; then
    printf '%s\n' "$HOME/${value#"~/"}"
  else
    printf '%s\n' "$value"
  fi
}

runtime_dirs=()
declare -A seen_runtime_dirs=()

append_runtime_dir() {
  local dir="$1"
  [[ -d "$dir" ]] || return 0
  dir="$(cd "$dir" && pwd)"
  if [[ -z "${seen_runtime_dirs[$dir]:-}" ]]; then
    seen_runtime_dirs["$dir"]=1
    runtime_dirs+=("$dir")
  fi
}

paperclip_home="$(expand_home "${PAPERCLIP_HOME:-$HOME/.paperclip}")"
paperclip_instance_id="${PAPERCLIP_INSTANCE_ID:-default}"
append_runtime_dir "$paperclip_home/instances/$paperclip_instance_id/runtime-services"

if [[ "${PAPERCLIP_KILL_WORKSPACES_ONLY_CURRENT:-}" != "1" ]]; then
  for dir in \
    "$HOME"/.paperclip/instances/*/runtime-services \
    "$HOME"/.paperclip-worktrees/instances/*/runtime-services \
    "$REPO_ROOT"/.paperclip/instances/*/runtime-services \
    "$REPO_ROOT"/.paperclip/runtime-services/instances/*/runtime-services
  do
    append_runtime_dir "$dir"
  done

  for sibling_root in "$REPO_PARENT"/paperclip*; do
    [[ -d "$sibling_root" ]] || continue
    for dir in \
      "$sibling_root"/.paperclip/instances/*/runtime-services \
      "$sibling_root"/.paperclip/runtime-services/instances/*/runtime-services
    do
      append_runtime_dir "$dir"
    done
  done
fi

record_lines=()
if [[ ${#runtime_dirs[@]} -gt 0 ]]; then
  mapfile -t record_lines < <(node - "${runtime_dirs[@]}" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

function clean(value) {
  return String(value ?? "").replace(/[\t\r\n]+/g, " ");
}

for (const dir of process.argv.slice(2)) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    continue;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.resolve(dir, entry.name);
    let record;
    try {
      record = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      continue;
    }
    if (!record || record.profileKind !== "workspace-runtime") continue;
    if (!Number.isInteger(record.pid) || record.pid <= 0) continue;

    console.log([
      filePath,
      record.serviceKey,
      record.serviceName,
      record.pid,
      Number.isInteger(record.processGroupId) && record.processGroupId > 0 ? record.processGroupId : "",
      Number.isInteger(record.port) && record.port > 0 ? record.port : "",
      record.cwd,
      record.url,
      record.runtimeServiceId,
    ].map(clean).join("\x1f"));
  }
}
NODE
)
fi

is_pid_running() {
  local pid="$1"
  kill -0 "$pid" 2>/dev/null
}

is_group_running() {
  local pgid="$1"
  [[ -n "$pgid" && "$pgid" =~ ^[0-9]+$ && "$pgid" != "1" ]] || return 1
  [[ -z "$CURRENT_PGID" || "$pgid" != "$CURRENT_PGID" ]] || return 1
  kill -0 "-$pgid" 2>/dev/null
}

target_is_running() {
  local type="$1"
  local id="$2"
  if [[ "$type" == "group" ]]; then
    is_group_running "$id"
  else
    is_pid_running "$id"
  fi
}

signal_target() {
  local type="$1"
  local id="$2"
  local signal="$3"
  if [[ "$type" == "group" ]]; then
    kill "-$signal" "-$id" 2>/dev/null
  else
    kill "-$signal" "$id" 2>/dev/null
  fi
}

active_files=()
stale_files=()
display_lines=()
target_keys=()
target_types=()
target_ids=()
declare -A seen_target_keys=()

for line in "${record_lines[@]}"; do
  IFS=$'\x1f' read -r file service_key service_name pid pgid port cwd url runtime_service_id <<< "$line"

  target_type=""
  target_id=""
  if is_group_running "$pgid"; then
    target_type="group"
    target_id="$pgid"
  elif is_pid_running "$pid" && [[ "$pid" != "$CURRENT_PID" ]]; then
    target_type="pid"
    target_id="$pid"
  fi

  if [[ -z "$target_id" ]]; then
    stale_files+=("$file")
    continue
  fi

  active_files+=("$file")
  target_key="$target_type:$target_id"
  if [[ -z "${seen_target_keys[$target_key]:-}" ]]; then
    seen_target_keys["$target_key"]=1
    target_keys+=("$target_key")
    target_types+=("$target_type")
    target_ids+=("$target_id")
  fi

  short_file="${file/#$HOME\//}"
  short_cwd="${cwd/#$HOME\//}"
  target_label="$target_type:$target_id"
  display_lines+=("$(printf "  %-24s pid %-7s target %-14s port %-6s cwd %-45s registry %s" \
    "${service_name:-workspace-runtime}" "$pid" "$target_label" "${port:-"-"}" "${short_cwd:-"-"}" "$short_file")")
  if [[ -n "${url:-}" ]]; then
    display_lines+=("$(printf "  %-24s url %s" "" "$url")")
  fi
  if [[ -n "${runtime_service_id:-}" ]]; then
    display_lines+=("$(printf "  %-24s runtimeServiceId %s" "" "$runtime_service_id")")
  fi
  if [[ -n "${service_key:-}" ]]; then
    display_lines+=("$(printf "  %-24s serviceKey %s" "" "$service_key")")
  fi
done

if [[ ${#active_files[@]} -eq 0 && ${#stale_files[@]} -eq 0 ]]; then
  echo "No Paperclip workspace runtime services found."
  exit 0
fi

if [[ ${#active_files[@]} -gt 0 ]]; then
  echo "Found ${#active_files[@]} Paperclip workspace runtime service record(s):"
  echo ""
  printf '%s\n' "${display_lines[@]}"
  echo ""
fi

if [[ ${#stale_files[@]} -gt 0 ]]; then
  echo "Found ${#stale_files[@]} stale workspace runtime service registry record(s)."
  if [[ "$DRY_RUN" == true ]]; then
    stale_preview_limit=20
    stale_preview_count=0
    for file in "${stale_files[@]}"; do
      if (( stale_preview_count >= stale_preview_limit )); then
        remaining=$(( ${#stale_files[@]} - stale_preview_count ))
        echo "  ... ${remaining} more stale record(s)"
        break
      fi
      echo "  stale ${file/#$HOME\//}"
      ((stale_preview_count += 1))
    done
  fi
  echo ""
fi

if [[ "$DRY_RUN" == true ]]; then
  echo "Dry run — re-run without --dry to kill these services and remove stale registry records."
  exit 0
fi

if [[ ${#target_keys[@]} -gt 0 ]]; then
  echo "Sending SIGTERM to workspace runtime process targets..."
  for i in "${!target_keys[@]}"; do
    type="${target_types[$i]}"
    id="${target_ids[$i]}"
    if signal_target "$type" "$id" "TERM"; then
      echo "  signaled $type $id"
    else
      echo "  $type $id already gone"
    fi
  done

  sleep 2

  for i in "${!target_keys[@]}"; do
    type="${target_types[$i]}"
    id="${target_ids[$i]}"
    if target_is_running "$type" "$id"; then
      echo "  $type $id still alive, sending SIGKILL..."
      signal_target "$type" "$id" "KILL" || true
    fi
  done
fi

if [[ ${#active_files[@]} -gt 0 || ${#stale_files[@]} -gt 0 ]]; then
  echo "Removing workspace runtime service registry records..."
  for file in "${active_files[@]:-}" "${stale_files[@]:-}"; do
    [[ -n "$file" ]] || continue
    rm -f "$file"
    echo "  removed ${file/#$HOME\//}"
  done
fi

echo "Done."
