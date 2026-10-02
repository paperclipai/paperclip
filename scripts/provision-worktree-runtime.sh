#!/usr/bin/env bash
# Keep this script compatible with macOS's system Bash 3.2.
set -euo pipefail

base_cwd="${PAPERCLIP_WORKSPACE_BASE_CWD:?PAPERCLIP_WORKSPACE_BASE_CWD is required}"
worktree_cwd="${PAPERCLIP_WORKSPACE_CWD:?PAPERCLIP_WORKSPACE_CWD is required}"
paperclip_home="${PAPERCLIP_HOME:-$HOME/.paperclip}"
paperclip_instance_id="${PAPERCLIP_INSTANCE_ID:-default}"
paperclip_dir="$worktree_cwd/.paperclip"
worktree_config_path="$paperclip_dir/config.json"
seed_manifest_path="$paperclip_dir/seed-manifest.json"

if [[ ! -d "$base_cwd" ]]; then
  echo "Base workspace does not exist: $base_cwd" >&2
  exit 1
fi

if [[ ! -d "$worktree_cwd" ]]; then
  echo "Derived worktree does not exist: $worktree_cwd" >&2
  exit 1
fi

if [[ -e "$seed_manifest_path" ]]; then
  seed_manifest_state="$(SEED_MANIFEST_PATH="$seed_manifest_path" node <<'EOF'
const fs = require("node:fs");
try {
  const value = JSON.parse(fs.readFileSync(process.env.SEED_MANIFEST_PATH, "utf8"));
  const complete = value?.version === 2
    && value?.state === "verified"
    && value?.phase === "complete"
    && typeof value?.source?.instanceId === "string" && value.source.instanceId.length > 0
    && typeof value?.source?.configPath === "string" && value.source.configPath.length > 0
    && (value?.seedMode === "minimal" || value?.seedMode === "full")
    && typeof value?.snapshotAt === "string" && value.snapshotAt.length > 0
    && typeof value?.migrationRevision === "string" && value.migrationRevision.length > 0
    && typeof value?.targetInstanceId === "string" && value.targetInstanceId.length > 0
    && typeof value?.attemptId === "string" && value.attemptId.length > 0
    && typeof value?.startedAt === "string"
    && typeof value?.finishedAt === "string"
    && Array.isArray(value?.diagnostics)
    && value.diagnostics.some((entry) => entry?.phase === "complete" && entry?.status === "succeeded" && typeof entry?.at === "string");
  process.stdout.write(complete ? "verified" : "incomplete");
} catch {
  process.stdout.write("invalid");
}
EOF
)"
  if [[ "$seed_manifest_state" == "verified" ]]; then
    echo "Worktree database has a verified seed manifest; skipping runtime provisioning." >&2
    exit 0
  fi
fi

if [[ ! -f "$worktree_config_path" ]]; then
  initial_provision_script="$base_cwd/scripts/provision-worktree.sh"
  if [[ ! -f "$initial_provision_script" ]]; then
    echo "Worktree config does not exist and the built-in provision script is unavailable: $worktree_config_path" >&2
    exit 1
  fi
  echo "Worktree config is missing; running the built-in worktree provisioner before database seeding." >&2
  (
    cd "$worktree_cwd" &&
      bash "$initial_provision_script"
  )
fi

if [[ ! -f "$worktree_config_path" ]]; then
  echo "Worktree config still does not exist after built-in provisioning: $worktree_config_path" >&2
  exit 1
fi

# The CLI derives the source from PAPERCLIP_WORKSPACE_BASE_CWD, which the control
# plane injects from the registered project-workspace row. A base workspace that is
# a plain checkout carries no instance config of its own, so name the control plane's
# own registered instance config explicitly. The seed manifest stays diagnostic
# evidence only and must never choose the clone source.
if [[ -L "$base_cwd/.paperclip" && ! -d "$base_cwd/.paperclip" ]]; then
  echo "Registered base project workspace .paperclip is a broken symlink: $base_cwd/.paperclip" >&2
  exit 1
fi
source_config_args=()
if [[ ! -e "$base_cwd/.paperclip/config.json" && ! -L "$base_cwd/.paperclip/config.json" ]]; then
  source_config_path="${PAPERCLIP_CONFIG:-$paperclip_home/instances/$paperclip_instance_id/config.json}"
  # A human may invoke this after sourcing `worktree env`, which points
  # PAPERCLIP_CONFIG at the target. Naming the target as its own source is never
  # right, so leave the source to the CLI in that case.
  if [[ "$source_config_path" != "$worktree_config_path" ]]; then
    source_config_args=(--from-config "$source_config_path")
  fi
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
  # pnpm 9.15.4 calls the deprecated url.parse() in toNerfDart on every
  # install. Node 24 reports that call as DEP0169. Remove this flag when the
  # pinned pnpm no longer calls url.parse() in that path.
  local repair_node_options="${NODE_OPTIONS:-} --disable-warning=DEP0169"
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
      env -u NODE_ENV CI=true NODE_OPTIONS="$repair_node_options" "${repair_cmd[@]}" >&2 || exit 1
      base_cli_healthy
    )
  else
    (cd "$base_cwd" && env -u NODE_ENV CI=true NODE_OPTIONS="$repair_node_options" "${repair_cmd[@]}" >&2 && base_cli_healthy)
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
        node "$base_cli_runner_path" "$base_cli_entry_path" worktree ensure-seeded --config "$worktree_config_path" ${source_config_args[@]+"${source_config_args[@]}"}
    )
    return
  fi

  if command -v pnpm >/dev/null 2>&1 && pnpm paperclipai --help >/dev/null 2>&1; then
    (
      cd "$worktree_cwd" &&
        pnpm paperclipai worktree ensure-seeded --config "$worktree_config_path" ${source_config_args[@]+"${source_config_args[@]}"}
    )
    return
  fi

  if command -v paperclipai >/dev/null 2>&1; then
    (
      cd "$worktree_cwd" &&
        paperclipai worktree ensure-seeded --config "$worktree_config_path" ${source_config_args[@]+"${source_config_args[@]}"}
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
