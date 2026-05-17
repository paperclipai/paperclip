#!/bin/bash
# Paperclip self-hosted upgrade script
#
# Safely upgrades a running Paperclip instance from an upstream git remote.
# Builds in an isolated git worktree so the running server is never touched
# during compilation. Agents are only quiesced for the brief restart window.
# Optional integration mode composes upstream plus selected pull requests into
# a fork branch first, then upgrades the instance to that composed branch.
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
#   6. INTEGRATION MODE: When PAPERCLIP_UPGRADE_MODE=integration, the script
#      fetches upstream and selected PR heads, composes them in the isolated
#      build worktree, writes a state manifest under PAPERCLIP_HOME, and pushes
#      the built result to a fork branch with force-with-lease.
#
#   7. CRON-FRIENDLY: Two cron entries work together:
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
#   5 = rollback complete but server not healthy; agents left drained for safety
#   6 = --restore refused; an active upgrade is running (use --force-restore to override)
#   7 = integration target still misses live fork patches after carry-forward
#
# Environment variables:
#   PAPERCLIP_REPO_DIR       Paperclip repo directory (default: script's grandparent)
#   PAPERCLIP_API_URL        API base URL (default: http://127.0.0.1:3100)
#   PAPERCLIP_COMPANY_ID     Company ID for agent management (auto-detected if omitted)
#   PAPERCLIP_UPSTREAM       Git remote name to pull from (default: upstream)
#   PAPERCLIP_UPSTREAM_BRANCH  Branch to track (default: master)
#   PAPERCLIP_ORIGIN         Git remote to push to after upgrade (default: origin, empty to skip)
#   PAPERCLIP_UPGRADE_ENV_FILE  Optional env file (default: <repo>/.env.upgrade-sh)
#   PAPERCLIP_UPGRADE_MODE   standard|integration (default: standard)
#   PAPERCLIP_INTEGRATION_FORK_REMOTE  Fork remote to push composed branch to (default: github-fork)
#   PAPERCLIP_INTEGRATION_BRANCH  Fork branch for composed upstream+PRs (default: master)
#   PAPERCLIP_INTEGRATION_REPO  GitHub repo for PR discovery (default: paperclipai/paperclip)
#   PAPERCLIP_INTEGRATION_PR_OWNER  GitHub user whose PRs are included (default: fork owner if set)
#   PAPERCLIP_INTEGRATION_FORK_OWNER  Fork owner; controls closed-PR removal policy
#   PAPERCLIP_INTEGRATION_INCLUDE_PRS  Optional comma/space-separated PR numbers to force include
#   PAPERCLIP_INTEGRATION_EXCLUDE_PRS  Optional comma/space-separated PR numbers to skip
#   PAPERCLIP_INTEGRATION_PRESERVE_FORK_PATHS  Optional whitespace-separated paths copied from fork branch after compose
#   PAPERCLIP_GITHUB_TOKEN_UPSTREAM  GitHub API token for upstream PR discovery
#   PAPERCLIP_GITHUB_TOKEN_FORK  Optional GitHub token for HTTPS push to fork remote
#   PAPERCLIP_CODEX_RECONCILE  1/true to let Codex resolve integration conflicts after git/rerere fail
#   PAPERCLIP_CODEX_BIN        Codex executable (default: codex)
#   PAPERCLIP_CODEX_MODEL      Codex model for reconciliation (default: gpt-5.5)
#   PAPERCLIP_CODEX_REASONING_SEQUENCE  Comma/space list of reasoning efforts to try (default: medium,high,xhigh)
#   PAPERCLIP_CODEX_AUTH       subscription|api_key (default: subscription; subscription unsets OPENAI_API_KEY)
#   PAPERCLIP_CODEX_OPENAI_API_KEY  API key used only when PAPERCLIP_CODEX_AUTH=api_key
#   PAPERCLIP_CODEX_TIMEOUT_SEC  Per-attempt Codex timeout (default: 1800)
#   PAPERCLIP_CODEX_SANDBOX    Codex sandbox mode for the isolated build worktree (default: workspace-write)
#   PAPERCLIP_CODEX_SKILL_FILES  Optional whitespace-separated local SKILL.md files appended to reconciliation prompts
#   PAPERCLIP_CODEX_PROMPT_FILES Optional whitespace-separated local prompt component files appended to reconciliation prompts
#   PAPERCLIP_CODEX_PROMPT_APPEND Optional inline prompt text appended to reconciliation prompts
#   PAPERCLIP_SERVICE        Systemd user service name (default: paperclip)
#   PAPERCLIP_API_TOKEN       Bearer token for API calls (required for authenticated deployments)
#   PAPERCLIP_HOME           Paperclip data directory (default: ~/.paperclip)
#   DRAIN_MAX_AGE_SEC        Max seconds to wait for agents to drain (default: 1800)
#   PHASE_TIMEOUT_SEC        Max seconds a phase can run before hung detection (default: 1800)
#
# Usage:
#   ./upgrade.sh --start       # start fresh upgrade
#   ./upgrade.sh               # resume/monitor only
#   ./upgrade.sh --restore     # restore agents from failed run (refused if upgrade is active)
#   ./upgrade.sh --force-restore  # restore agents, bypassing active-upgrade lock check
#   ./upgrade.sh --status      # show current state
#   ./upgrade.sh --preflight   # compose and build target only; no push/quiesce/swap
#   ./upgrade.sh --force-drain # treat unverifiable drain state as drained (use when API is known-unreachable)
#
# Local cron configuration can live in .env.upgrade-sh; .env* files are
# gitignored except .env.example.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

_CODEX_RECONCILE_WAS_SET=0
_CODEX_BIN_WAS_SET=0
_CODEX_MODEL_WAS_SET=0
_CODEX_REASONING_SEQUENCE_WAS_SET=0
_CODEX_AUTH_WAS_SET=0
_CODEX_OPENAI_API_KEY_WAS_SET=0
_CODEX_TIMEOUT_SEC_WAS_SET=0
_CODEX_SANDBOX_WAS_SET=0
_CODEX_EXTRA_ARGS_WAS_SET=0
_CODEX_SKILL_FILES_WAS_SET=0
_CODEX_PROMPT_FILES_WAS_SET=0
_CODEX_PROMPT_APPEND_WAS_SET=0
[ "${PAPERCLIP_CODEX_RECONCILE+x}" ] && { _CODEX_RECONCILE_WAS_SET=1; _CODEX_RECONCILE_OVERRIDE="$PAPERCLIP_CODEX_RECONCILE"; }
[ "${PAPERCLIP_CODEX_BIN+x}" ] && { _CODEX_BIN_WAS_SET=1; _CODEX_BIN_OVERRIDE="$PAPERCLIP_CODEX_BIN"; }
[ "${PAPERCLIP_CODEX_MODEL+x}" ] && { _CODEX_MODEL_WAS_SET=1; _CODEX_MODEL_OVERRIDE="$PAPERCLIP_CODEX_MODEL"; }
[ "${PAPERCLIP_CODEX_REASONING_SEQUENCE+x}" ] && { _CODEX_REASONING_SEQUENCE_WAS_SET=1; _CODEX_REASONING_SEQUENCE_OVERRIDE="$PAPERCLIP_CODEX_REASONING_SEQUENCE"; }
[ "${PAPERCLIP_CODEX_AUTH+x}" ] && { _CODEX_AUTH_WAS_SET=1; _CODEX_AUTH_OVERRIDE="$PAPERCLIP_CODEX_AUTH"; }
[ "${PAPERCLIP_CODEX_OPENAI_API_KEY+x}" ] && { _CODEX_OPENAI_API_KEY_WAS_SET=1; _CODEX_OPENAI_API_KEY_OVERRIDE="$PAPERCLIP_CODEX_OPENAI_API_KEY"; }
[ "${PAPERCLIP_CODEX_TIMEOUT_SEC+x}" ] && { _CODEX_TIMEOUT_SEC_WAS_SET=1; _CODEX_TIMEOUT_SEC_OVERRIDE="$PAPERCLIP_CODEX_TIMEOUT_SEC"; }
[ "${PAPERCLIP_CODEX_SANDBOX+x}" ] && { _CODEX_SANDBOX_WAS_SET=1; _CODEX_SANDBOX_OVERRIDE="$PAPERCLIP_CODEX_SANDBOX"; }
[ "${PAPERCLIP_CODEX_EXTRA_ARGS+x}" ] && { _CODEX_EXTRA_ARGS_WAS_SET=1; _CODEX_EXTRA_ARGS_OVERRIDE="$PAPERCLIP_CODEX_EXTRA_ARGS"; }
[ "${PAPERCLIP_CODEX_SKILL_FILES+x}" ] && { _CODEX_SKILL_FILES_WAS_SET=1; _CODEX_SKILL_FILES_OVERRIDE="$PAPERCLIP_CODEX_SKILL_FILES"; }
[ "${PAPERCLIP_CODEX_PROMPT_FILES+x}" ] && { _CODEX_PROMPT_FILES_WAS_SET=1; _CODEX_PROMPT_FILES_OVERRIDE="$PAPERCLIP_CODEX_PROMPT_FILES"; }
[ "${PAPERCLIP_CODEX_PROMPT_APPEND+x}" ] && { _CODEX_PROMPT_APPEND_WAS_SET=1; _CODEX_PROMPT_APPEND_OVERRIDE="$PAPERCLIP_CODEX_PROMPT_APPEND"; }

# Load local cron/operator configuration before reading overridable variables.
# The file is intentionally outside git and must never be logged.
UPGRADE_ENV_FILE="${PAPERCLIP_UPGRADE_ENV_FILE:-$(cd "$SCRIPT_DIR/.." && pwd)/.env.upgrade-sh}"
if [ -f "$UPGRADE_ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$UPGRADE_ENV_FILE"
  set +a
fi

[ "$_CODEX_RECONCILE_WAS_SET" = "1" ] && PAPERCLIP_CODEX_RECONCILE="$_CODEX_RECONCILE_OVERRIDE"
[ "$_CODEX_BIN_WAS_SET" = "1" ] && PAPERCLIP_CODEX_BIN="$_CODEX_BIN_OVERRIDE"
[ "$_CODEX_MODEL_WAS_SET" = "1" ] && PAPERCLIP_CODEX_MODEL="$_CODEX_MODEL_OVERRIDE"
[ "$_CODEX_REASONING_SEQUENCE_WAS_SET" = "1" ] && PAPERCLIP_CODEX_REASONING_SEQUENCE="$_CODEX_REASONING_SEQUENCE_OVERRIDE"
[ "$_CODEX_AUTH_WAS_SET" = "1" ] && PAPERCLIP_CODEX_AUTH="$_CODEX_AUTH_OVERRIDE"
[ "$_CODEX_OPENAI_API_KEY_WAS_SET" = "1" ] && PAPERCLIP_CODEX_OPENAI_API_KEY="$_CODEX_OPENAI_API_KEY_OVERRIDE"
[ "$_CODEX_TIMEOUT_SEC_WAS_SET" = "1" ] && PAPERCLIP_CODEX_TIMEOUT_SEC="$_CODEX_TIMEOUT_SEC_OVERRIDE"
[ "$_CODEX_SANDBOX_WAS_SET" = "1" ] && PAPERCLIP_CODEX_SANDBOX="$_CODEX_SANDBOX_OVERRIDE"
[ "$_CODEX_EXTRA_ARGS_WAS_SET" = "1" ] && PAPERCLIP_CODEX_EXTRA_ARGS="$_CODEX_EXTRA_ARGS_OVERRIDE"
[ "$_CODEX_SKILL_FILES_WAS_SET" = "1" ] && PAPERCLIP_CODEX_SKILL_FILES="$_CODEX_SKILL_FILES_OVERRIDE"
[ "$_CODEX_PROMPT_FILES_WAS_SET" = "1" ] && PAPERCLIP_CODEX_PROMPT_FILES="$_CODEX_PROMPT_FILES_OVERRIDE"
[ "$_CODEX_PROMPT_APPEND_WAS_SET" = "1" ] && PAPERCLIP_CODEX_PROMPT_APPEND="$_CODEX_PROMPT_APPEND_OVERRIDE"

# Ensure systemctl --user works from non-interactive contexts (cron, agents, timers).
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=${XDG_RUNTIME_DIR}/bus}"

# ---------------------------------------------------------------------------
# Configuration (all overridable via environment)
# ---------------------------------------------------------------------------

REPO_DIR="${PAPERCLIP_REPO_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
API_URL="${PAPERCLIP_API_URL:-http://127.0.0.1:3100}"
UPSTREAM="${PAPERCLIP_UPSTREAM:-upstream}"
UPSTREAM_BRANCH="${PAPERCLIP_UPSTREAM_BRANCH:-master}"
ORIGIN="${PAPERCLIP_ORIGIN:-origin}"
SERVICE_NAME="${PAPERCLIP_SERVICE:-paperclip}"
PAPERCLIP_HOME="${PAPERCLIP_HOME:-$HOME/.paperclip}"
DRAIN_MAX_AGE_SEC=${DRAIN_MAX_AGE_SEC:-1800}
PHASE_TIMEOUT_SEC=${PHASE_TIMEOUT_SEC:-1800}
UPGRADE_MODE="${PAPERCLIP_UPGRADE_MODE:-standard}"

INTEGRATION_FORK_REMOTE="${PAPERCLIP_INTEGRATION_FORK_REMOTE:-github-fork}"
INTEGRATION_BRANCH="${PAPERCLIP_INTEGRATION_BRANCH:-master}"
INTEGRATION_REPO="${PAPERCLIP_INTEGRATION_REPO:-paperclipai/paperclip}"
INTEGRATION_FORK_OWNER="${PAPERCLIP_INTEGRATION_FORK_OWNER:-}"
INTEGRATION_PR_OWNER="${PAPERCLIP_INTEGRATION_PR_OWNER:-$INTEGRATION_FORK_OWNER}"
INTEGRATION_INCLUDE_PRS="${PAPERCLIP_INTEGRATION_INCLUDE_PRS:-}"
INTEGRATION_EXCLUDE_PRS="${PAPERCLIP_INTEGRATION_EXCLUDE_PRS:-}"
INTEGRATION_PRESERVE_FORK_PATHS="${PAPERCLIP_INTEGRATION_PRESERVE_FORK_PATHS:-}"
INTEGRATION_MAX_PR_PAGES="${PAPERCLIP_INTEGRATION_MAX_PR_PAGES:-20}"
INTEGRATION_GITHUB_API_URL="${PAPERCLIP_GITHUB_API_URL:-https://api.github.com}"
GITHUB_TOKEN_UPSTREAM="${PAPERCLIP_GITHUB_TOKEN_UPSTREAM:-${GITHUB_TOKEN:-}}"
GITHUB_TOKEN_FORK="${PAPERCLIP_GITHUB_TOKEN_FORK:-}"

CODEX_RECONCILE="${PAPERCLIP_CODEX_RECONCILE:-0}"
CODEX_BIN="${PAPERCLIP_CODEX_BIN:-codex}"
CODEX_MODEL="${PAPERCLIP_CODEX_MODEL:-gpt-5.5}"
CODEX_REASONING_SEQUENCE="${PAPERCLIP_CODEX_REASONING_SEQUENCE:-medium,high,xhigh}"
CODEX_AUTH="${PAPERCLIP_CODEX_AUTH:-subscription}"
CODEX_OPENAI_API_KEY="${PAPERCLIP_CODEX_OPENAI_API_KEY:-}"
CODEX_TIMEOUT_SEC="${PAPERCLIP_CODEX_TIMEOUT_SEC:-1800}"
CODEX_SANDBOX="${PAPERCLIP_CODEX_SANDBOX:-workspace-write}"
CODEX_EXTRA_ARGS="${PAPERCLIP_CODEX_EXTRA_ARGS:-}"
CODEX_SKILL_FILES="${PAPERCLIP_CODEX_SKILL_FILES:-}"
CODEX_PROMPT_FILES="${PAPERCLIP_CODEX_PROMPT_FILES:-}"
CODEX_PROMPT_APPEND="${PAPERCLIP_CODEX_PROMPT_APPEND:-}"
CODEX_RECONCILE_ACTIVE=1

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
COMPANY_ID_FILE="$STATE_DIR/company-id"
TARGET_REF_FILE="$STATE_DIR/target-ref"
INTEGRATION_MANIFEST_FILE="$STATE_DIR/integration-manifest.json"
INTEGRATION_CONFLICT_BASE_FILE="$STATE_DIR/integration-conflict-base"
INTEGRATION_MAIN_CONFLICTS_FILE="$STATE_DIR/integration-main-conflicts.json"
INTEGRATION_COMPOSE_CONFLICTS_FILE="$STATE_DIR/integration-compose-conflicts.json"
INTEGRATION_PREVIOUS_MANIFEST_FILE="$STATE_DIR/integration-previous-manifest.json"

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

github_api() {
  local url="$1"
  if [ -n "$GITHUB_TOKEN_UPSTREAM" ]; then
    curl -sf \
      --retry 3 \
      --retry-delay 2 \
      --retry-all-errors \
      -H "Authorization: Bearer $GITHUB_TOKEN_UPSTREAM" \
      -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      "$url"
  else
    curl -sf \
      --retry 3 \
      --retry-delay 2 \
      --retry-all-errors \
      -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      "$url"
  fi
}

fetch_github_json() {
  local url="$1"
  local output="$2"
  local tmp_output
  local attempt
  tmp_output="$output.tmp"
  for attempt in 1 2 3; do
    rm -f "$tmp_output"
    if github_api "$url" > "$tmp_output" && jq empty "$tmp_output" >/dev/null 2>&1; then
      mv "$tmp_output" "$output"
      return 0
    fi
    log "WARN: GitHub JSON fetch failed or was truncated (attempt $attempt/3): $url"
    sleep $(( attempt * 2 ))
  done
  rm -f "$tmp_output"
  return 1
}

normalize_number_list() {
  printf '%s\n' "$1" | tr ', ' '\n\n' | awk 'NF { print }'
}

ensure_integration_config() {
  if [ "$UPGRADE_MODE" != "integration" ]; then
    return
  fi
  if [ -z "$INTEGRATION_PR_OWNER" ]; then
    log "ERROR: PAPERCLIP_INTEGRATION_PR_OWNER or PAPERCLIP_INTEGRATION_FORK_OWNER is required in integration mode"
    exit 1
  fi
  if ! command -v jq >/dev/null 2>&1; then
    log "ERROR: jq is required for integration mode"
    exit 1
  fi
}

fetch_all_open_prs_json() {
  local output="$1"
  local page page_file count
  : > "$output"
  for page in $(seq 1 "$INTEGRATION_MAX_PR_PAGES"); do
    page_file="$STATE_DIR/open-prs-page-$page.json"
    if ! fetch_github_json "$INTEGRATION_GITHUB_API_URL/repos/$INTEGRATION_REPO/pulls?state=open&per_page=100&page=$page&sort=updated&direction=desc" "$page_file"; then
      log "ERROR: Failed to fetch open PR page $page for $INTEGRATION_REPO"
      exit 1
    fi
    count=$(jq 'length' "$page_file")
    jq -c '.[]' "$page_file" >> "$output"
    rm -f "$page_file"
    [ "$count" -lt 100 ] && break
    if [ "$page" = "$INTEGRATION_MAX_PR_PAGES" ]; then
      log "WARN: reached PAPERCLIP_INTEGRATION_MAX_PR_PAGES=$INTEGRATION_MAX_PR_PAGES while fetching open PRs"
    fi
  done
  return 0
}

fetch_pull_json() {
  local number="$1"
  local output="$2"
  fetch_github_json "$INTEGRATION_GITHUB_API_URL/repos/$INTEGRATION_REPO/pulls/$number" "$output"
}

fetch_issue_json() {
  local number="$1"
  local output="$2"
  fetch_github_json "$INTEGRATION_GITHUB_API_URL/repos/$INTEGRATION_REPO/issues/$number" "$output"
}

build_integration_pr_manifest() {
  local open_jsonl="$STATE_DIR/integration-open-prs.jsonl"
  local candidates_jsonl="$STATE_DIR/integration-candidate-prs.jsonl"
  local tracked_numbers="$STATE_DIR/integration-tracked-prs.txt"
  local previous_numbers="$STATE_DIR/integration-previous-prs.txt"
  local pull_file issue_file state merged closed_by number

  fetch_all_open_prs_json "$open_jsonl"
  : > "$candidates_jsonl"
  : > "$previous_numbers"

  jq -c --arg owner "$INTEGRATION_PR_OWNER" '
    select(.user.login == $owner or .head.user.login == $owner)
    | {
        number,
        title,
        state,
        merged: false,
        closedBy: null,
        headSha: .head.sha,
        headRef: .head.ref,
        headRepo: .head.repo.full_name
      }
  ' "$open_jsonl" >> "$candidates_jsonl"

  if [ -f "$INTEGRATION_MANIFEST_FILE" ]; then
    cp "$INTEGRATION_MANIFEST_FILE" "$INTEGRATION_PREVIOUS_MANIFEST_FILE"
    jq -r '.prs[]?.number' "$INTEGRATION_MANIFEST_FILE" > "$previous_numbers"
  fi

  normalize_number_list "$INTEGRATION_INCLUDE_PRS" >> "$previous_numbers"
  awk 'NF && !seen[$0]++' "$previous_numbers" > "$tracked_numbers"

  while IFS= read -r number; do
    [ -z "$number" ] && continue
    if jq -e --argjson number "$number" 'select(.number == $number)' "$candidates_jsonl" >/dev/null; then
      continue
    fi
    pull_file="$STATE_DIR/pull-$number.json"
    issue_file="$STATE_DIR/issue-$number.json"
    if ! fetch_pull_json "$number" "$pull_file"; then
      log "WARN: Could not fetch tracked PR #$number; keeping it out of this run"
      rm -f "$pull_file" "$issue_file"
      continue
    fi
    state=$(jq -r '.state' "$pull_file")
    merged=$(jq -r '(.merged_at != null)' "$pull_file")
    closed_by=""
    if [ "$state" = "closed" ]; then
      fetch_issue_json "$number" "$issue_file" || true
      closed_by=$(jq -r '.closed_by.login // ""' "$issue_file" 2>/dev/null || echo "")
    fi
    if [ "$merged" = "true" ]; then
      log "Integration: removing PR #$number because it has been merged"
      rm -f "$pull_file" "$issue_file"
      continue
    fi
    if [ "$state" = "closed" ] && [ -n "$INTEGRATION_FORK_OWNER" ] && [ "$closed_by" = "$INTEGRATION_FORK_OWNER" ]; then
      log "Integration: removing PR #$number because $INTEGRATION_FORK_OWNER closed it unmerged"
      rm -f "$pull_file" "$issue_file"
      continue
    fi
    jq -c --arg closedBy "$closed_by" '{
      number,
      title,
      state,
      merged: (.merged_at != null),
      closedBy: ($closedBy | if . == "" then null else . end),
      headSha: .head.sha,
      headRef: .head.ref,
      headRepo: .head.repo.full_name
    }' "$pull_file" >> "$candidates_jsonl"
    rm -f "$pull_file" "$issue_file"
  done < "$tracked_numbers"

  normalize_number_list "$INTEGRATION_EXCLUDE_PRS" > "$STATE_DIR/integration-excluded-prs.txt"
  jq -R 'select(length > 0) | tonumber' "$STATE_DIR/integration-excluded-prs.txt" \
    | jq -s '.' > "$STATE_DIR/integration-excluded-prs.json"
  jq -s '
    unique_by(.number)
    | sort_by(.number)
  ' "$candidates_jsonl" \
    | jq --slurpfile excluded "$STATE_DIR/integration-excluded-prs.json" '
      map(select((.number as $n | $excluded[0] | index($n)) | not))
    ' > "$STATE_DIR/integration-prs.json"

  rm -f "$open_jsonl" "$candidates_jsonl" "$tracked_numbers" "$previous_numbers" \
    "$STATE_DIR/integration-excluded-prs.txt" "$STATE_DIR/integration-excluded-prs.json"
}

fetch_integration_pr_refs() {
  local number
  jq -r '.[].number' "$STATE_DIR/integration-prs.json" | while IFS= read -r number; do
    [ -z "$number" ] && continue
    log "Integration: fetching PR #$number"
    if ! git -C "$REPO_DIR" fetch "$UPSTREAM" "+pull/$number/head:refs/remotes/paperclip-integration/pr-$number" 2>>"$LOG_FILE"; then
      log "ERROR: Failed to fetch PR #$number from $UPSTREAM"
      return 1
    fi
  done
}

record_integration_conflict() {
  local output="$1"
  local number="$2"
  local title="$3"
  local upstream_commit="$4"
  local pr_base="$5"
  local files_json
  files_json=$(git -C "$BUILD_DIR" diff --name-only --diff-filter=U \
    | jq -R -s 'split("\n") | map(select(length > 0))')
  jq -n \
    --argjson number "$number" \
    --arg title "$title" \
    --arg upstreamSha "$upstream_commit" \
    --arg prBase "$pr_base" \
    --argjson files "$files_json" \
    '{number: $number, title: $title, upstreamSha: $upstreamSha, prBase: $prBase, files: $files}' \
    >> "$output"
}

write_json_array_from_jsonl() {
  local jsonl="$1"
  local output="$2"
  if [ -s "$jsonl" ]; then
    jq -s '.' "$jsonl" > "$output"
  else
    printf '[]\n' > "$output"
  fi
}

finalize_integration_compose_conflicts() {
  write_json_array_from_jsonl "$STATE_DIR/integration-compose-conflicts.jsonl" "$INTEGRATION_COMPOSE_CONFLICTS_FILE"
  rm -f "$STATE_DIR/integration-compose-conflicts.jsonl"
}

codex_reconcile_enabled() {
  case "$CODEX_RECONCILE" in
    1|true|TRUE|yes|YES|on|ON)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

ensure_codex_config() {
  if ! codex_reconcile_enabled; then
    return 1
  fi
  if [ "${CODEX_RECONCILE_ACTIVE:-1}" != "1" ]; then
    return 1
  fi
  if ! command -v "$CODEX_BIN" >/dev/null 2>&1; then
    log "WARN: PAPERCLIP_CODEX_RECONCILE is enabled but Codex executable '$CODEX_BIN' was not found"
    return 1
  fi
  case "$CODEX_AUTH" in
    subscription|oauth|api_key)
      ;;
    *)
      log "WARN: unsupported PAPERCLIP_CODEX_AUTH=$CODEX_AUTH; expected subscription or api_key"
      return 1
      ;;
  esac
  if [ "$CODEX_AUTH" = "api_key" ] && [ -z "$CODEX_OPENAI_API_KEY" ] && [ -z "${OPENAI_API_KEY:-}" ]; then
    log "WARN: PAPERCLIP_CODEX_AUTH=api_key but neither PAPERCLIP_CODEX_OPENAI_API_KEY nor OPENAI_API_KEY is set"
    return 1
  fi
  return 0
}

append_codex_prompt_file() {
  local prompt_file="$1"
  local source_file="$2"
  local label="$3"

  if [ ! -f "$source_file" ]; then
    log "WARN: Codex prompt component not found: $source_file"
    return 0
  fi

  {
    printf '\n\n## %s\n\n' "$label"
    printf 'Source: %s\n\n' "$source_file"
    cat "$source_file"
  } >> "$prompt_file"
}

append_codex_prompt_extensions() {
  local prompt_file="$1"
  local source_file

  if [ -n "$CODEX_SKILL_FILES" ]; then
    for source_file in $CODEX_SKILL_FILES; do
      append_codex_prompt_file "$prompt_file" "$source_file" "Local Skill"
    done
  fi

  if [ -n "$CODEX_PROMPT_FILES" ]; then
    for source_file in $CODEX_PROMPT_FILES; do
      append_codex_prompt_file "$prompt_file" "$source_file" "Local Prompt Component"
    done
  fi

  if [ -n "$CODEX_PROMPT_APPEND" ]; then
    {
      printf '\n\n## Local Prompt Addition\n\n'
      printf '%s\n' "$CODEX_PROMPT_APPEND"
    } >> "$prompt_file"
  fi
}

write_codex_reconcile_prompt() {
  local operation="$1"
  local subject="$2"
  local prompt_file="$3"
  local conflict_files status upstream_short head_short

  conflict_files=$(git -C "$BUILD_DIR" diff --name-only --diff-filter=U | sed 's/^/- /' || true)
  status=$(git -C "$BUILD_DIR" status --short)
  upstream_short=$(git -C "$REPO_DIR" rev-parse --short "$UPSTREAM/$UPSTREAM_BRANCH" 2>/dev/null || echo unknown)
  head_short=$(git -C "$BUILD_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)

  cat > "$prompt_file" <<EOF
You are reconciling a Paperclip integration upgrade in an isolated build worktree.

Worktree: $BUILD_DIR
Live repo: $REPO_DIR
Operation: $operation
Subject: $subject
Current build HEAD: $head_short
Upstream target: $UPSTREAM/$UPSTREAM_BRANCH at $upstream_short

Conflicted files:
${conflict_files:-none reported}

Current git status:
$status

Resolve the merge/cherry-pick conflict in this isolated worktree only.

Requirements:
- Preserve upstream intent and the fork/PR intent. Do not drop behavior from either side just to make the conflict disappear.
- Keep Paperclip company scoping, plugin SDK behavior, adapter behavior, auth/session behavior, and migrations coherent across db/shared/server/ui.
- Edit only files inside $BUILD_DIR.
- Do not push, stop services, quiesce agents, restart Paperclip, or touch the live checkout at $REPO_DIR.
- Stage resolved files with git add when complete if your sandbox permits it, but do not commit, continue, reset, abort, or push.
- If git add cannot write the worktree index, leave the file contents resolved; the parent upgrade script will stage resolved paths after checking for conflict markers.
- Run the smallest relevant verification you can afford for touched files; if you cannot run it, leave a concise note in your final response.
- Leave the worktree with no unmerged files and no conflict markers.
EOF

  append_codex_prompt_extensions "$prompt_file"
}

run_codex_reconcile_attempt() {
  local effort="$1"
  local prompt_file="$2"
  local output_file="$3"
  local api_key
  local extra_args=()
  local codex_args=()

  if [ -n "$CODEX_EXTRA_ARGS" ]; then
    # Optional advanced override; supports simple whitespace-separated flags.
    read -r -a extra_args <<< "$CODEX_EXTRA_ARGS"
  fi

  codex_args=(
    "$CODEX_BIN" exec
    -C "$BUILD_DIR"
    --skip-git-repo-check
    --sandbox "$CODEX_SANDBOX"
    --model "$CODEX_MODEL"
    -c "model_reasoning_effort=\"$effort\""
    -o "$output_file"
    "${extra_args[@]}"
  )

  if [ "$CODEX_AUTH" = "api_key" ]; then
    api_key="${CODEX_OPENAI_API_KEY:-${OPENAI_API_KEY:-}}"
    timeout "$CODEX_TIMEOUT_SEC" env OPENAI_API_KEY="$api_key" "${codex_args[@]}" < "$prompt_file" >> "$LOG_FILE" 2>&1
  else
    timeout "$CODEX_TIMEOUT_SEC" env -u OPENAI_API_KEY "${codex_args[@]}" < "$prompt_file" >> "$LOG_FILE" 2>&1
  fi
}

stage_codex_resolved_unmerged_files() {
  local unmerged_file unmerged_paths
  unmerged_paths="$STATE_DIR/codex-unmerged-paths.nul"
  git -C "$BUILD_DIR" diff --name-only -z --diff-filter=U > "$unmerged_paths"
  if [ ! -s "$unmerged_paths" ]; then
    return 0
  fi

  while IFS= read -r -d '' unmerged_file; do
    if [ -f "$BUILD_DIR/$unmerged_file" ] \
      && grep -Eq '^(<<<<<<<|=======|>>>>>>>)' "$BUILD_DIR/$unmerged_file"; then
      return 1
    fi
  done < "$unmerged_paths"

  git -C "$BUILD_DIR" add -A --pathspec-from-file="$unmerged_paths" --pathspec-file-nul
}

try_codex_reconcile() {
  local operation="$1"
  local subject="$2"
  local effort prompt_file output_file attempt_status

  if ! ensure_codex_config; then
    return 1
  fi

  prompt_file="$STATE_DIR/codex-reconcile-prompt.md"
  output_file="$STATE_DIR/codex-reconcile-last-message.md"
  write_codex_reconcile_prompt "$operation" "$subject" "$prompt_file"

  while IFS= read -r effort; do
    [ -z "$effort" ] && continue
    log "Integration: invoking Codex reconciliation ($CODEX_MODEL/$effort) for $operation: $subject"
    set +e
    run_codex_reconcile_attempt "$effort" "$prompt_file" "$output_file"
    attempt_status=$?
    set -e
    if [ "$attempt_status" != "0" ]; then
      log "WARN: Codex reconciliation attempt $CODEX_MODEL/$effort exited with status $attempt_status"
    fi
    if git -C "$BUILD_DIR" diff --name-only --diff-filter=U | grep -q .; then
      if stage_codex_resolved_unmerged_files; then
        log "Integration: parent script staged resolved unmerged files after Codex $CODEX_MODEL/$effort attempt"
      fi
    fi
    if git -C "$BUILD_DIR" diff --name-only --diff-filter=U | grep -q .; then
      log "WARN: Codex reconciliation $CODEX_MODEL/$effort left unresolved files"
      continue
    fi
    if ! git -C "$BUILD_DIR" diff --check >> "$LOG_FILE" 2>&1; then
      log "WARN: Codex reconciliation $CODEX_MODEL/$effort left working-tree whitespace/conflict-marker issues"
      continue
    fi
    if ! git -C "$BUILD_DIR" diff --cached --check >> "$LOG_FILE" 2>&1; then
      log "WARN: Codex reconciliation $CODEX_MODEL/$effort left staged whitespace/conflict-marker issues"
      continue
    fi
    log "Integration: Codex reconciliation resolved $operation with $CODEX_MODEL/$effort"
    return 0
  done < <(normalize_number_list "$CODEX_REASONING_SEQUENCE")

  return 1
}

report_pr_main_conflicts() {
  local upstream_commit="$1"
  local conflicts_jsonl="$STATE_DIR/integration-main-conflicts.jsonl"
  local number title pr_ref pr_base count

  : > "$conflicts_jsonl"
  log "Integration: checking tracked PRs for direct conflicts with $(git -C "$REPO_DIR" rev-parse --short "$upstream_commit")"
  while IFS=$'\t' read -r number title; do
    [ -z "$number" ] && continue
    pr_ref="refs/remotes/paperclip-integration/pr-$number"
    pr_base=$(git -C "$REPO_DIR" merge-base "$UPSTREAM/$UPSTREAM_BRANCH" "$pr_ref")

    if [ -d "$BUILD_DIR" ]; then
      git -C "$REPO_DIR" worktree remove --force "$BUILD_DIR" 2>/dev/null || rm -rf "$BUILD_DIR"
    fi
    git -C "$REPO_DIR" worktree add --detach "$BUILD_DIR" "$upstream_commit" 2>>"$LOG_FILE"

    if ! git -C "$BUILD_DIR" merge --no-ff --no-edit "$pr_ref" 2>>"$LOG_FILE"; then
      log "WARN: PR #$number conflicts with $UPSTREAM/$UPSTREAM_BRANCH - $title"
      record_integration_conflict "$conflicts_jsonl" "$number" "$title" "$upstream_commit" "$pr_base"
      git -C "$BUILD_DIR" merge --abort 2>>"$LOG_FILE" || true
    fi
  done < <(jq -r '.[] | [.number, (.title | gsub("\t"; " "))] | @tsv' "$STATE_DIR/integration-prs.json")

  write_json_array_from_jsonl "$conflicts_jsonl" "$INTEGRATION_MAIN_CONFLICTS_FILE"
  rm -f "$conflicts_jsonl"
  count=$(jq 'length' "$INTEGRATION_MAIN_CONFLICTS_FILE")
  if [ "$count" != "0" ]; then
    log "WARN: $count tracked PR(s) conflict directly with $UPSTREAM/$UPSTREAM_BRANCH; see $INTEGRATION_MAIN_CONFLICTS_FILE"
  else
    log "Integration: no tracked PRs conflict directly with $UPSTREAM/$UPSTREAM_BRANCH"
  fi
}

compose_integration_candidate() {
  local upstream_commit="$1"
  local number title pr_ref pr_base

  if [ -d "$BUILD_DIR" ]; then
    git -C "$REPO_DIR" worktree remove --force "$BUILD_DIR" 2>/dev/null || rm -rf "$BUILD_DIR"
  fi
  git -C "$REPO_DIR" worktree add --detach "$BUILD_DIR" "$upstream_commit" 2>>"$LOG_FILE"

  while IFS=$'\t' read -r number title; do
    [ -z "$number" ] && continue
    pr_ref="refs/remotes/paperclip-integration/pr-$number"
    pr_base=$(git -C "$REPO_DIR" merge-base "$UPSTREAM/$UPSTREAM_BRANCH" "$pr_ref")

    if git -C "$BUILD_DIR" merge-base --is-ancestor "$pr_ref" HEAD; then
      log "Integration: skipping PR #$number - already contained in candidate"
      continue
    fi

    log "Integration: merging PR #$number - $title"
    if git -C "$BUILD_DIR" \
      -c rerere.enabled=true \
      -c rerere.autoupdate=true \
      merge --no-ff --no-edit -m "Integrate PR #$number: $title" "$pr_ref" 2>>"$LOG_FILE"; then
      continue
    fi

    if ! git -C "$BUILD_DIR" diff --name-only --diff-filter=U | grep -q .; then
      log "Integration: rerere resolved PR #$number conflict; committing recorded resolution"
      if git -C "$BUILD_DIR" commit --no-edit 2>>"$LOG_FILE"; then
        continue
      fi
    fi

    if try_codex_reconcile "merge" "PR #$number - $title"; then
      git -C "$BUILD_DIR" add -A
      if git -C "$BUILD_DIR" commit --no-edit 2>>"$LOG_FILE"; then
        continue
      fi
      log "WARN: Codex resolved PR #$number files, but git commit --no-edit failed"
    fi

    log "ERROR: Integration merge conflict while applying PR #$number"
    if git -C "$BUILD_DIR" diff --name-only --diff-filter=U | grep -q .; then
      echo "$pr_base" > "$INTEGRATION_CONFLICT_BASE_FILE"
      record_integration_conflict "$STATE_DIR/integration-compose-conflicts.jsonl" "$number" "$title" "$upstream_commit" "$pr_base"
    fi
    git -C "$BUILD_DIR" merge --abort 2>>"$LOG_FILE" || git -C "$BUILD_DIR" reset --hard HEAD 2>>"$LOG_FILE" || true
    return 1
  done < <(jq -r '.[] | [.number, (.title | gsub("\t"; " "))] | @tsv' "$STATE_DIR/integration-prs.json")

  return 0
}

normalize_integration_migrations() {
  local normalize_output

  [ -d "$BUILD_DIR/packages/db/src/migrations" ] || return 0

  normalize_output=$(BUILD_DIR="$BUILD_DIR" node <<'EOF'
const fs = require("node:fs");
const path = require("node:path");

const buildDir = process.env.BUILD_DIR;
const migrationsDir = path.join(buildDir, "packages/db/src/migrations");
const journalPath = path.join(migrationsDir, "meta/_journal.json");

const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
const entries = Array.isArray(journal.entries) ? journal.entries : [];
const journalTags = new Set(entries.map((entry) => entry.tag).filter((tag) => typeof tag === "string"));

function readSqlFiles() {
  return fs.readdirSync(migrationsDir)
    .filter((entry) => entry.endsWith(".sql"))
    .sort();
}

function suffix(tag) {
  const match = tag.match(/^\d{4}_(.+)$/);
  return match ? match[1] : null;
}

let changed = false;

for (const file of readSqlFiles()) {
  const tag = file.slice(0, -".sql".length);
  if (journalTags.has(tag)) {
    continue;
  }

  const fileSuffix = suffix(tag);
  if (!fileSuffix) {
    continue;
  }

  const targetTags = entries
    .map((entry) => entry.tag)
    .filter((entryTag) => typeof entryTag === "string" && suffix(entryTag) === fileSuffix);
  const missingTargetTags = targetTags.filter((entryTag) => !fs.existsSync(path.join(migrationsDir, `${entryTag}.sql`)));

  if (targetTags.length === 1 && missingTargetTags.length === 0) {
    const sourcePath = path.join(migrationsDir, file);
    const targetPath = path.join(migrationsDir, `${targetTags[0]}.sql`);
    if (fs.existsSync(targetPath) && fs.readFileSync(sourcePath, "utf8") === fs.readFileSync(targetPath, "utf8")) {
      fs.unlinkSync(sourcePath);
      console.log(`removed duplicate ${file}; ${targetTags[0]}.sql already exists`);
      changed = true;
    }
    continue;
  }

  if (missingTargetTags.length !== 1) {
    continue;
  }

  const sourcePath = path.join(migrationsDir, file);
  const targetPath = path.join(migrationsDir, `${missingTargetTags[0]}.sql`);
  fs.renameSync(sourcePath, targetPath);
  console.log(`renamed ${file} -> ${missingTargetTags[0]}.sql`);
  changed = true;
}

const renamePlans = [];
let lastNumber = -1;

for (const entry of entries) {
  if (typeof entry.tag !== "string") {
    continue;
  }

  const entrySuffix = suffix(entry.tag);
  const parsedNumber = Number.parseInt(entry.tag.slice(0, 4), 10);
  if (!entrySuffix || !Number.isInteger(parsedNumber)) {
    continue;
  }

  const nextNumber = parsedNumber <= lastNumber ? lastNumber + 1 : parsedNumber;
  lastNumber = nextNumber;

  const nextTag = `${String(nextNumber).padStart(4, "0")}_${entrySuffix}`;
  if (nextTag === entry.tag) {
    if (entry.idx !== nextNumber) {
      entry.idx = nextNumber;
      changed = true;
    }
    continue;
  }

  renamePlans.push({ from: entry.tag, to: nextTag });
  entry.idx = nextNumber;
  entry.tag = nextTag;
  changed = true;
}

if (renamePlans.length > 0) {
  const tempPlans = [];
  for (const [index, plan] of renamePlans.entries()) {
    const sourcePath = path.join(migrationsDir, `${plan.from}.sql`);
    if (!fs.existsSync(sourcePath)) {
      continue;
    }
    const tempPath = path.join(migrationsDir, `.${process.pid}.${index}.${plan.from}.renaming`);
    fs.renameSync(sourcePath, tempPath);
    tempPlans.push({ ...plan, tempPath });
  }
  for (const plan of tempPlans) {
    const targetPath = path.join(migrationsDir, `${plan.to}.sql`);
    if (fs.existsSync(targetPath)) {
      throw new Error(`Cannot renumber migration ${plan.from} to ${plan.to}; target already exists`);
    }
    fs.renameSync(plan.tempPath, targetPath);
    console.log(`renumbered ${plan.from}.sql -> ${plan.to}.sql`);
  }
}

if (changed) {
  fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
}
EOF
)

  if [ -n "$normalize_output" ]; then
    while IFS= read -r line; do
      [ -n "$line" ] && log "Integration: migration numbering $line"
    done <<< "$normalize_output"
  fi

  if ! git -C "$BUILD_DIR" diff --quiet -- packages/db/src/migrations; then
    git -C "$BUILD_DIR" add packages/db/src/migrations
    git -C "$BUILD_DIR" commit -m "Normalize integration migration numbering" 2>>"$LOG_FILE"
  fi
}

preserve_configured_fork_paths() {
  local fork_ref path changed=0

  [ -n "$INTEGRATION_PRESERVE_FORK_PATHS" ] || return 0
  fork_ref="$INTEGRATION_FORK_REMOTE/$INTEGRATION_BRANCH"
  if ! git -C "$REPO_DIR" rev-parse --verify "$fork_ref" >/dev/null 2>&1; then
    log "WARN: cannot preserve configured fork paths because $fork_ref is unavailable"
    return 0
  fi

  for path in $INTEGRATION_PRESERVE_FORK_PATHS; do
    case "$path" in
      /*|*..*)
        log "WARN: refusing unsafe configured fork preserve path: $path"
        continue
        ;;
    esac

    if ! git -C "$REPO_DIR" cat-file -e "$fork_ref:$path" 2>/dev/null; then
      log "WARN: configured fork preserve path does not exist on $fork_ref: $path"
      continue
    fi

    if git -C "$BUILD_DIR" diff --quiet "$fork_ref" -- "$path"; then
      continue
    fi

    mkdir -p "$BUILD_DIR/$(dirname "$path")"
    git -C "$REPO_DIR" show "$fork_ref:$path" > "$BUILD_DIR/$path"
    git -C "$BUILD_DIR" add "$path"
    log "Integration: preserved configured fork path from $fork_ref: $path"
    changed=1
  done

  if [ "$changed" = "1" ]; then
    git -C "$BUILD_DIR" commit -m "Preserve configured fork paths" 2>>"$LOG_FILE"
  fi
}

find_last_integrated_upstream_sha() {
  if [ -f "$INTEGRATION_MANIFEST_FILE" ]; then
    jq -r '.upstream.sha // .upstreamSha // empty' "$INTEGRATION_MANIFEST_FILE"
    return
  fi
  if git -C "$REPO_DIR" rev-parse --verify "$INTEGRATION_FORK_REMOTE/$INTEGRATION_BRANCH" >/dev/null 2>&1; then
    git -C "$REPO_DIR" merge-base "$INTEGRATION_FORK_REMOTE/$INTEGRATION_BRANCH" "$UPSTREAM/$UPSTREAM_BRANCH" 2>/dev/null || true
  fi
}

find_initial_integration_base() {
  local number ref base best=""
  while IFS= read -r number; do
    [ -z "$number" ] && continue
    ref="refs/remotes/paperclip-integration/pr-$number"
    if git -C "$REPO_DIR" rev-parse --verify "$ref" >/dev/null 2>&1; then
      base=$(git -C "$REPO_DIR" merge-base "$UPSTREAM/$UPSTREAM_BRANCH" "$ref")
      if [ -z "$best" ] || git -C "$REPO_DIR" merge-base --is-ancestor "$best" "$base"; then
        best="$base"
      fi
    fi
  done < <(jq -r '.[].number' "$STATE_DIR/integration-prs.json")

  if [ -z "$best" ]; then
    git -C "$REPO_DIR" rev-parse "$UPSTREAM/$UPSTREAM_BRANCH"
    return
  fi

  echo "$best"
}

write_integration_manifest() {
  local upstream_sha="$1"
  local composed_sha="$2"
  local output="$3"
  jq -n \
    --arg generatedAt "$(date -Is)" \
    --arg repo "$INTEGRATION_REPO" \
    --arg upstreamRemote "$UPSTREAM" \
    --arg upstreamBranch "$UPSTREAM_BRANCH" \
    --arg upstreamSha "$upstream_sha" \
    --arg forkRemote "$INTEGRATION_FORK_REMOTE" \
    --arg integrationBranch "$INTEGRATION_BRANCH" \
    --arg composedSha "$composed_sha" \
    --slurpfile prs "$STATE_DIR/integration-prs.json" \
    '{
      generatedAt: $generatedAt,
      repo: $repo,
      upstream: { remote: $upstreamRemote, branch: $upstreamBranch, sha: $upstreamSha },
      fork: { remote: $forkRemote, branch: $integrationBranch },
      composedSha: $composedSha,
      prs: $prs[0]
    }' > "$output"
}

verify_target_preserves_live_head() {
  local target_ref="$1"
  if git -C "$REPO_DIR" merge-base --is-ancestor HEAD "$target_ref"; then
    return 0
  fi

  local missing_file missing_count sha subject
  missing_file="$STATE_DIR/integration-missing-live-commits.txt"
  : > "$missing_file"
  while IFS= read -r sha; do
    [ -z "$sha" ] && continue
    # Integration mode rewrites merge topology on each compose. Merge commits
    # are expected not to be preserved by ancestry, so only guard non-merge
    # patches that would actually disappear from the recomposed fork.
    if [ "$(git -C "$REPO_DIR" rev-list --parents -n 1 "$sha" | wc -w)" -gt 2 ]; then
      continue
    fi
    subject=$(git -C "$REPO_DIR" log -1 --format=%s "$sha")
    case "$subject" in
      "Normalize integration migration numbering")
        continue
        ;;
    esac
    printf '%s %s\n' "$sha" "$subject" >> "$missing_file"
  done < <(git -C "$REPO_DIR" cherry "$target_ref" HEAD | awk '$1 == "+" { print $2 }')

  missing_count=$(awk 'END { print NR + 0 }' "$missing_file")
  if [ "$missing_count" = "0" ]; then
    rm -f "$missing_file"
    return 0
  fi

  log "ERROR: composed target $(git -C "$BUILD_DIR" rev-parse --short "$target_ref") would drop $missing_count live fork commit(s)"
  log "ERROR: refusing to continue because these patches are not represented in the composed PR set"
  while IFS= read -r line; do
    log "  missing from target: $line"
  done < "$missing_file"
  if [ "$missing_count" -gt 20 ]; then
    log "  ... see $missing_file for the full list"
  fi
  return 1
}

carry_live_head_patches() {
  local missing_file missing_count target_ref sha subject
  missing_file="$STATE_DIR/integration-missing-live-commits.txt"
  : > "$missing_file"
  target_ref=$(git -C "$BUILD_DIR" rev-parse HEAD)

  while IFS= read -r sha; do
    [ -z "$sha" ] && continue
    # Integration mode rewrites merge topology on each compose. Merge commits
    # are expected not to be preserved by ancestry, so only carry non-merge
    # patches that would actually disappear from the recomposed fork.
    if [ "$(git -C "$REPO_DIR" rev-list --parents -n 1 "$sha" | wc -w)" -gt 2 ]; then
      continue
    fi
    subject=$(git -C "$REPO_DIR" log -1 --format=%s "$sha")
    case "$subject" in
      "Normalize integration migration numbering")
        continue
        ;;
    esac
    printf '%s %s\n' "$sha" "$subject" >> "$missing_file"
  done < <(git -C "$REPO_DIR" cherry "$target_ref" HEAD | awk '$1 == "+" { print $2 }')

  missing_count=$(awk 'END { print NR + 0 }' "$missing_file")
  if [ "$missing_count" = "0" ]; then
    rm -f "$missing_file"
    return 0
  fi

  log "Integration: carrying forward $missing_count live fork patch(es) not represented by tracked PRs"
  while IFS= read -r line; do
    sha="${line%% *}"
    subject="${line#* }"
    log "Integration: cherry-picking live fork patch $(git -C "$REPO_DIR" rev-parse --short "$sha") - $subject"
    if git -C "$BUILD_DIR" \
      -c rerere.enabled=true \
      -c rerere.autoupdate=true \
      cherry-pick -x "$sha" 2>>"$LOG_FILE"; then
      continue
    fi

    if ! git -C "$BUILD_DIR" diff --name-only --diff-filter=U | grep -q .; then
      log "Integration: rerere resolved live fork patch $(git -C "$REPO_DIR" rev-parse --short "$sha"); committing recorded resolution"
      if git -C "$BUILD_DIR" cherry-pick --continue 2>>"$LOG_FILE" || git -C "$BUILD_DIR" commit --no-edit 2>>"$LOG_FILE"; then
        continue
      fi
    fi

    if try_codex_reconcile "cherry-pick" "live fork patch $(git -C "$REPO_DIR" rev-parse --short "$sha") - $subject"; then
      git -C "$BUILD_DIR" add -A
      if git -C "$BUILD_DIR" cherry-pick --continue 2>>"$LOG_FILE" || git -C "$BUILD_DIR" commit --no-edit 2>>"$LOG_FILE"; then
        continue
      fi
      log "WARN: Codex resolved live fork patch $(git -C "$REPO_DIR" rev-parse --short "$sha") files, but cherry-pick continuation failed"
    fi

    log "ERROR: live fork patch $(git -C "$REPO_DIR" rev-parse --short "$sha") conflicts with composed integration target"
    git -C "$BUILD_DIR" diff --name-only --diff-filter=U | while IFS= read -r conflict_file; do
      [ -n "$conflict_file" ] && log "  conflict: $conflict_file"
    done
    git -C "$BUILD_DIR" cherry-pick --abort 2>>"$LOG_FILE" || true
    return 1
  done < "$missing_file"

  rm -f "$missing_file"
}

push_integration_branch() {
  local old_ref lease_arg
  old_ref=$(git -C "$REPO_DIR" rev-parse --verify "$INTEGRATION_FORK_REMOTE/$INTEGRATION_BRANCH" 2>/dev/null || echo "")
  lease_arg="--force-with-lease=refs/heads/$INTEGRATION_BRANCH"
  if [ -n "$old_ref" ]; then
    lease_arg="--force-with-lease=refs/heads/$INTEGRATION_BRANCH:$old_ref"
  fi

  log "Integration: pushing composed branch to $INTEGRATION_FORK_REMOTE/$INTEGRATION_BRANCH"
  if [ -n "$GITHUB_TOKEN_FORK" ]; then
    local askpass
    local push_status
    askpass="$STATE_DIR/fork-git-askpass.sh"
    cat > "$askpass" <<'EOF'
#!/bin/sh
case "$1" in
  *Username*) printf '%s\n' x-access-token ;;
  *Password*) printf '%s\n' "$PAPERCLIP_GITHUB_TOKEN_FORK" ;;
  *) printf '\n' ;;
esac
EOF
    chmod 700 "$askpass"
    set +e
    GIT_ASKPASS="$askpass" GIT_TERMINAL_PROMPT=0 \
      PAPERCLIP_GITHUB_TOKEN_FORK="$GITHUB_TOKEN_FORK" \
      git -C "$BUILD_DIR" push "$lease_arg" "$INTEGRATION_FORK_REMOTE" "HEAD:refs/heads/$INTEGRATION_BRANCH" 2>>"$LOG_FILE"
    push_status=$?
    set -e
    rm -f "$askpass"
    return "$push_status"
  fi

  git -C "$BUILD_DIR" push "$lease_arg" "$INTEGRATION_FORK_REMOTE" "HEAD:refs/heads/$INTEGRATION_BRANCH" 2>>"$LOG_FILE"
}

prepare_integration_target() {
  local latest_upstream previous_upstream best_upstream candidate final_manifest next_base saved_codex_reconcile_active

  ensure_integration_config
  log "Integration: fetching $UPSTREAM/$UPSTREAM_BRANCH and $INTEGRATION_FORK_REMOTE/$INTEGRATION_BRANCH"
  git fetch "$UPSTREAM" "$UPSTREAM_BRANCH:refs/remotes/$UPSTREAM/$UPSTREAM_BRANCH" 2>>"$LOG_FILE"
  if ! git fetch "$INTEGRATION_FORK_REMOTE" "$INTEGRATION_BRANCH:refs/remotes/$INTEGRATION_FORK_REMOTE/$INTEGRATION_BRANCH" 2>>"$LOG_FILE"; then
    log "Integration: fork branch $INTEGRATION_FORK_REMOTE/$INTEGRATION_BRANCH does not exist yet"
  fi

  build_integration_pr_manifest
  fetch_integration_pr_refs

  latest_upstream=$(git -C "$REPO_DIR" rev-parse "$UPSTREAM/$UPSTREAM_BRANCH")
  previous_upstream=$(find_last_integrated_upstream_sha)
  rm -f "$INTEGRATION_CONFLICT_BASE_FILE" "$STATE_DIR/integration-compose-conflicts.jsonl"
  report_pr_main_conflicts "$latest_upstream"

  log "Integration: composing latest upstream $(git -C "$REPO_DIR" rev-parse --short "$latest_upstream") with $(jq 'length' "$STATE_DIR/integration-prs.json") PR(s)"
  if compose_integration_candidate "$latest_upstream"; then
    best_upstream="$latest_upstream"
  else
    saved_codex_reconcile_active="$CODEX_RECONCILE_ACTIVE"
    CODEX_RECONCILE_ACTIVE=0
    log "Integration: latest upstream did not compose after configured Codex attempts; fallback probing will use git/rerere only"
    if [ -z "$previous_upstream" ]; then
      previous_upstream=$(cat "$INTEGRATION_CONFLICT_BASE_FILE" 2>/dev/null || true)
      if [ -z "$previous_upstream" ]; then
        previous_upstream=$(find_initial_integration_base)
      fi
      if [ -z "$previous_upstream" ]; then
        log "ERROR: Integration composition failed and no previous upstream checkpoint exists"
        finalize_integration_compose_conflicts
        full_cleanup
        exit 1
      fi
      log "Integration: no prior checkpoint; using conflict PR merge-base $(git -C "$REPO_DIR" rev-parse --short "$previous_upstream")"
    fi
    log "Integration: latest upstream conflicted; advancing one upstream commit at a time from $(git -C "$REPO_DIR" rev-parse --short "$previous_upstream")"
    best_upstream=""
    while true; do
      rm -f "$INTEGRATION_CONFLICT_BASE_FILE"
      if compose_integration_candidate "$previous_upstream"; then
        best_upstream="$previous_upstream"
        break
      fi

      next_base=$(cat "$INTEGRATION_CONFLICT_BASE_FILE" 2>/dev/null || true)
      if [ -n "$next_base" ] \
        && [ "$next_base" != "$previous_upstream" ] \
        && git -C "$REPO_DIR" merge-base --is-ancestor "$previous_upstream" "$next_base"; then
        log "Integration: fallback base too old for a tracked PR; retrying from $(git -C "$REPO_DIR" rev-parse --short "$next_base")"
        previous_upstream="$next_base"
        continue
      fi

      log "ERROR: Previously integrated upstream commit no longer composes with tracked PRs"
      finalize_integration_compose_conflicts
      full_cleanup
      exit 1
    done
    while IFS= read -r candidate; do
      log "Integration: testing upstream commit $(git -C "$REPO_DIR" rev-parse --short "$candidate")"
      if compose_integration_candidate "$candidate"; then
        best_upstream="$candidate"
      else
      log "WARN: stopping integration before conflicting upstream commit $(git -C "$REPO_DIR" rev-parse --short "$candidate")"
      break
      fi
    done < <(git -C "$REPO_DIR" rev-list --reverse --first-parent "$previous_upstream..$latest_upstream")
    CODEX_RECONCILE_ACTIVE="$saved_codex_reconcile_active"

    if [ -z "$best_upstream" ]; then
      log "ERROR: Could not compose any new upstream commit with tracked PRs"
      full_cleanup
      exit 1
    fi
    compose_integration_candidate "$best_upstream"
  fi

  finalize_integration_compose_conflicts
  normalize_integration_migrations
  if ! carry_live_head_patches; then
    full_cleanup
    exit 7
  fi
  normalize_integration_migrations
  preserve_configured_fork_paths

  TARGET_REF=$(git -C "$BUILD_DIR" rev-parse HEAD)
  if ! verify_target_preserves_live_head "$TARGET_REF"; then
    finalize_integration_compose_conflicts
    full_cleanup
    exit 7
  fi
  echo "$TARGET_REF" > "$TARGET_REF_FILE"
  final_manifest="$STATE_DIR/integration-manifest.next.json"
  write_integration_manifest "$best_upstream" "$TARGET_REF" "$final_manifest"
  log "Integration: composed target $(git -C "$BUILD_DIR" rev-parse --short HEAD) at upstream $(git -C "$REPO_DIR" rev-parse --short "$best_upstream")"
}

preflight_upgrade() {
  cd "$REPO_DIR"
  if [ "$UPGRADE_MODE" != "integration" ]; then
    log "ERROR: --preflight is only supported for PAPERCLIP_UPGRADE_MODE=integration"
    exit 1
  fi

  prepare_integration_target

  log "Preflight: installing dependencies in composed worktree..."
  cd "$BUILD_DIR"
  if ! pnpm install --frozen-lockfile 2>>"$LOG_FILE"; then
    log "WARN: frozen-lockfile failed during preflight, trying regular install"
    if ! pnpm install 2>>"$LOG_FILE"; then
      log "ERROR: preflight pnpm install failed"
      full_cleanup
      exit 1
    fi
  fi

  log "Preflight: building composed worktree..."
  if ! pnpm build 2>>"$LOG_FILE"; then
    log "ERROR: preflight build failed"
    full_cleanup
    exit 1
  fi

  rm -f "$STATE_DIR/integration-manifest.next.json" "$TARGET_REF_FILE"
  full_cleanup
  log "Preflight complete: composed target builds and preserves live HEAD; no push, quiesce, or swap was performed"
}

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
  # Use env var if set
  if [ -n "${PAPERCLIP_COMPANY_ID:-}" ]; then
    echo "$PAPERCLIP_COMPANY_ID" | tee "$COMPANY_ID_FILE" > /dev/null
    echo "$PAPERCLIP_COMPANY_ID"
    return
  fi
  # Use persisted value from a prior run (survives mid-swap crash when API is down)
  if [ -f "$COMPANY_ID_FILE" ]; then
    cat "$COMPANY_ID_FILE"
    return
  fi
  # Fall back to API auto-detect (fresh upgrade only)
  local detected
  detected=$(api_curl "$API_URL/api/companies" 2>/dev/null | jq -r '.[0].id // empty' 2>/dev/null || echo "")
  if [ -z "$detected" ]; then
    log "ERROR: Could not auto-detect company ID. Set PAPERCLIP_COMPANY_ID or ensure the server is running."
    exit 1
  fi
  echo "$detected" > "$COMPANY_ID_FILE"
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
# Saves per-agent full runtimeConfig (including the complete heartbeat object
# with intervalSec, maxConcurrentRuns, etc.) before quiescing, then restores
# each agent to its exact prior state afterward. Agents that had heartbeats
# disabled before the upgrade stay disabled.
#
# The full runtimeConfig is saved (not just the heartbeat sub-object) because
# the PATCH API replaces the entire runtimeConfig column — sending only
# {runtimeConfig: {heartbeat: ...}} would wipe other runtimeConfig keys such
# as env, model, and command.  Saving the full object also ensures intervalSec
# is always captured even when the stored heartbeat object is sparse.
# ---------------------------------------------------------------------------

save_heartbeat_state() {
  log "Saving current agent runtimeConfig state (full runtimeConfig including heartbeat.intervalSec)..."
  local state
  state=$(api_curl "$API_URL/api/companies/$COMPANY_ID/agents" 2>/dev/null \
    | jq '[.[] | {id: .id, name: .name, runtimeConfig: .runtimeConfig, heartbeat: (.runtimeConfig.heartbeat // {})}]' \
    2>/dev/null) || state="[]"
  if [ -z "$state" ] || [ "$state" = "null" ]; then
    log "WARN: Could not fetch agent state — defaulting to empty list (no agents will be quiesced)"
    state="[]"
  fi
  echo "$state" > "$HEARTBEAT_STATE_FILE"
}

quiesce_agents() {
  local agent_id
  log "Quiescing all agents (disabling heartbeats and on-demand wakes only)..."
  for agent_id in $(jq -r '.[] | select(.heartbeat.enabled == true or .heartbeat.wakeOnDemand == true) | .id' "$HEARTBEAT_STATE_FILE"); do
    local agent_name saved_rc saved_hb quiesced_hb quiesced_rc
    agent_name=$(jq -r --arg id "$agent_id" '.[] | select(.id == $id) | .name' "$HEARTBEAT_STATE_FILE")
    # Patch the full runtimeConfig with only enabled+wakeOnDemand overridden so
    # intervalSec, maxConcurrentRuns, and all other runtimeConfig keys survive.
    saved_rc=$(jq -c --arg id "$agent_id" '.[] | select(.id == $id) | .runtimeConfig // {}' "$HEARTBEAT_STATE_FILE")
    saved_hb=$(jq -c --arg id "$agent_id" '.[] | select(.id == $id) | .heartbeat' "$HEARTBEAT_STATE_FILE")
    quiesced_hb=$(echo "$saved_hb" | jq -c '. + {enabled: false, wakeOnDemand: false}')
    quiesced_rc=$(echo "$saved_rc" | jq -c --argjson hb "$quiesced_hb" '. + {heartbeat: $hb}')
    api_curl -X PATCH "$API_URL/api/agents/$agent_id" \
      -H "Content-Type: application/json" \
      -d "{\"runtimeConfig\": $quiesced_rc}" > /dev/null 2>&1 \
      && log "  Quiesced: $agent_name" \
      || log "  WARN: Failed to quiesce: $agent_name"
  done
}

restore_heartbeats() {
  local agent_id
  if [ ! -f "$HEARTBEAT_STATE_FILE" ]; then
    log "WARN: No heartbeat state file found, cannot restore"
    return
  fi
  log "Restoring full agent runtimeConfig (including heartbeat.intervalSec)..."
  for agent_id in $(jq -r '.[] | select(.heartbeat.enabled == true or .heartbeat.wakeOnDemand == true) | .id' "$HEARTBEAT_STATE_FILE"); do
    local agent_name saved_rc
    agent_name=$(jq -r --arg id "$agent_id" '.[] | select(.id == $id) | .name' "$HEARTBEAT_STATE_FILE")
    saved_rc=$(jq -c --arg id "$agent_id" '.[] | select(.id == $id) | .runtimeConfig // {}' "$HEARTBEAT_STATE_FILE")
    api_curl -X PATCH "$API_URL/api/agents/$agent_id" \
      -H "Content-Type: application/json" \
      -d "{\"runtimeConfig\": $saved_rc}" > /dev/null 2>&1 \
      && log "  Restored: $agent_name" \
      || log "  WARN: Failed to restore: $agent_name"
  done
}

full_cleanup() {
  # Preserve company-id across cleanup — needed for crash recovery when the
  # API is down mid-swap. It is refreshed on every fresh upgrade start.
  local saved_company_id=""
  local saved_integration_manifest=""
  local saved_main_conflicts=""
  local saved_compose_conflicts=""
  [ -f "$COMPANY_ID_FILE" ] && saved_company_id=$(cat "$COMPANY_ID_FILE")
  [ -f "$INTEGRATION_MANIFEST_FILE" ] && saved_integration_manifest=$(cat "$INTEGRATION_MANIFEST_FILE")
  [ -f "$INTEGRATION_MAIN_CONFLICTS_FILE" ] && saved_main_conflicts=$(cat "$INTEGRATION_MAIN_CONFLICTS_FILE")
  [ -f "$INTEGRATION_COMPOSE_CONFLICTS_FILE" ] && saved_compose_conflicts=$(cat "$INTEGRATION_COMPOSE_CONFLICTS_FILE")
  rm -rf "$STATE_DIR"
  mkdir -p "$STATE_DIR"
  [ -n "$saved_company_id" ] && echo "$saved_company_id" > "$COMPANY_ID_FILE"
  [ -n "$saved_integration_manifest" ] && echo "$saved_integration_manifest" > "$INTEGRATION_MANIFEST_FILE"
  [ -n "$saved_main_conflicts" ] && echo "$saved_main_conflicts" > "$INTEGRATION_MAIN_CONFLICTS_FILE"
  [ -n "$saved_compose_conflicts" ] && echo "$saved_compose_conflicts" > "$INTEGRATION_COMPOSE_CONFLICTS_FILE"
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
    if [ "${FORCE_DRAIN:-0}" = "1" ]; then
      log "WARN: Could not check live runs — proceeding anyway (--force-drain active)"
      rm -f "$DRAIN_START_FILE"
      return 0
    fi
    log "WARN: Could not check live runs — treating as not drained (use --force-drain to override)"
    return 1
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
# Health-check helper: polls API until server responds or attempts exhausted.
# Returns 0 if healthy, 1 if not healthy within timeout.
# ---------------------------------------------------------------------------

wait_for_server_healthy() {
  local server_up=false
  for i in $(seq 1 24); do
    sleep 5
    if api_curl "$API_URL/api/companies" > /dev/null 2>&1; then
      server_up=true
      break
    fi
    log "Waiting for server... (attempt $i/24)"
  done
  [ "$server_up" = true ]
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
  # Re-protect any uncommitted local changes before the hard reset so operator
  # customizations (skill patches, config overrides) popped from stash earlier
  # in the swap phase are not permanently lost.
  local wt_changes
  wt_changes=$(git status --porcelain 2>/dev/null | head -1)
  if [ -n "$wt_changes" ]; then
    log "WARN: Stashing uncommitted changes before rollback to prevent data loss"
    git stash push -m "paperclip-rollback-$(date +%s)" 2>>"$LOG_FILE" || true
  fi
  git reset --hard "$ref"
  if ! pnpm install --frozen-lockfile 2>>"$LOG_FILE"; then
    log "WARN: frozen-lockfile failed during rollback; regular install may update pnpm-lock.yaml"
    pnpm install 2>>"$LOG_FILE" || log "WARN: pnpm install failed during rollback"
  fi
  if ! pnpm build 2>>"$LOG_FILE"; then
    log "WARN: pnpm build failed during rollback — server may not start"
  fi
  systemctl --user restart "$SERVICE_NAME" 2>>"$LOG_FILE" || true
  if wait_for_server_healthy; then
    restore_heartbeats
    full_cleanup
    log "Rollback complete"
  else
    full_cleanup
    log "ERROR: Rollback complete but server not healthy after $(( 24 * 5 ))s — agents left drained. Investigate manually."
    exit 5
  fi
}

# ---------------------------------------------------------------------------
# Handle special flags
# ---------------------------------------------------------------------------

FORCE_RESTORE=0
[ "${1:-}" = "--force-restore" ] && FORCE_RESTORE=1

case "${1:-}" in
  --restore|--force-restore)
    if [ -f "$LOCK_FILE" ]; then
      _lock_pid=$(head -1 "$LOCK_FILE" 2>/dev/null || echo "")
      _lock_starttime=$(sed -n '2p' "$LOCK_FILE" 2>/dev/null || echo "")
      if [ -n "$_lock_pid" ] && kill -0 "$_lock_pid" 2>/dev/null; then
        _current_starttime=$(pid_start_time "$_lock_pid")
        if [ -n "$_lock_starttime" ] && [ -n "$_current_starttime" ] && [ "$_lock_starttime" = "$_current_starttime" ]; then
          if [ "$FORCE_RESTORE" = "1" ]; then
            log "WARN: --force-restore bypassing active upgrade lock held by PID $_lock_pid"
          else
            log "ERROR: --restore refused — active upgrade is running (PID $_lock_pid). Kill it first or use --force-restore to override."
            exit 6
          fi
        fi
      fi
    fi
    log "Manual restore requested"
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
    if [ -f "$LOCK_FILE" ]; then
      echo "Lock PID: $(head -1 "$LOCK_FILE" 2>/dev/null || echo "")"
      echo "Lock start time: $(sed -n '2p' "$LOCK_FILE" 2>/dev/null || echo "")"
    fi
    [ -f "$TARGET_REF_FILE" ] && echo "Target ref: $(cat "$TARGET_REF_FILE")"
    if [ -f "$INTEGRATION_MANIFEST_FILE" ]; then
      echo "Integration manifest: $INTEGRATION_MANIFEST_FILE"
      jq -r '"Integration upstream: \(.upstream.sha)\nIntegration PRs: \([.prs[].number] | join(", "))"' "$INTEGRATION_MANIFEST_FILE" 2>/dev/null || true
    fi
    if [ -f "$INTEGRATION_MAIN_CONFLICTS_FILE" ]; then
      echo "Integration main conflicts: $INTEGRATION_MAIN_CONFLICTS_FILE"
      jq -r '"Integration main conflict PRs: \([.[].number] | join(", "))"' "$INTEGRATION_MAIN_CONFLICTS_FILE" 2>/dev/null || true
    fi
    if [ -f "$INTEGRATION_COMPOSE_CONFLICTS_FILE" ]; then
      echo "Integration compose conflicts: $INTEGRATION_COMPOSE_CONFLICTS_FILE"
      jq -r '"Integration compose conflict PRs: \([.[].number] | join(", "))"' "$INTEGRATION_COMPOSE_CONFLICTS_FILE" 2>/dev/null || true
    fi
    [ -d "$BUILD_DIR" ] && echo "Build dir: exists ($(git -C "$BUILD_DIR" rev-parse --short HEAD 2>/dev/null || echo 'unknown'))"
    exit 0
    ;;
  --preflight)
    acquire_lock
    preflight_upgrade
    exit 0
    ;;
esac

MODE="resume"
FORCE_DRAIN=0
[ "${1:-}" = "--start" ] && MODE="start"
[ "${1:-}" = "--force-drain" ] && FORCE_DRAIN=1

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

  LOCAL=$(git rev-parse HEAD)
  echo "$LOCAL" > "$ROLLBACK_REF_FILE"
  set_phase "building"

  if [ "$UPGRADE_MODE" = "integration" ]; then
    prepare_integration_target
    REMOTE=$(cat "$TARGET_REF_FILE")
  else
    log "Fetching $UPSTREAM..."
    git fetch "$UPSTREAM"
    REMOTE=$(git rev-parse "$UPSTREAM/$UPSTREAM_BRANCH")
    echo "$REMOTE" > "$TARGET_REF_FILE"

    if [ -d "$BUILD_DIR" ]; then
      git worktree remove --force "$BUILD_DIR" 2>/dev/null || rm -rf "$BUILD_DIR"
    fi
    log "Creating build worktree at $UPSTREAM/$UPSTREAM_BRANCH..."
    git worktree add --detach "$BUILD_DIR" "$REMOTE" 2>>"$LOG_FILE"
  fi

  if [ "$LOCAL" = "$REMOTE" ]; then
    log "Already up to date at $(git rev-parse --short HEAD)"
    full_cleanup
    exit 2
  fi

  # If HEAD already contains the target (ahead-only, no new target commits),
  # there is nothing to pull. Preserve local commits untouched.
  if git merge-base --is-ancestor "$REMOTE" HEAD; then
    log "Already up to date with target $(git rev-parse --short "$REMOTE") (HEAD is ahead-only at $(git rev-parse --short HEAD))"
    full_cleanup
    exit 2
  fi

  log "Update available: $(git rev-parse --short HEAD) -> $(git rev-parse --short "$REMOTE")"

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

  if [ "$UPGRADE_MODE" = "integration" ]; then
    if ! push_integration_branch; then
      log "ERROR: Failed to push integration branch"
      full_cleanup
      exit 1
    fi
    mv "$STATE_DIR/integration-manifest.next.json" "$INTEGRATION_MANIFEST_FILE"
  fi

  log "Build complete in worktree — server was not touched"
  set_phase "built"
  phase="built"
fi

# ---------------------------------------------------------------------------
# Phase: quiesce + drain (brief disruption starts here)
# ---------------------------------------------------------------------------

if [ "$phase" = "built" ]; then
  # Only save if no snapshot exists yet — guards against a crash between
  # quiesce_agents and set_phase "quiescing" re-overwriting the snapshot
  # with the already-quiesced state, which would permanently disable agents.
  if [ ! -f "$HEARTBEAT_STATE_FILE" ]; then
    save_heartbeat_state
  fi
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
# 2. Stash any local changes, including untracked files (e.g. local migration drafts)
# 3. Advance the live repo to the target
# 4. Re-apply stashed changes
# 5. pnpm install on live repo (fast — packages cached from worktree build)
# 6. Start the server and health-check
# ---------------------------------------------------------------------------

if [ "$phase" = "swapping" ]; then
  cd "$REPO_DIR"
  TARGET_REF=$(cat "$TARGET_REF_FILE" 2>/dev/null || git rev-parse "$UPSTREAM/$UPSTREAM_BRANCH")

  log "Stopping Paperclip..."
  systemctl --user stop "$SERVICE_NAME" 2>>"$LOG_FILE" || true
  sleep 2

  local_changes=$(git status --porcelain 2>/dev/null | head -1)
  if [ -n "$local_changes" ]; then
    log "Stashing local changes in live repo..."
    git stash push -u -m "paperclip-upgrade-$(date +%s)" 2>>"$LOG_FILE"
    echo "stashed" > "$STATE_DIR/stash-flag"
  fi

  log "Advancing live repo to target $(git rev-parse --short "$TARGET_REF")..."
  # Three cases:
  #   1. HEAD is ancestor of target  → fast-forward
  #   2. Target is ancestor of HEAD  → shouldn't reach here (caught in build phase)
  #   3. Diverged                    → rebase local commits on top of target
  if git merge-base --is-ancestor HEAD "$TARGET_REF"; then
    if ! git merge "$TARGET_REF" --ff-only 2>>"$LOG_FILE"; then
      log "ERROR: Fast-forward failed on live repo"
      systemctl --user start "$SERVICE_NAME" 2>>"$LOG_FILE" || true
      [ -f "$STATE_DIR/stash-flag" ] && { git stash pop 2>>"$LOG_FILE" || true; rm -f "$STATE_DIR/stash-flag"; }
      restore_heartbeats
      full_cleanup
      exit 1
    fi
  elif [ "$UPGRADE_MODE" = "integration" ]; then
    backup_ref="refs/paperclip-upgrade/live-backups/$(date +%Y%m%d%H%M%S)"
    git update-ref "$backup_ref" HEAD
    log "Live repo diverged from composed integration target; saved old HEAD at $backup_ref and resetting to target"
    if ! git reset --hard "$TARGET_REF" 2>>"$LOG_FILE"; then
      log "ERROR: Reset to integration target failed"
      systemctl --user start "$SERVICE_NAME" 2>>"$LOG_FILE" || true
      [ -f "$STATE_DIR/stash-flag" ] && { git stash pop 2>>"$LOG_FILE" || true; rm -f "$STATE_DIR/stash-flag"; }
      restore_heartbeats
      full_cleanup
      exit 1
    fi
  else
    log "Live repo has local commits diverged from target — rebasing local commits on top"
    if ! git rebase "$TARGET_REF" 2>>"$LOG_FILE"; then
      log "ERROR: Rebase conflicts on live repo — aborting rebase and rolling back"
      git rebase --abort 2>>"$LOG_FILE" || true
      systemctl --user start "$SERVICE_NAME" 2>>"$LOG_FILE" || true
      [ -f "$STATE_DIR/stash-flag" ] && { git stash pop 2>>"$LOG_FILE" || true; rm -f "$STATE_DIR/stash-flag"; }
      restore_heartbeats
      full_cleanup
      exit 1
    fi
    log "Rebase complete. New HEAD: $(git rev-parse --short HEAD)"
  fi

  if [ -f "$STATE_DIR/stash-flag" ]; then
    log "Re-applying local changes..."
    git stash pop 2>>"$LOG_FILE" || log "WARN: Stash pop had conflicts — check manually"
    rm -f "$STATE_DIR/stash-flag"
  fi

  log "Installing dependencies on live repo..."
  if ! pnpm install --frozen-lockfile 2>>"$LOG_FILE"; then
    log "WARN: frozen-lockfile failed on live repo; regular install may update pnpm-lock.yaml"
    if ! pnpm install 2>>"$LOG_FILE"; then
      log "ERROR: pnpm install failed on live repo"
      rollback
      exit 1
    fi
  fi

  log "Building artifacts in live repo..."
  if ! pnpm build 2>>"$LOG_FILE"; then
    log "ERROR: Build failed in live repo — rolling back to previous commit"
    rollback
    exit 1
  fi

  if [ "$UPGRADE_MODE" != "integration" ] && [ -n "$ORIGIN" ]; then
    log "Pushing to $ORIGIN..."
    git push "$ORIGIN" "$UPSTREAM_BRANCH" 2>>"$LOG_FILE" || log "WARN: Push to $ORIGIN failed (non-fatal)"
  fi

  log "Starting Paperclip..."
  if ! systemctl --user start "$SERVICE_NAME" 2>>"$LOG_FILE"; then
    log "ERROR: systemctl start failed — rolling back immediately"
    rollback
    exit 1
  fi

  if ! wait_for_server_healthy; then
    log "ERROR: Server not responding — rolling back"
    rollback
    exit 1
  fi

  restore_heartbeats
  full_cleanup
  log "Upgrade complete. Server healthy at $(git -C "$REPO_DIR" rev-parse --short HEAD)"
  exit 0
fi
