#!/usr/bin/env bash
set -euo pipefail

base_cwd="${PAPERCLIP_WORKSPACE_BASE_CWD:?PAPERCLIP_WORKSPACE_BASE_CWD is required}"
worktree_cwd="${PAPERCLIP_WORKSPACE_CWD:?PAPERCLIP_WORKSPACE_CWD is required}"
paperclip_home="${PAPERCLIP_HOME:-$HOME/.paperclip}"
paperclip_instance_id="${PAPERCLIP_INSTANCE_ID:-default}"
paperclip_dir="$worktree_cwd/.paperclip"
worktree_config_path="$paperclip_dir/config.json"
seed_pending_marker_path="$paperclip_dir/seed-pending"
seed_complete_marker_path="$paperclip_dir/seed-complete"

if [[ ! -d "$base_cwd" ]]; then
  echo "Base workspace does not exist: $base_cwd" >&2
  exit 1
fi

if [[ ! -d "$worktree_cwd" ]]; then
  echo "Derived worktree does not exist: $worktree_cwd" >&2
  exit 1
fi

if [[ -e "$seed_complete_marker_path" || ! -e "$seed_pending_marker_path" ]]; then
  echo "Worktree database is already seeded; skipping runtime provisioning." >&2
  exit 0
fi

if [[ ! -f "$worktree_config_path" ]]; then
  echo "Worktree config does not exist: $worktree_config_path" >&2
  exit 1
fi

source_config_path="${PAPERCLIP_CONFIG:-}"
if [[ -z "$source_config_path" && ( -e "$base_cwd/.paperclip/config.json" || -L "$base_cwd/.paperclip/config.json" ) ]]; then
  source_config_path="$base_cwd/.paperclip/config.json"
fi
if [[ -z "$source_config_path" ]]; then
  source_config_path="$paperclip_home/instances/$paperclip_instance_id/config.json"
fi
source_config_args=(--from-config "$source_config_path")
if [[ "$source_config_path" == "$worktree_config_path" ]]; then
  # A human may invoke this after sourcing `worktree env`, which points
  # PAPERCLIP_CONFIG at the target. In that case the CLI reads the original
  # source config from the seed-pending marker instead.
  source_config_args=()
fi

base_cli_runner_path="$base_cwd/cli/node_modules/tsx/dist/cli.mjs"
base_cli_entry_path="$base_cwd/cli/src/index.ts"

base_cli_files_present() {
  [[ -f "$base_cli_runner_path" && -f "$base_cli_entry_path" ]]
}

base_cli_healthy() {
  base_cli_files_present || return 1
  (cd "$base_cwd" && node "$base_cli_runner_path" "$base_cli_entry_path" --help >/dev/null 2>&1)
}

repair_base_workspace_install() {
  command -v pnpm >/dev/null 2>&1 || return 1
  [[ -f "$base_cwd/package.json" && -f "$base_cwd/pnpm-lock.yaml" ]] || return 1
  echo "Base workspace CLI at $base_cli_entry_path failed its health check (typically dangling pnpm symlinks after a partial install); repairing with pnpm install in $base_cwd." >&2
  local repair_cmd=(pnpm install --prod=false --force --frozen-lockfile --config.confirmModulesPurge=false)
  local repair_lock_dir=""
  if command -v git >/dev/null 2>&1; then
    repair_lock_dir="$(git -C "$base_cwd" rev-parse --absolute-git-dir 2>/dev/null || true)"
  fi
  if [[ ! -d "$repair_lock_dir" && -d "$base_cwd/.git" ]]; then
    repair_lock_dir="$base_cwd/.git"
  fi
  if command -v flock >/dev/null 2>&1 && [[ -d "$repair_lock_dir" ]]; then
    (
      cd "$base_cwd" || exit 1
      exec 9>"$repair_lock_dir/paperclip-provision-repair.lock"
      flock 9
      if base_cli_healthy; then
        echo "Base workspace CLI became healthy while waiting for the repair lock; skipping reinstall." >&2
        exit 0
      fi
      env -u NODE_ENV CI=true "${repair_cmd[@]}" >&2 || exit 1
      base_cli_healthy
    )
  else
    (cd "$base_cwd" && env -u NODE_ENV CI=true "${repair_cmd[@]}" >&2 && base_cli_healthy)
  fi
}

ensure_base_cli_healthy() {
  base_cli_files_present || return 1
  base_cli_healthy && return 0
  repair_base_workspace_install
}

run_ensure_seeded() {
  if ensure_base_cli_healthy; then
    (
      cd "$worktree_cwd" &&
        node "$base_cli_runner_path" "$base_cli_entry_path" worktree ensure-seeded --config "$worktree_config_path" "${source_config_args[@]}"
    )
    return
  fi

  if command -v pnpm >/dev/null 2>&1 && pnpm paperclipai --help >/dev/null 2>&1; then
    (
      cd "$worktree_cwd" &&
        pnpm paperclipai worktree ensure-seeded --config "$worktree_config_path" "${source_config_args[@]}"
    )
    return
  fi

  if command -v paperclipai >/dev/null 2>&1; then
    (
      cd "$worktree_cwd" &&
        paperclipai worktree ensure-seeded --config "$worktree_config_path" "${source_config_args[@]}"
    )
    return
  fi

  return 127
}

if run_ensure_seeded; then
  exit 0
else
  exit_code=$?
  if [[ "$exit_code" -eq 127 ]]; then
    echo "No usable paperclipai CLI found; cannot seed the worktree database." >&2
  fi
  exit "$exit_code"
fi
