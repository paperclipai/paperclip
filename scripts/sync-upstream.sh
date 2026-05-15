#!/usr/bin/env bash
# Syncs local fork master with upstream/master.
# Fast-forward: merges directly and pushes to private and public fork remotes.
# Non-FF: opens chore/sync-YYYYMMDD branch.
# By default, brings local feature branches forward after master is current.
# Posts result as a comment on the Paperclip issue ($PAPERCLIP_TASK_ID).

set -euo pipefail

REPO_ROOT="${PAPERCLIP_SYNC_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

# Load .env from repo root if present (does not override existing env vars)
if [[ -f "${REPO_ROOT}/.env" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ -z "${line// }" ]] && continue
    key="${line%%=*}"
    [[ -z "${!key+x}" ]] && export "$line"
  done < "${REPO_ROOT}/.env"
fi
DATE="$(date +%Y%m%d)"
BRANCH="chore/sync-${DATE}"
UPSTREAM_REMOTE="${UPSTREAM_REMOTE:-upstream}"
PRIVATE_REMOTE="${PRIVATE_REMOTE:-${ORIGIN_REMOTE:-origin}}"
PUBLIC_REMOTE="${PUBLIC_REMOTE:-github-fork}"
ORIGIN_REMOTE="$PRIVATE_REMOTE"
UPSTREAM_REF="${UPSTREAM_REF:-${UPSTREAM_REMOTE}/master}"
LOCAL_REF="${LOCAL_REF:-master}"
SYNC_FEATURES_SPEC="${SYNC_FEATURES:-all}"
SYNC_FEATURES_EXPLICIT="0"
EXCLUDE_FEATURES_SPEC="${EXCLUDE_FEATURES:-}"
FEATURE_MODE="${SYNC_FEATURE_MODE:-rebase}"
PUSH_FEATURES="${SYNC_PUSH_FEATURES:-1}"
PUSH_PRIVATE="${SYNC_PUSH_PRIVATE:-1}"
PUSH_PUBLIC="${SYNC_PUSH_PUBLIC:-1}"
AUTO_STASH="${SYNC_AUTO_STASH:-0}"
EXCLUDED_FEATURES_FILE=""

log() { echo "[sync-upstream] $*"; }
die() { log "ERROR: $*"; exit 1; }

usage() {
  cat <<'EOF'
Usage: scripts/sync-upstream.sh [options]

Sync master with upstream/master. By default, local feature branches are rebased
onto master after master is current, then pushed with --force-with-lease.

Default remotes:
  upstream     canonical upstream repository
  origin       private fork remote
  github-fork  public fork remote

Options:
  --private-remote remote
      Private fork remote to push the base branch to. Default: origin.

  --public-remote remote
      Public fork remote to push the base branch to. Default: github-fork.

  --no-push-private
      Do not push the synced base branch or sync branch to the private remote.

  --no-push-public
      Do not push the synced base branch or sync branch to the public remote.

  --sync-features [all|branch[,branch...]]
      Update selected local feature branches after master is current.
      This is enabled by default with "all".

  --feature-branches branch[,branch...]
      Alias for --sync-features with an explicit branch list. Explicitly listed
      branches are tried even if a previous auto-run excluded them after conflict.

  --no-sync-features
      Only sync master; do not update feature branches.

  --exclude-features branch[,branch...]
      Skip specific branches during this run.

  --feature-mode merge|rebase
      How to bring feature branches forward. Default: rebase.

  --push-features
      Push updated feature branches. This is the default.
      Rebase mode uses --force-with-lease.

  --no-push-features
      Do not push updated feature branches.

  --auto-stash
      Automatically stash uncommitted changes before syncing and restore them
      afterwards. Without this flag, the script aborts if the working tree is dirty.

  --local-ref branch
      Local base branch to sync. Default: master.

  --upstream-ref ref
      Upstream ref to merge into the local base. Default: upstream/master.

  -h, --help
      Show this help.

Examples:
  scripts/sync-upstream.sh
  scripts/sync-upstream.sh --no-sync-features
  scripts/sync-upstream.sh --private-remote origin --public-remote github-fork
  scripts/sync-upstream.sh --no-push-public
  scripts/sync-upstream.sh --exclude-features feat/a,tik-1300-fix
  scripts/sync-upstream.sh --feature-branches feat/a,tik-1300-fix
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --private-remote)
      [[ $# -gt 1 ]] || die "--private-remote requires a remote name"
      PRIVATE_REMOTE="$2"
      ORIGIN_REMOTE="$PRIVATE_REMOTE"
      shift 2
      ;;
    --public-remote)
      [[ $# -gt 1 ]] || die "--public-remote requires a remote name"
      PUBLIC_REMOTE="$2"
      shift 2
      ;;
    --no-push-private)
      PUSH_PRIVATE="0"
      shift
      ;;
    --no-push-public)
      PUSH_PUBLIC="0"
      shift
      ;;
    --sync-features)
      if [[ $# -gt 1 && "${2:-}" != --* ]]; then
        SYNC_FEATURES_SPEC="$2"
        [[ "$2" == "all" ]] || SYNC_FEATURES_EXPLICIT="1"
        shift 2
      else
        SYNC_FEATURES_SPEC="all"
        shift
      fi
      ;;
    --feature-branches)
      [[ $# -gt 1 ]] || die "--feature-branches requires a branch list"
      SYNC_FEATURES_SPEC="$2"
      SYNC_FEATURES_EXPLICIT="1"
      shift 2
      ;;
    --no-sync-features)
      SYNC_FEATURES_SPEC=""
      shift
      ;;
    --exclude-features)
      [[ $# -gt 1 ]] || die "--exclude-features requires a branch list"
      EXCLUDE_FEATURES_SPEC="$2"
      shift 2
      ;;
    --feature-mode)
      [[ $# -gt 1 ]] || die "--feature-mode requires merge or rebase"
      FEATURE_MODE="$2"
      shift 2
      ;;
    --push-features)
      PUSH_FEATURES="1"
      shift
      ;;
    --no-push-features)
      PUSH_FEATURES="0"
      shift
      ;;
    --auto-stash)
      AUTO_STASH="1"
      shift
      ;;
    --local-ref)
      [[ $# -gt 1 ]] || die "--local-ref requires a branch name"
      LOCAL_REF="$2"
      shift 2
      ;;
    --upstream-ref)
      [[ $# -gt 1 ]] || die "--upstream-ref requires a ref"
      UPSTREAM_REF="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "Unknown option: $1"
      ;;
  esac
done

[[ "$FEATURE_MODE" == "merge" || "$FEATURE_MODE" == "rebase" ]] || die "--feature-mode must be merge or rebase"

# Paperclip comment helper (requires PAPERCLIP_* env vars)
post_comment() {
  local issue_id="${PAPERCLIP_TASK_ID:-}"
  local api_url="${PAPERCLIP_API_URL:-}"
  local api_key="${PAPERCLIP_API_KEY:-}"
  local run_id="${PAPERCLIP_RUN_ID:-}"
  local body="$1"

  [[ -z "$issue_id" || -z "$api_url" || -z "$api_key" ]] && { log "Skipping comment — PAPERCLIP env vars not set"; return 0; }

  local headers=(-H "Authorization: Bearer $api_key" -H "Content-Type: application/json")
  [[ -n "$run_id" ]] && headers+=(-H "X-Paperclip-Run-Id: $run_id")

  local payload
  payload="$(jq -n --arg body "$body" '{"body": $body}')"
  curl -s -o /dev/null -w "%{http_code}" -X POST "${api_url}/api/issues/${issue_id}/comments" \
    "${headers[@]}" -d "$payload" | grep -q "^2" || log "Warning: comment post may have failed"
}

update_issue() {
  local issue_id="${PAPERCLIP_TASK_ID:-}"
  local api_url="${PAPERCLIP_API_URL:-}"
  local api_key="${PAPERCLIP_API_KEY:-}"
  local run_id="${PAPERCLIP_RUN_ID:-}"
  local status="$1"
  local comment="$2"

  [[ -z "$issue_id" || -z "$api_url" || -z "$api_key" ]] && { log "Skipping issue update — PAPERCLIP env vars not set"; return 0; }

  local headers=(-H "Authorization: Bearer $api_key" -H "Content-Type: application/json")
  [[ -n "$run_id" ]] && headers+=(-H "X-Paperclip-Run-Id: $run_id")

  local payload
  payload="$(jq -n --arg status "$status" --arg comment "$comment" '{"status": $status, "comment": $comment}')"
  local http_code
  http_code="$(curl -s -o /dev/null -w "%{http_code}" -X PATCH "${api_url}/api/issues/${issue_id}" \
    "${headers[@]}" -d "$payload")"
  [[ "$http_code" =~ ^2 ]] || log "Warning: issue update returned HTTP $http_code"
}

ensure_clean_worktree() {
  git diff --quiet || die "Working tree has unstaged changes; commit or stash before syncing. To stash automatically, pass --auto-stash."
  git diff --cached --quiet || die "Index has staged changes; commit or stash before syncing. To stash automatically, pass --auto-stash."
}

remote_exists() {
  local remote="$1"
  [[ -n "$remote" ]] || return 1
  git remote get-url "$remote" >/dev/null 2>&1
}

fetch_remote() {
  local remote="$1"
  remote_exists "$remote" || die "Git remote not found: $remote"
  git fetch "$remote" 2>&1
}

push_branch_to_forks() {
  local source_ref="$1"
  local target_ref="$2"
  local remote candidate pushed_any pushed_remotes
  local -a remotes=()
  pushed_any="0"
  pushed_remotes=""

  if [[ "$PUSH_PRIVATE" == "1" ]]; then
    remote_exists "$PRIVATE_REMOTE" || die "Private remote not found: $PRIVATE_REMOTE"
    remotes+=("$PRIVATE_REMOTE")
  fi

  if [[ "$PUSH_PUBLIC" == "1" ]]; then
    remote_exists "$PUBLIC_REMOTE" || die "Public remote not found: $PUBLIC_REMOTE"
    remotes+=("$PUBLIC_REMOTE")
  fi

  for candidate in "${remotes[@]+"${remotes[@]}"}"; do
    [[ -n "$candidate" ]] || continue
    if [[ ",${pushed_remotes}," == *",${candidate},"* ]]; then
      continue
    fi
    remote="$candidate"
    log "Pushing ${source_ref}:${target_ref} to ${remote}..."
    git push "$remote" "${source_ref}:${target_ref}" 2>&1
    pushed_any="1"
    pushed_remotes="${pushed_remotes:+${pushed_remotes},}${remote}"
  done

  [[ "$pushed_any" == "1" ]] || log "No fork remotes selected for push."
}

list_contains() {
  local needle="$1"
  local list="$2"
  printf '%s\n' "$list" | tr ',' '\n' | awk 'NF { print $0 }' | grep -Fxq "$needle"
}

is_feature_excluded() {
  local branch="$1"

  if [[ -n "$EXCLUDE_FEATURES_SPEC" ]] && list_contains "$branch" "$EXCLUDE_FEATURES_SPEC"; then
    return 0
  fi

  if [[ "$SYNC_FEATURES_EXPLICIT" != "1" && -f "$EXCLUDED_FEATURES_FILE" ]] && grep -Fxq "$branch" "$EXCLUDED_FEATURES_FILE"; then
    return 0
  fi

  return 1
}

mark_feature_excluded() {
  local branch="$1"
  [[ -n "$EXCLUDED_FEATURES_FILE" ]] || return 0
  touch "$EXCLUDED_FEATURES_FILE"
  grep -Fxq "$branch" "$EXCLUDED_FEATURES_FILE" || printf '%s\n' "$branch" >> "$EXCLUDED_FEATURES_FILE"
}

clear_feature_excluded() {
  local branch="$1"
  local tmp
  [[ -n "$EXCLUDED_FEATURES_FILE" && -f "$EXCLUDED_FEATURES_FILE" ]] || return 0
  tmp="$(mktemp)"
  grep -Fxv "$branch" "$EXCLUDED_FEATURES_FILE" > "$tmp" || true
  mv "$tmp" "$EXCLUDED_FEATURES_FILE"
}

feature_branches() {
  if [[ -z "$SYNC_FEATURES_SPEC" ]]; then
    return 0
  fi

  if [[ "$SYNC_FEATURES_SPEC" == "all" ]]; then
    local branch
    git for-each-ref --format='%(refname:short)' refs/heads | while read -r branch; do
      [[ -n "$branch" ]] || continue
      [[ "$branch" != "$LOCAL_REF" ]] || continue
      [[ ! "$branch" =~ ^chore/sync-[0-9]{8}$ ]] || continue
      is_feature_excluded "$branch" && continue
      printf '%s\n' "$branch"
    done
    return 0
  fi

  printf '%s\n' "$SYNC_FEATURES_SPEC" | tr ',' '\n' | awk 'NF { print $0 }' | while read -r branch; do
    [[ -n "$branch" ]] || continue
    if [[ -n "$EXCLUDE_FEATURES_SPEC" ]] && list_contains "$branch" "$EXCLUDE_FEATURES_SPEC"; then
      continue
    fi
    printf '%s\n' "$branch"
  done
}

push_feature_branch() {
  local branch="$1"
  local upstream_ref remote remote_branch
  upstream_ref="$(git rev-parse --abbrev-ref "${branch}@{upstream}" 2>/dev/null || true)"

  if [[ -n "$upstream_ref" ]]; then
    remote="${upstream_ref%%/*}"
    remote_branch="${upstream_ref#*/}"
    if [[ "$remote_branch" == "$LOCAL_REF" && "$branch" != "$LOCAL_REF" ]]; then
      remote="$ORIGIN_REMOTE"
      remote_branch="$branch"
    fi
    if [[ "$FEATURE_MODE" == "rebase" ]]; then
      git push --force-with-lease "$remote" "HEAD:${remote_branch}" 2>&1
    else
      git push "$remote" "HEAD:${remote_branch}" 2>&1
    fi
  else
    if [[ "$FEATURE_MODE" == "rebase" ]]; then
      git push --force-with-lease -u "$ORIGIN_REMOTE" "HEAD:${branch}" 2>&1
    else
      git push -u "$ORIGIN_REMOTE" "$branch" 2>&1
    fi
  fi
}

sync_feature_branches() {
  local base_ref="$1"
  local original_branch="$2"
  local branch before after merge_output conflicts push_output updated_count skipped_count failed_count summary
  updated_count=0
  skipped_count=0
  failed_count=0
  summary=""

  local branches=()
  while IFS= read -r branch; do
    branches+=("$branch")
  done < <(feature_branches)
  if [[ "${#branches[@]}" -eq 0 ]]; then
    FEATURE_SUMMARY="No eligible feature branches to sync."
    log "$FEATURE_SUMMARY"
    return 0
  fi

  log "Syncing ${#branches[@]} feature branch(es) onto $base_ref with $FEATURE_MODE..."

  for branch in "${branches[@]}"; do
    git show-ref --verify --quiet "refs/heads/${branch}" || die "Feature branch not found locally: $branch"
    [[ "$branch" != "$LOCAL_REF" ]] || die "Refusing to sync base branch as a feature branch: $branch"

    log "Updating feature branch $branch..."
    git checkout "$branch" 2>&1
    before="$(git rev-parse --short HEAD)"

    if git merge-base --is-ancestor "$base_ref" "$branch"; then
      clear_feature_excluded "$branch"
      skipped_count=$((skipped_count + 1))
      summary+="\n- ${branch}: already contains ${base_ref} (${before})"
      continue
    fi

    set +e
    if [[ "$FEATURE_MODE" == "rebase" ]]; then
      merge_output="$(git rebase "$base_ref" 2>&1)"
    else
      merge_output="$(git merge --no-edit "$base_ref" 2>&1)"
    fi
    local result=$?
    set -e

    if [[ "$result" -ne 0 ]]; then
      conflicts="$(git diff --name-only --diff-filter=U 2>/dev/null | head -20 || true)"
      if [[ "$FEATURE_MODE" == "rebase" ]]; then
        git rebase --abort 2>/dev/null || true
      else
        git merge --abort 2>/dev/null || true
      fi
      mark_feature_excluded "$branch"
      failed_count=$((failed_count + 1))
      summary+="\n- ${branch}: conflict/problem; aborted and marked excluded for future auto-runs"
      summary+="\n  Conflicts: ${conflicts:-none reported}"
      summary+="\n  Retry explicitly with --feature-branches ${branch} after resolving or when you want to force another attempt."
      continue
    fi

    after="$(git rev-parse --short HEAD)"
    clear_feature_excluded "$branch"
    updated_count=$((updated_count + 1))
    summary+="\n- ${branch}: ${before} -> ${after}"

    if [[ "$PUSH_FEATURES" == "1" ]]; then
      log "Pushing feature branch $branch..."
      set +e
      push_output="$(push_feature_branch "$branch" 2>&1)"
      local push_result=$?
      set -e

      if [[ "$push_result" -ne 0 ]]; then
        mark_feature_excluded "$branch"
        failed_count=$((failed_count + 1))
        summary+="\n- ${branch}: rebased locally, but push failed; marked excluded for future auto-runs"
        summary+="\n  Push output: ${push_output:-none}"
        summary+="\n  Retry explicitly with --feature-branches ${branch} after checking the remote."
        continue
      fi

      summary+=" (pushed)"
    fi
  done

  [[ -n "$original_branch" ]] && git checkout "$original_branch" 2>&1 || true

  FEATURE_SUMMARY="$(printf 'Feature branches updated: %s, already current: %s, excluded after problems: %s.%b' "$updated_count" "$skipped_count" "$failed_count" "$summary")"
  log "$FEATURE_SUMMARY"
}

cd "$REPO_ROOT"

STASH_REF=""
if [[ "$AUTO_STASH" == "1" ]]; then
  if ! git diff --quiet || ! git diff --cached --quiet; then
    log "Auto-stashing uncommitted changes..."
    STASH_REF="$(git stash create 'sync-upstream auto-stash')"
    git stash store -m 'sync-upstream auto-stash' "$STASH_REF"
    git restore --staged . 2>/dev/null || true
    git checkout -- . 2>/dev/null || true
  fi
fi

ensure_clean_worktree
ORIGINAL_BRANCH="$(git branch --show-current || true)"
EXCLUDED_FEATURES_FILE="$(git rev-parse --git-path paperclip-sync-excluded-features)"

log "Fetching remotes..."
fetch_remote "$UPSTREAM_REMOTE"
fetch_remote "$PRIVATE_REMOTE"
if [[ "$PUBLIC_REMOTE" != "$PRIVATE_REMOTE" ]]; then
  fetch_remote "$PUBLIC_REMOTE"
fi

LOCAL_SHA="$(git rev-parse "$LOCAL_REF")"
UPSTREAM_SHA="$(git rev-parse "$UPSTREAM_REF")"
read -r LOCAL_ONLY UPSTREAM_ONLY < <(git rev-list --left-right --count "$LOCAL_REF...$UPSTREAM_REF" 2>/dev/null || echo "0 0")
BASE_READY_FOR_FEATURES="0"
FEATURE_SUMMARY=""
ISSUE_STATUS="done"

if [[ "$LOCAL_SHA" == "$UPSTREAM_SHA" ]]; then
  log "Already up-to-date with $UPSTREAM_REF — nothing to do."
  push_branch_to_forks "$LOCAL_REF" "$LOCAL_REF"
  BASE_READY_FOR_FEATURES="1"
elif git merge-base --is-ancestor "$UPSTREAM_REF" "$LOCAL_REF"; then
  log "$LOCAL_REF already contains $UPSTREAM_REF; local fork is ${LOCAL_ONLY} commit(s) ahead."
  push_branch_to_forks "$LOCAL_REF" "$LOCAL_REF"
  BASE_READY_FOR_FEATURES="1"
else
  DIFF_STAT="$(git diff --stat "$LOCAL_REF" "$UPSTREAM_REF" 2>/dev/null | tail -1 || echo '(diff unavailable)')"

  log "$UPSTREAM_REF is ${UPSTREAM_ONLY} commit(s) ahead; $LOCAL_REF is ${LOCAL_ONLY} commit(s) ahead. Attempting fast-forward merge..."

  git checkout "$LOCAL_REF" 2>&1

  if git merge --ff-only "$UPSTREAM_REF" 2>&1; then
    NEW_SHA="$(git rev-parse HEAD)"
    log "Fast-forward succeeded. Pushing synced base branch to fork remotes..."
    push_branch_to_forks "$LOCAL_REF" "$LOCAL_REF"
    BASE_READY_FOR_FEATURES="1"

    SUMMARY="$(printf '## Sync upstream: fast-forward OK ✓\n\n- Upstream: %s → %s\n- Commits merged: %s\n- Diff: %s\n\nPushed %s to selected fork remotes.' \
      "${LOCAL_SHA:0:8}" "${NEW_SHA:0:8}" "$UPSTREAM_ONLY" "$DIFF_STAT" "$LOCAL_REF")"

    log "Done. $SUMMARY"
  else
    log "Fast-forward not possible — creating branch $BRANCH for manual merge."
    git checkout -b "$BRANCH" 2>&1 || git checkout "$BRANCH"

    # Attempt merge (may produce conflicts)
    MERGE_OUTPUT="$(git merge "$UPSTREAM_REF" 2>&1 || true)"
    CONFLICTS="$(git diff --name-only --diff-filter=U 2>/dev/null | head -20 || echo '')"

    if [[ -z "$CONFLICTS" ]]; then
      push_branch_to_forks "$BRANCH" "$BRANCH"
      SUMMARY="$(printf '## Sync upstream: non-FF merge on branch %s\n\nMerge completed without conflicts — PR required to land on %s.\n\n- Branch: %s\n- Upstream commits: %s\n- Local-only commits: %s\n- Diff: %s\n- Pushed to selected fork remotes\n\nMerge output:\n```\n%s\n```' \
        "$BRANCH" "$LOCAL_REF" "$BRANCH" "$UPSTREAM_ONLY" "$LOCAL_ONLY" "$DIFF_STAT" "$MERGE_OUTPUT")"
      log "Non-FF merge done, pushed $BRANCH"
      ISSUE_STATUS="in_review"
      update_issue "in_review" "$SUMMARY"
    else
      CONFLICT_LIST="$(printf '%s' "$CONFLICTS" | awk '{print "- " $0}' | head -20)"
      git merge --abort 2>/dev/null || true
      git checkout "$LOCAL_REF" 2>&1
      git branch -D "$BRANCH" 2>/dev/null || true
      SUMMARY="$(printf '## Sync upstream: KONFLIKT — manuelle Auflösung erforderlich\n\n- Konflikte in %s Dateien:\n%s\n\nDiff zum Upstream:\n- Upstream commits: %s\n- Local-only commits: %s\n- Stat: %s' \
        "$(echo "$CONFLICTS" | wc -l | tr -d ' ')" "$CONFLICT_LIST" "$UPSTREAM_ONLY" "$LOCAL_ONLY" "$DIFF_STAT")"
      log "Merge conflicts detected. Manual resolution required."
      update_issue "blocked" "$SUMMARY"
      exit 1
    fi
  fi
fi

if [[ -n "$SYNC_FEATURES_SPEC" ]]; then
  if [[ "$BASE_READY_FOR_FEATURES" == "1" ]]; then
    sync_feature_branches "$LOCAL_REF" "$ORIGINAL_BRANCH"
    SUMMARY="$(printf '%s\n\n## Feature branch sync\n\n%s' "${SUMMARY:-Sync upstream: ${LOCAL_REF} already contains ${UPSTREAM_REF} (${UPSTREAM_SHA:0:8}). No merge needed.}" "$FEATURE_SUMMARY")"
  else
    FEATURE_SUMMARY="Feature branch sync skipped because ${LOCAL_REF} was not updated directly. Merge ${BRANCH} first, then rerun with --sync-features."
    log "$FEATURE_SUMMARY"
    SUMMARY="$(printf '%s\n\n## Feature branch sync\n\n%s' "$SUMMARY" "$FEATURE_SUMMARY")"
  fi
fi

if [[ -z "${SUMMARY:-}" ]]; then
  SUMMARY="$(printf 'Sync upstream: already up-to-date with %s (%s). No merge needed.' "$UPSTREAM_REF" "${UPSTREAM_SHA:0:8}")"
fi

if [[ -n "${STASH_REF:-}" ]]; then
  log "Restoring auto-stash..."
  git stash pop 2>&1 || log "Warning: could not restore stash automatically — run 'git stash pop' manually."
fi

update_issue "$ISSUE_STATUS" "$SUMMARY"
