#!/usr/bin/env bash
#
# Rebase master and all feature branches onto the latest upstream/master.
#
# Usage:
#   ./scripts/rebase-upstream.sh [--dry-run | --check-only]
#
# What it does:
#   1. Fetches upstream/master
#   2. Checks upstream status of each security backport branch
#      (reads docs/security-backports.md index block; queries gh api;
#       prompts to delete branches whose upstream fix has landed)
#   3. Rebases local master onto upstream/master
#   4. Rebases each feature branch + each active security branch onto master
#   5. Merges rebased branches back into master
#   6. Rebuilds steel-paperclip from master
#   7. Returns to master when done
#
# Modes:
#   --dry-run    : preview rebase scope without making any changes
#   --check-only : run the security-backport upstream status check only,
#                  then exit (no fetch-rebase-merge-push)
#
# If conflicts occur during any rebase, the script pauses and tells you
# which branch failed. Resolve conflicts, run `git rebase --continue`,
# then re-run this script to pick up where it left off.
#
# Feature branches are listed in FEATURE_BRANCHES below. Update this list
# when you create or remove feature branches. Security branches are tracked
# in docs/security-backports.md and discovered automatically.
#
set -euo pipefail

FEATURE_BRANCHES=(
  "feature/bastionclaw-adapter"
  "feature/company-kill-switch"
  "feature/heartbeat-model-override"
  "feature/post-import-defaults"
  "fix/plugin-route-prefix-v2"
  "chore/update-issue-templates"
)

SECURITY_INDEX_FILE="docs/security-backports.md"
SECURITY_CACHE_FILE=".git/security-backports-cache.tsv"
SECURITY_CACHE_TTL_SECONDS=3600
UPSTREAM_REPO="paperclipai/paperclip"

DRY_RUN=false
CHECK_ONLY=false
case "${1:-}" in
  --dry-run)    DRY_RUN=true ;;
  --check-only) CHECK_ONLY=true ;;
  "") ;;
  *)
    echo "Unknown flag: ${1}" >&2
    echo "Usage: $0 [--dry-run | --check-only]" >&2
    exit 1
    ;;
esac

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[rebase]${NC} $*"; }
warn()  { echo -e "${YELLOW}[rebase]${NC} $*"; }
error() { echo -e "${RED}[rebase]${NC} $*"; }

cleanup() {
  git checkout master 2>/dev/null || true
}
trap cleanup EXIT

# --- security-backport parsing and upstream-status check --------------------

# Parse the <!-- BEGIN/END security-backports-index --> block in
# docs/security-backports.md. Outputs one line per entry: "branch|issue|pr".
parse_security_index() {
  if [[ ! -f "$SECURITY_INDEX_FILE" ]]; then
    return 0
  fi
  awk '
    /<!-- BEGIN security-backports-index -->/ { in_block=1; next }
    /<!-- END security-backports-index -->/   { in_block=0 }
    in_block && /branch=/ {
      branch=""; issue=""; pr="";
      for (i=1; i<=NF; i++) {
        if ($i ~ /^branch=/) { sub(/^branch=/, "", $i); branch=$i }
        else if ($i ~ /^issue=/) { sub(/^issue=/, "", $i); issue=$i }
        else if ($i ~ /^pr=/) { sub(/^pr=/, "", $i); pr=$i }
      }
      if (branch != "") print branch "|" issue "|" pr
    }
  ' "$SECURITY_INDEX_FILE"
}

# Look up a cached value. Returns the cached value (e.g. "merged", "closed",
# "open") on stdout, or nothing if the cache entry is missing or stale.
cache_get() {
  local key="$1"
  [[ -f "$SECURITY_CACHE_FILE" ]] || return 0
  local now
  now=$(date +%s)
  local line
  line=$(awk -F'\t' -v k="$key" '$1 == k { print }' "$SECURITY_CACHE_FILE" | tail -1)
  [[ -z "$line" ]] && return 0
  local ts value
  ts=$(echo "$line" | awk -F'\t' '{ print $2 }')
  value=$(echo "$line" | awk -F'\t' '{ print $3 }')
  if (( now - ts < SECURITY_CACHE_TTL_SECONDS )); then
    echo "$value"
  fi
}

cache_set() {
  local key="$1"
  local value="$2"
  local now
  now=$(date +%s)
  mkdir -p "$(dirname "$SECURITY_CACHE_FILE")"
  printf '%s\t%s\t%s\n' "$key" "$now" "$value" >> "$SECURITY_CACHE_FILE"
}

# Returns one of: ACTIVE, RETIRED_PR_MERGED, RETIRED_ISSUE_CLOSED, ERROR
query_upstream_state() {
  local issue="$1"
  local pr="$2"

  if [[ -n "$pr" ]]; then
    local cached
    cached=$(cache_get "pr:$pr")
    if [[ -z "$cached" ]]; then
      cached=$(gh api "repos/$UPSTREAM_REPO/pulls/$pr" --jq '.merged' 2>/dev/null || echo "error")
      cache_set "pr:$pr" "$cached"
    fi
    if [[ "$cached" == "true" ]]; then
      echo "RETIRED_PR_MERGED"
      return
    fi
  fi

  if [[ -n "$issue" ]]; then
    local cached
    cached=$(cache_get "issue:$issue")
    if [[ -z "$cached" ]]; then
      cached=$(gh api "repos/$UPSTREAM_REPO/issues/$issue" --jq '.state' 2>/dev/null || echo "error")
      cache_set "issue:$issue" "$cached"
    fi
    if [[ "$cached" == "closed" ]]; then
      echo "RETIRED_ISSUE_CLOSED"
      return
    fi
  fi

  echo "ACTIVE"
}

# Populated by check_security_backports:
#   SECURITY_ACTIVE_BRANCHES — array of active security branch names
#   SECURITY_RETIRED_BRANCHES — array of "branch|reason" entries
SECURITY_ACTIVE_BRANCHES=()
SECURITY_RETIRED_BRANCHES=()

check_security_backports() {
  info ""
  info "=== Checking upstream status of security backports ==="

  if [[ ! -f "$SECURITY_INDEX_FILE" ]]; then
    warn "  $SECURITY_INDEX_FILE not found — skipping"
    return 0
  fi

  if ! command -v gh >/dev/null 2>&1; then
    warn "  gh CLI not available — treating all security branches as ACTIVE"
  fi

  local entries
  entries=$(parse_security_index)
  if [[ -z "$entries" ]]; then
    info "  index block is empty"
    return 0
  fi

  local line branch issue pr state url reason
  while IFS='|' read -r branch issue pr; do
    if ! git rev-parse --verify "$branch" &>/dev/null; then
      warn "  $branch — branch not found locally, skipping"
      continue
    fi

    if command -v gh >/dev/null 2>&1; then
      state=$(query_upstream_state "$issue" "$pr")
    else
      state="ACTIVE"
    fi

    if [[ -n "$pr" ]]; then
      url="https://github.com/$UPSTREAM_REPO/pull/$pr"
    elif [[ -n "$issue" ]]; then
      url="https://github.com/$UPSTREAM_REPO/issues/$issue"
    else
      url="(no upstream reference)"
    fi

    case "$state" in
      ACTIVE)
        info "  $branch — ACTIVE   $url"
        SECURITY_ACTIVE_BRANCHES+=("$branch")
        ;;
      RETIRED_PR_MERGED)
        reason="PR #$pr merged"
        warn "  $branch — RETIRED  $url ($reason)"
        SECURITY_RETIRED_BRANCHES+=("$branch|$reason")
        ;;
      RETIRED_ISSUE_CLOSED)
        reason="issue #$issue closed"
        warn "  $branch — RETIRED  $url ($reason)"
        SECURITY_RETIRED_BRANCHES+=("$branch|$reason")
        ;;
      *)
        warn "  $branch — UNKNOWN  $url (treating as ACTIVE)"
        SECURITY_ACTIVE_BRANCHES+=("$branch")
        ;;
    esac
  done <<< "$entries"

  # Prompt to delete retired branches (skip in --dry-run / --check-only)
  if [[ ${#SECURITY_RETIRED_BRANCHES[@]} -gt 0 ]] && ! $DRY_RUN && ! $CHECK_ONLY; then
    info ""
    warn "${#SECURITY_RETIRED_BRANCHES[@]} security branch(es) can be retired:"
    local entry
    for entry in "${SECURITY_RETIRED_BRANCHES[@]}"; do
      warn "  ${entry%%|*} (${entry##*|})"
    done
    read -p "Delete these retired branches locally? (y/N) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
      for entry in "${SECURITY_RETIRED_BRANCHES[@]}"; do
        local b="${entry%%|*}"
        info "  Deleting $b..."
        git branch -D "$b" 2>&1 | tail -1 || warn "  Failed to delete $b"
      done
    else
      info "  Keeping retired branches (re-run when ready to delete)"
    fi
  fi
}

# --- main flow --------------------------------------------------------------

# Check for clean working tree
if [[ -n "$(git status --porcelain)" ]]; then
  error "Working tree is dirty. Commit or stash changes first."
  exit 1
fi

# 1. Fetch upstream
info "Fetching upstream..."
if $DRY_RUN; then
  info "(dry-run) Would fetch upstream"
elif $CHECK_ONLY; then
  git fetch upstream 2>/dev/null || warn "  fetch failed, continuing with cached refs"
else
  git fetch upstream
fi

# 2. Security-backport upstream status check
check_security_backports

if $CHECK_ONLY; then
  info ""
  info "(check-only mode — skipping rebase/merge/push)"
  exit 0
fi

# 3. Snapshot pre-rebase state: branches that are fully merged (ahead=0)
# act as anchors — after master rebases onto upstream, their old SHAs become
# stale even though the logical content is already in master. We fast-forward
# these to the new master automatically. Branches with unique work go through
# the normal rebase path below.
ALL_BRANCHES=("${FEATURE_BRANCHES[@]}")
if [[ ${#SECURITY_ACTIVE_BRANCHES[@]} -gt 0 ]]; then
  ALL_BRANCHES+=("${SECURITY_ACTIVE_BRANCHES[@]}")
fi

ANCHOR_BRANCHES=()
for branch in "${ALL_BRANCHES[@]}"; do
  if ! git rev-parse --verify "$branch" &>/dev/null; then
    continue
  fi
  AHEAD=$(git rev-list --count "master..$branch" 2>/dev/null || echo "0")
  if [[ "$AHEAD" -eq 0 ]]; then
    ANCHOR_BRANCHES+=("$branch")
  fi
done

if [[ ${#ANCHOR_BRANCHES[@]} -gt 0 ]]; then
  info ""
  info "Pre-rebase: ${#ANCHOR_BRANCHES[@]} branch(es) fully merged into master (will fast-forward to new master after rebase):"
  for b in "${ANCHOR_BRANCHES[@]}"; do
    info "  $b"
  done
fi

# 4. Rebase master onto upstream/master
info ""
info "=== Rebasing master onto upstream/master ==="
if $DRY_RUN; then
  BEHIND=$(git rev-list --count master..upstream/master 2>/dev/null || echo "?")
  info "(dry-run) master is $BEHIND commits behind upstream/master"
else
  git checkout master

  if ! git rebase upstream/master; then
    error ""
    error "Conflicts during master rebase onto upstream/master."
    error "Resolve conflicts, then run:"
    error "  git rebase --continue"
    error ""
    error "Once master is clean, re-run this script to rebase feature branches."
    exit 1
  fi
  info "master rebased successfully"
fi

# 5. Fast-forward anchor branches to new master. Their pre-rebase content is
# already in master under new SHAs; rebasing them would just hit conflicts
# trying to re-apply commits that are logically already present.
if [[ ${#ANCHOR_BRANCHES[@]} -gt 0 ]] && ! $DRY_RUN; then
  info ""
  info "=== Resetting ${#ANCHOR_BRANCHES[@]} anchor branch(es) to new master ==="
  for b in "${ANCHOR_BRANCHES[@]}"; do
    git branch -f "$b" master && info "  $b — reset to master"
  done
fi

# 6. Rebase the remaining branches (those with unique work) onto master
REBASE_BRANCHES=()
for branch in "${ALL_BRANCHES[@]}"; do
  skip=false
  if [[ ${#ANCHOR_BRANCHES[@]} -gt 0 ]]; then
    for a in "${ANCHOR_BRANCHES[@]}"; do
      if [[ "$a" == "$branch" ]]; then skip=true; break; fi
    done
  fi
  $skip || REBASE_BRANCHES+=("$branch")
done
if [[ ${#REBASE_BRANCHES[@]} -gt 0 ]]; then
  ALL_BRANCHES=("${REBASE_BRANCHES[@]}")
else
  ALL_BRANCHES=()
fi

# 5. Rebase each branch onto master
info ""
info "=== Rebasing branches onto master ==="

SUCCEEDED=()
FAILED=()
SKIPPED=()
SECURITY_PATCH_ALREADY_UPSTREAM=()

if [[ ${#ALL_BRANCHES[@]} -eq 0 ]]; then
  info "  (no branches with unique work to rebase)"
fi

for branch in "${ALL_BRANCHES[@]+"${ALL_BRANCHES[@]}"}"; do
  if ! git rev-parse --verify "$branch" &>/dev/null; then
    warn "  $branch — not found locally, skipping"
    SKIPPED+=("$branch")
    continue
  fi

  if $DRY_RUN; then
    BEHIND=$(git rev-list --count "$branch..master" 2>/dev/null || echo "?")
    AHEAD=$(git rev-list --count "master..$branch" 2>/dev/null || echo "?")
    info "  $branch — $AHEAD ahead, $BEHIND behind master"
    SUCCEEDED+=("$branch")
    continue
  fi

  info "  Rebasing $branch..."
  git checkout "$branch"

  REBASE_LOG=$(mktemp)
  if git rebase master 2>&1 | tee "$REBASE_LOG"; then
    info "  $branch — OK"
    SUCCEEDED+=("$branch")
    # Secondary upstream-detection signal: if rebase output contains
    # "previously applied commit" or "patch contents already upstream"
    # for a security branch, flag it.
    if [[ "$branch" == security/* ]] && grep -qE "previously applied commit|patch contents already upstream" "$REBASE_LOG"; then
      SECURITY_PATCH_ALREADY_UPSTREAM+=("$branch")
    fi
    rm -f "$REBASE_LOG"
  else
    rm -f "$REBASE_LOG"
    error "  $branch — CONFLICTS"
    error ""
    error "  Resolve conflicts, then run:"
    error "    git rebase --continue"
    error "    git checkout master"
    error ""
    error "  Then re-run this script to continue with remaining branches."
    FAILED+=("$branch")
    # Don't exit — let the user see the summary
    # But we can't continue rebasing other branches while in conflict state
    break
  fi
done

# 6. Return to master
if ! $DRY_RUN; then
  git checkout master
fi

# 7. Summary
info ""
info "=== Summary ==="
if [[ ${#SUCCEEDED[@]} -gt 0 ]]; then
  info "  Rebased: ${SUCCEEDED[*]}"
fi
if [[ ${#SKIPPED[@]} -gt 0 ]]; then
  warn "  Skipped: ${SKIPPED[*]}"
fi
if [[ ${#FAILED[@]} -gt 0 ]]; then
  error "  Failed:  ${FAILED[*]}"
  error ""
  error "  Resolve conflicts in the failed branch, then re-run this script."
  exit 1
fi

# 7b. Secondary signal: security branches whose patches are already upstream
if [[ ${#SECURITY_PATCH_ALREADY_UPSTREAM[@]} -gt 0 ]]; then
  info ""
  warn "The following security branches rebased cleanly but git detected"
  warn "their patches are already upstream (via cherry-pick equivalence):"
  for b in "${SECURITY_PATCH_ALREADY_UPSTREAM[@]}"; do
    warn "  $b"
  done
  warn "Consider retiring these branches on the next run."
fi

# 8. Merge feature branches into master
if [[ ${#SUCCEEDED[@]} -gt 0 ]] && [[ ${#FAILED[@]} -eq 0 ]] && ! $DRY_RUN; then
  info ""
  info "=== Merging branches into master ==="
  for branch in "${SUCCEEDED[@]}"; do
    AHEAD=$(git rev-list --count "master..$branch" 2>/dev/null || echo "0")
    if [[ "$AHEAD" -gt 0 ]]; then
      info "  Merging $branch ($AHEAD commits)..."
      if ! git merge --no-ff --no-edit "$branch" -m "Merge $branch into master"; then
        error "  Conflict merging $branch into master."
        error "  Resolve conflicts, commit, then re-run this script."
        break
      fi
    else
      info "  $branch — already on master"
    fi
  done
fi

# 9. Build steel-paperclip branch (copy of master for distribution)
if [[ ${#FAILED[@]} -eq 0 ]] && ! $DRY_RUN; then
  info ""
  info "=== Building steel-paperclip branch ==="
  git branch -D steel-paperclip 2>/dev/null || true
  git checkout -b steel-paperclip
  info "steel-paperclip branch rebuilt from master"
  git checkout master
fi

# 10. Optionally push all branches
if ! $DRY_RUN; then
  info ""
  read -p "Push all rebased branches + steel-paperclip to origin? (y/N) " -n 1 -r
  echo
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    info "Pushing master..."
    git push origin master --force-with-lease

    for branch in "${SUCCEEDED[@]}"; do
      info "Pushing $branch..."
      git push origin "$branch" --force-with-lease
    done

    info "Pushing steel-paperclip..."
    git push origin steel-paperclip --force-with-lease

    info "All branches pushed."
  fi
fi

info "Done."
info ""
info "Private clone: git clone https://github.com/harperaa/paperclip.git -b steel-paperclip"
