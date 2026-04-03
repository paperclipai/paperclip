#!/bin/bash
# Paperclip self-hosted upgrade script
#
# Safely upgrades a running Paperclip instance from an upstream git remote.
# Builds in an isolated git worktree so the running server is never touched
# during compilation. Agents are only quiesced for the brief restart window.
#
# Design decisions:
#
#   1. ISOLATED BUILD: pnpm install + build happen in a detached git worktree,
#      not in the live repo. This prevents corrupting node_modules or dist/
#      files while the server is running. Only after build succeeds do we
#      touch the live installation.
#
#   2. LATE QUIESCE: Agents keep running normally during the entire build phase
#      (which can take several minutes). Quiescing only happens right before
#      the restart, minimizing agent downtime to seconds.
#
#   3. FULL QUIESCE: Both timer heartbeats AND on-demand wakes (comment
#      mentions, assignment changes) are disabled. This prevents new agent
#      runs from starting while we wait for in-flight runs to drain.
#      Each agent's prior state is saved and restored individually afterward.
#
#   4. NON-BLOCKING DRAIN: The script checks live-runs once per invocation
#      and exits if agents are still running (exit 3). Cron retries every
#      few minutes. This avoids long-running blocked processes.
#
#   5. PERSISTENT STATE MACHINE: All state is written to disk so the script
#      can resume after crashes. Phase transitions update a file whose mtime
#      is used for hung-process detection.
#
#   6. CRON-FRIENDLY: Two cron entries work together:
#        0 5 * * *  ./upgrade.sh --start   # initiate upgrade once daily
#        */5 * * * * ./upgrade.sh           # resume/monitor (no-op if idle)
#
# Phase order:
#   idle → building (in worktree) → built → quiescing → draining → swapping → idle
#
# Exit codes:
#   0 = upgraded successfully
#   1 = error
#   2 = already up to date
#   3 = agents still busy, will retry on next cron invocation
#   4 = drain timed out, gave up (agents restored, needs investigation)
#
# Environment variables:
#   PAPERCLIP_REPO_DIR       Paperclip repo directory (default: script's grandparent)
#   PAPERCLIP_API_URL        API base URL (default: http://127.0.0.1:3100)
#   PAPERCLIP_COMPANY_ID     Company ID for agent management (auto-detected if omitted)
#   PAPERCLIP_UPSTREAM       Git remote name to pull from (default: upstream)
#   PAPERCLIP_UPSTREAM_BRANCH  Branch to track (default: master)
#   PAPERCLIP_ORIGIN         Git remote to push to after upgrade (default: origin, empty to skip)
#   PAPERCLIP_SERVICE        Systemd user service name (default: paperclip)
#   PAPERCLIP_API_TOKEN       Bearer token for API calls (required for authenticated deployments)
#   PAPERCLIP_HOME           Paperclip data directory (default: ~/.paperclip)
#   DRAIN_MAX_AGE_SEC        Max seconds to wait for agents to drain (default: 1800)
#   PHASE_TIMEOUT_SEC        Max seconds a phase can run before hung detection (default: 1800)
#
# Usage:
#   ./upgrade.sh --start       # start fresh upgrade
#   ./upgrade.sh               # resume/monitor only
#   ./upgrade.sh --restore     # force-restore agents from failed run
#   ./upgrade.sh --status      # show current state

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration (all overridable via environment)
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${PAPERCLIP_REPO_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
API_URL="${PAPERCLIP_API_URL:-http://127.0.0.1:3100}"
UPSTREAM="${PAPERCLIP_UPSTREAM:-upstream}"
UPSTREAM_BRANCH="${PAPERCLIP_UPSTREAM_BRANCH:-master}"
ORIGIN="${PAPERCLIP_ORIGIN:-origin}"
SERVICE_NAME="${PAPERCLIP_SERVICE:-paperclip}"
PAPERCLIP_HOME="${PAPERCLIP_HOME:-$HOME/.paperclip}"
DRAIN_MAX_AGE_SEC=${DRAIN_MAX_AGE_SEC:-1800}
PHASE_TIMEOUT_SEC=${PHASE_TIMEOUT_SEC:-1800}

BUILD_DIR="$PAPERCLIP_HOME/upgrade-build"
LOG_FILE="$PAPERCLIP_HOME/upgrade.log"
STATE_DIR="$PAPERCLIP_HOME/upgrade-state"

# Persistent state files
HEARTBEAT_STATE_FILE="$STATE_DIR/heartbeat-state.json"
UPGRADE_PHASE_FILE="$STATE_DIR/phase"
ROLLBACK_REF_FILE="$STATE_DIR/rollback-ref"
DRAIN_START_FILE="$STATE_DIR/drain-started-at"
LOCK_FILE="$STATE_DIR/upgrade.lock"
PULSE_FILE="$STATE_DIR/pulse"

mkdir -p "$STATE_DIR"

# ---------------------------------------------------------------------------
# Logging and state helpers
# ---------------------------------------------------------------------------

log() { echo "[$(date -Is)] $*" | tee -a "$LOG_FILE"; }

# Build curl auth headers if a token is configured
AUTH_ARGS=()
if [ -n "${PAPERCLIP_API_TOKEN:-}" ]; then
  AUTH_ARGS=(-H "Authorization: Bearer $PAPERCLIP_API_TOKEN")
fi

# Wrapper for authenticated curl calls
api_curl() { curl -sf "${AUTH_ARGS[@]}" "$@"; }

get_phase() { cat "$UPGRADE_PHASE_FILE" 2>/dev/null || echo "idle"; }
set_phase() {
  echo "$1" > "$UPGRADE_PHASE_FILE"
  pulse "phase=$1"
  log "Phase: $1"
}

pulse() {
  echo "{\"ts\":\"$(date -Is)\",\"pid\":$$,\"status\":\"$1\"}" > "$PULSE_FILE"
}

phase_age_sec() {
  if [ ! -f "$UPGRADE_PHASE_FILE" ]; then echo "0"; return; fi
  local mtime
  mtime=$(stat -c %Y "$UPGRADE_PHASE_FILE" 2>/dev/null || echo "0")
  echo $(( $(date +%s) - mtime ))
}

# ---------------------------------------------------------------------------
# Auto-detect company ID if not provided
# ---------------------------------------------------------------------------

resolve_company_id() {
  if [ -n "${PAPERCLIP_COMPANY_ID:-}" ]; then
    echo "$PAPERCLIP_COMPANY_ID"
    return
  fi
  local detected
  detected=$(api_curl "$API_URL/api/companies" 2>/dev/null | jq -r '.[0].id // empty' 2>/dev/null || echo "")
  if [ -z "$detected" ]; then
    log "ERROR: Could not auto-detect company ID. Set PAPERCLIP_COMPANY_ID or ensure the server is running."
    exit 1
  fi
  echo "$detected"
}

# ---------------------------------------------------------------------------
# Lock: only one instance runs at a time
# Uses phase file mtime for hung detection — no background process needed.
# ---------------------------------------------------------------------------

# Read the start time (field 22) from /proc/<pid>/stat to detect PID reuse.
pid_start_time() {
  local pid="$1"
  awk '{print $22}' "/proc/$pid/stat" 2>/dev/null || echo ""
}

acquire_lock() {
  if [ -f "$LOCK_FILE" ]; then
    local lock_pid lock_starttime
    lock_pid=$(head -1 "$LOCK_FILE" 2>/dev/null || echo "")
    lock_starttime=$(sed -n '2p' "$LOCK_FILE" 2>/dev/null || echo "")
    if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null; then
      # Verify PID hasn't been reused by comparing process start time
      local current_starttime
      current_starttime=$(pid_start_time "$lock_pid")
      if [ -n "$lock_starttime" ] && [ -n "$current_starttime" ] && [ "$lock_starttime" != "$current_starttime" ]; then
        log "Stale lock: PID $lock_pid was reused by a different process"
      else
        local age
        age=$(phase_age_sec)
        if [ "$age" -gt "$PHASE_TIMEOUT_SEC" ]; then
          local current_phase
          current_phase=$(get_phase)
          log "WARN: Phase '$current_phase' unchanged for ${age}s (PID $lock_pid) — assuming hung, killing"
          kill "$lock_pid" 2>/dev/null || true
          sleep 2
          # Remove old lock before writing new one so the dying process's
          # EXIT trap deletes an already-gone file instead of our new lock.
          rm -f "$LOCK_FILE"
        else
          log "Another upgrade instance running (PID $lock_pid, phase age ${age}s)"
          exit 0
        fi
      fi
    fi
    log "Stale lock (PID ${lock_pid:-unknown} dead), removing"
    rm -f "$LOCK_FILE"
  fi
  # Write PID and start time (two lines) for reuse detection
  printf '%s\n%s\n' "$$" "$(pid_start_time $$)" > "$LOCK_FILE"
  trap 'rm -f "$LOCK_FILE"' EXIT
}

# ---------------------------------------------------------------------------
# Agent state management
#
# Saves per-agent heartbeat/wakeOnDemand state before quiescing, then
# restores each agent to its exact prior state afterward. Agents that
# had heartbeats disabled before the upgrade stay disabled.
# ---------------------------------------------------------------------------

save_heartbeat_state() {
  log "Saving current heartbeat state (full heartbeat objects)..."
  local state
  state=$(api_curl "$API_URL/api/companies/$COMPANY_ID/agents" 2>/dev/null \
    | jq '[.[] | {id: .id, name: .name, heartbeat: .runtimeConfig.heartbeat}]' \
    2>/dev/null) || state="[]"
  if [ -z "$state" ] || [ "$state" = "null" ]; then
    log "WARN: Could not fetch agent state — defaulting to empty list (no agents will be quiesced)"
    state="[]"
  fi
  echo "$state" > "$HEARTBEAT_STATE_FILE"
}

quiesce_agents() {
  log "Quiescing all agents (disabling heartbeats and on-demand wakes only)..."
  for agent_id in $(jq -r '.[] | select(.heartbeat.enabled == true or .heartbeat.wakeOnDemand == true) | .id' "$HEARTBEAT_STATE_FILE"); do
    agent_name=$(jq -r --arg id "$agent_id" '.[] | select(.id == $id) | .name' "$HEARTBEAT_STATE_FILE")
    # Merge just enabled+wakeOnDemand into the existing heartbeat object so
    # other fields (intervalSec, cooldownSec, maxConcurrentRuns) are preserved.
    saved_hb=$(jq -c --arg id "$agent_id" '.[] | select(.id == $id) | .heartbeat' "$HEARTBEAT_STATE_FILE")
    quiesced_hb=$(echo "$saved_hb" | jq -c '. + {enabled: false, wakeOnDemand: false}')
    api_curl -X PATCH "$API_URL/api/agents/$agent_id" \
      -H "Content-Type: application/json" \
      -d "{\"runtimeConfig\": {\"heartbeat\": $quiesced_hb}}" > /dev/null 2>&1 \
      && log "  Quiesced: $agent_name" \
      || log "  WARN: Failed to quiesce: $agent_name"
  done
}

restore_heartbeats() {
  if [ ! -f "$HEARTBEAT_STATE_FILE" ]; then
    log "WARN: No heartbeat state file found, cannot restore"
    return
  fi
  log "Restoring full agent heartbeat configs..."
  for agent_id in $(jq -r '.[] | select(.heartbeat.enabled == true or .heartbeat.wakeOnDemand == true) | .id' "$HEARTBEAT_STATE_FILE"); do
    agent_name=$(jq -r --arg id "$agent_id" '.[] | select(.id == $id) | .name' "$HEARTBEAT_STATE_FILE")
    saved_hb=$(jq -c --arg id "$agent_id" '.[] | select(.id == $id) | .heartbeat' "$HEARTBEAT_STATE_FILE")
    api_curl -X PATCH "$API_URL/api/agents/$agent_id" \
      -H "Content-Type: application/json" \
      -d "{\"runtimeConfig\": {\"heartbeat\": $saved_hb}}" > /dev/null 2>&1 \
      && log "  Restored: $agent_name" \
      || log "  WARN: Failed to restore: $agent_name"
  done
}

full_cleanup() {
  rm -rf "$STATE_DIR"
  mkdir -p "$STATE_DIR"
  if [ -d "$BUILD_DIR" ]; then
    git -C "$REPO_DIR" worktree remove --force "$BUILD_DIR" 2>/dev/null || rm -rf "$BUILD_DIR"
  fi
}

# ---------------------------------------------------------------------------
# Drain check (single poll, no blocking)
#
# Returns 0 if drained, 1 if still busy, 2 if timed out.
# Designed for cron-driven retry: check once, exit, let cron call again.
# ---------------------------------------------------------------------------

check_drained() {
  if [ ! -f "$DRAIN_START_FILE" ]; then
    date +%s > "$DRAIN_START_FILE"
  fi
  local drain_started now elapsed
  drain_started=$(cat "$DRAIN_START_FILE")
  now=$(date +%s)
  elapsed=$(( now - drain_started ))

  local live_count
  live_count=$(api_curl "$API_URL/api/companies/$COMPANY_ID/live-runs" 2>/dev/null \
    | jq 'length' 2>/dev/null || echo "unknown")

  if [ "$live_count" = "0" ]; then
    log "All agent runs drained (waited ${elapsed}s)"
    rm -f "$DRAIN_START_FILE"
    return 0
  elif [ "$live_count" = "unknown" ]; then
    log "WARN: Could not check live runs, proceeding"
    rm -f "$DRAIN_START_FILE"
    return 0
  fi
  if [ "$elapsed" -ge "$DRAIN_MAX_AGE_SEC" ]; then
    log "ERROR: $live_count run(s) still active after ${elapsed}s — giving up"
    rm -f "$DRAIN_START_FILE"
    return 2
  fi
  pulse "draining: ${live_count} run(s), ${elapsed}s/${DRAIN_MAX_AGE_SEC}s"
  log "Still draining: $live_count active run(s), ${elapsed}s elapsed. Will retry."
  return 1
}

# ---------------------------------------------------------------------------
# Rollback: restore previous commit in the main repo
# ---------------------------------------------------------------------------

rollback() {
  local ref
  ref=$(cat "$ROLLBACK_REF_FILE" 2>/dev/null || echo "")
  if [ -z "$ref" ]; then
    log "ERROR: No rollback ref saved, cannot rollback"
    return 1
  fi
  log "Rolling back repo to $ref..."
  cd "$REPO_DIR"
  git reset --hard "$ref"
  pnpm install --frozen-lockfile 2>>"$LOG_FILE" || pnpm install 2>>"$LOG_FILE" || true
  pnpm build 2>>"$LOG_FILE" || true
  systemctl --user restart "$SERVICE_NAME" 2>>"$LOG_FILE" || true
  sleep 5
  restore_heartbeats
  full_cleanup
  log "Rollback complete"
}

# ---------------------------------------------------------------------------
# Handle special flags
# ---------------------------------------------------------------------------

case "${1:-}" in
  --restore)
    log "Manual restore requested"
    COMPANY_ID=$(resolve_company_id)
    if [ -f "$HEARTBEAT_STATE_FILE" ]; then
      restore_heartbeats
      full_cleanup
      log "Restore complete"
    else
      log "No saved state to restore"
      full_cleanup
    fi
    exit 0
    ;;
  --status)
    echo "Phase: $(get_phase)"
    echo "Phase age: $(phase_age_sec)s"
    [ -f "$PULSE_FILE" ] && echo "Pulse: $(cat "$PULSE_FILE")"
    [ -f "$DRAIN_START_FILE" ] && echo "Drain started: $(date -d @"$(cat "$DRAIN_START_FILE")" -Is 2>/dev/null || cat "$DRAIN_START_FILE")"
    [ -f "$LOCK_FILE" ] && echo "Lock PID: $(cat "$LOCK_FILE")"
    [ -d "$BUILD_DIR" ] && echo "Build dir: exists ($(git -C "$BUILD_DIR" rev-parse --short HEAD 2>/dev/null || echo 'unknown'))"
    exit 0
    ;;
esac

MODE="resume"
[ "${1:-}" = "--start" ] && MODE="start"

acquire_lock

COMPANY_ID=$(resolve_company_id)
phase=$(get_phase)

# ---------------------------------------------------------------------------
# Resume in-progress upgrades
# ---------------------------------------------------------------------------

if [ "$phase" != "idle" ]; then
  log "In-progress upgrade (phase: $phase)"

  case "$phase" in
    building)
      log "Prior build was interrupted — cleaning up worktree"
      full_cleanup
      exit 1
      ;;
    built)
      # Ready to quiesce — fall through
      ;;
    quiescing|draining)
      drain_result=0
      check_drained || drain_result=$?
      if [ "$drain_result" = "0" ]; then
        set_phase "swapping"
        phase="swapping"
      elif [ "$drain_result" = "1" ]; then
        set_phase "draining"
        exit 3
      else
        restore_heartbeats
        full_cleanup
        exit 4
      fi
      ;;
    swapping)
      log "Prior swap was interrupted — attempting rollback"
      rollback
      exit 1
      ;;
    *)
      log "Unknown phase '$phase' — cleaning up"
      restore_heartbeats
      full_cleanup
      exit 1
      ;;
  esac

elif [ "$MODE" = "resume" ]; then
  pulse "idle: no upgrade in progress"
  exit 0
fi

# ---------------------------------------------------------------------------
# Phase: build in isolated worktree (server untouched, agents running)
# ---------------------------------------------------------------------------

if [ "$phase" = "idle" ]; then
  [ "$MODE" != "start" ] && exit 0

  cd "$REPO_DIR"

  log "Fetching $UPSTREAM..."
  git fetch "$UPSTREAM"

  LOCAL=$(git rev-parse HEAD)
  REMOTE=$(git rev-parse "$UPSTREAM/$UPSTREAM_BRANCH")
  if [ "$LOCAL" = "$REMOTE" ]; then
    log "Already up to date at $(git rev-parse --short HEAD)"
    exit 2
  fi

  log "Update available: $(git rev-parse --short HEAD) -> $(git rev-parse --short "$UPSTREAM/$UPSTREAM_BRANCH")"
  echo "$LOCAL" > "$ROLLBACK_REF_FILE"

  if [ -d "$BUILD_DIR" ]; then
    git worktree remove --force "$BUILD_DIR" 2>/dev/null || rm -rf "$BUILD_DIR"
  fi
  log "Creating build worktree at $UPSTREAM/$UPSTREAM_BRANCH..."
  git worktree add --detach "$BUILD_DIR" "$UPSTREAM/$UPSTREAM_BRANCH" 2>>"$LOG_FILE"

  set_phase "building"

  cd "$BUILD_DIR"

  log "Installing dependencies in worktree..."
  if ! pnpm install --frozen-lockfile 2>>"$LOG_FILE"; then
    log "WARN: frozen-lockfile failed, trying regular install"
    if ! pnpm install 2>>"$LOG_FILE"; then
      log "ERROR: pnpm install failed in worktree"
      full_cleanup
      exit 1
    fi
  fi

  log "Building in worktree..."
  if ! pnpm build 2>>"$LOG_FILE"; then
    log "ERROR: Build failed in worktree"
    full_cleanup
    exit 1
  fi

  log "Build complete in worktree — server was not touched"
  set_phase "built"
  phase="built"
fi

# ---------------------------------------------------------------------------
# Phase: quiesce + drain (brief disruption starts here)
# ---------------------------------------------------------------------------

if [ "$phase" = "built" ]; then
  save_heartbeat_state
  quiesce_agents
  set_phase "quiescing"

  drain_result=0
  check_drained || drain_result=$?
  if [ "$drain_result" = "0" ]; then
    set_phase "swapping"
    phase="swapping"
  elif [ "$drain_result" = "1" ]; then
    set_phase "draining"
    log "Agents still running — cron will resume when drained"
    exit 3
  else
    restore_heartbeats
    full_cleanup
    exit 4
  fi
fi

# ---------------------------------------------------------------------------
# Phase: swap (agents drained, fast operation)
#
# Strategy:
# 1. Stop the server
# 2. Stash any local changes (e.g. local skill patches)
# 3. Fast-forward the live repo to upstream
# 4. Re-apply stashed changes
# 5. rsync built node_modules and dist artifacts from the worktree
# 6. Start the server and health-check
# ---------------------------------------------------------------------------

if [ "$phase" = "swapping" ]; then
  cd "$REPO_DIR"

  log "Stopping Paperclip..."
  systemctl --user stop "$SERVICE_NAME" 2>>"$LOG_FILE" || true
  sleep 2

  local_changes=$(git status --porcelain 2>/dev/null | head -1)
  if [ -n "$local_changes" ]; then
    log "Stashing local changes in live repo..."
    git stash push -m "paperclip-upgrade-$(date +%s)" 2>>"$LOG_FILE"
    echo "stashed" > "$STATE_DIR/stash-flag"
  fi

  log "Advancing live repo to $UPSTREAM/$UPSTREAM_BRANCH..."
  if ! git merge "$UPSTREAM/$UPSTREAM_BRANCH" --ff-only 2>>"$LOG_FILE"; then
    log "ERROR: Fast-forward failed on live repo"
    systemctl --user start "$SERVICE_NAME" 2>>"$LOG_FILE" || true
    [ -f "$STATE_DIR/stash-flag" ] && { git stash pop 2>>"$LOG_FILE" || true; rm -f "$STATE_DIR/stash-flag"; }
    restore_heartbeats
    full_cleanup
    exit 1
  fi

  if [ -f "$STATE_DIR/stash-flag" ]; then
    log "Re-applying local changes..."
    git stash pop 2>>"$LOG_FILE" || log "WARN: Stash pop had conflicts — check manually"
    rm -f "$STATE_DIR/stash-flag"
  fi

  log "Syncing build artifacts from worktree..."
  rsync -a --delete "$BUILD_DIR/node_modules/" "$REPO_DIR/node_modules/" 2>>"$LOG_FILE"
  while IFS= read -r dist_dir; do
    relative="${dist_dir#$BUILD_DIR/}"
    target="$REPO_DIR/$relative"
    mkdir -p "$target"
    rsync -a --delete "$dist_dir/" "$target/" 2>>"$LOG_FILE"
  done < <(find "$BUILD_DIR" -name "dist" -not -path "*/node_modules/*" -type d 2>/dev/null)

  if [ -n "$ORIGIN" ]; then
    log "Pushing to $ORIGIN..."
    git push "$ORIGIN" "$UPSTREAM_BRANCH" 2>>"$LOG_FILE" || log "WARN: Push to $ORIGIN failed (non-fatal)"
  fi

  log "Starting Paperclip..."
  systemctl --user start "$SERVICE_NAME" 2>>"$LOG_FILE"

  server_up=false
  for i in $(seq 1 12); do
    sleep 5
    if api_curl "$API_URL/api/companies" > /dev/null 2>&1; then
      server_up=true
      break
    fi
    log "Waiting for server... (attempt $i/12)"
  done

  if [ "$server_up" = false ]; then
    log "ERROR: Server not responding — rolling back"
    rollback
    exit 1
  fi

  restore_heartbeats
  full_cleanup
  log "Upgrade complete. Server healthy at $(git -C "$REPO_DIR" rev-parse --short HEAD)"
  exit 0
fi
