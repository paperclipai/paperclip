#!/usr/bin/env bash
# Syncs local fork master with paperclipai/paperclip upstream/master.
# Fast-forward: merges directly and pushes. Non-FF: opens chore/sync-YYYYMMDD branch.
# Posts result as a comment on the Paperclip issue ($PAPERCLIP_TASK_ID).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATE="$(date +%Y%m%d)"
BRANCH="chore/sync-${DATE}"

log() { echo "[sync-upstream] $*"; }
die() { log "ERROR: $*"; exit 1; }

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

cd "$REPO_ROOT"

log "Fetching upstream..."
git fetch upstream 2>&1

UPSTREAM_REF="upstream/master"
LOCAL_REF="master"

# Get commit counts for diff summary
LOCAL_SHA="$(git rev-parse "$LOCAL_REF")"
UPSTREAM_SHA="$(git rev-parse "$UPSTREAM_REF")"

if [[ "$LOCAL_SHA" == "$UPSTREAM_SHA" ]]; then
  log "Already up-to-date with $UPSTREAM_REF — nothing to do."
  update_issue "done" "$(printf 'Sync upstream: already up-to-date with %s (%s). No merge needed.' "$UPSTREAM_REF" "${UPSTREAM_SHA:0:8}")"
  exit 0
fi

COMMITS_AHEAD="$(git rev-list --count "$LOCAL_REF...$UPSTREAM_REF" 2>/dev/null || echo 0)"
DIFF_STAT="$(git diff --stat "$LOCAL_REF" "$UPSTREAM_REF" 2>/dev/null | tail -1 || echo '(diff unavailable)')"

log "Upstream is $COMMITS_AHEAD commits ahead. Attempting fast-forward merge..."

git checkout master

if git merge --ff-only "$UPSTREAM_REF" 2>&1; then
  NEW_SHA="$(git rev-parse HEAD)"
  log "Fast-forward succeeded. Pushing to origin..."
  git push origin master 2>&1

  SUMMARY="$(printf '## Sync upstream: fast-forward OK ✓\n\n- Upstream: %s → %s\n- Commits merged: %s\n- Diff: %s\n\nPushed to origin/master.' \
    "${LOCAL_SHA:0:8}" "${NEW_SHA:0:8}" "$COMMITS_AHEAD" "$DIFF_STAT")"

  log "Done. $SUMMARY"
  update_issue "done" "$SUMMARY"
else
  log "Fast-forward not possible — creating branch $BRANCH for manual merge."
  git checkout -b "$BRANCH" 2>&1 || git checkout "$BRANCH"

  # Attempt merge (may produce conflicts)
  MERGE_OUTPUT="$(git merge "$UPSTREAM_REF" 2>&1 || true)"
  CONFLICTS="$(git diff --name-only --diff-filter=U 2>/dev/null | head -20 || echo '')"

  if [[ -z "$CONFLICTS" ]]; then
    git push origin "$BRANCH" 2>&1
    SUMMARY="$(printf '## Sync upstream: non-FF merge on branch %s\n\nMerge completed without conflicts — PR required to land on master.\n\n- Branch: %s\n- Commits: %s\n- Diff: %s\n\nPush output:\n```\n%s\n```' \
      "$BRANCH" "$BRANCH" "$COMMITS_AHEAD" "$DIFF_STAT" "$MERGE_OUTPUT")"
    log "Non-FF merge done, pushed $BRANCH"
    update_issue "in_review" "$SUMMARY"
  else
    CONFLICT_LIST="$(printf '%s' "$CONFLICTS" | awk '{print "- " $0}' | head -20)"
    git merge --abort 2>/dev/null || true
    git checkout master
    git branch -D "$BRANCH" 2>/dev/null || true
    SUMMARY="$(printf '## Sync upstream: KONFLIKT — manuelle Auflösung erforderlich\n\n- Konflikte in %s Dateien:\n%s\n\nDiff zum Upstream:\n- Commits: %s\n- Stat: %s' \
      "$(echo "$CONFLICTS" | wc -l | tr -d ' ')" "$CONFLICT_LIST" "$COMMITS_AHEAD" "$DIFF_STAT")"
    log "Merge conflicts detected. Manual resolution required."
    update_issue "blocked" "$SUMMARY"
    exit 1
  fi
fi
