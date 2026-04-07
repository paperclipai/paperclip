#!/usr/bin/env bash
#
# Rebase dev and all feature branches onto the latest upstream/master.
#
# Usage:
#   ./scripts/rebase-upstream.sh [--dry-run]
#
# What it does:
#   1. Fetches upstream/master
#   2. Rebases dev onto upstream/master
#   3. Rebases each feature branch onto dev
#   4. Reports status of each branch
#
# If conflicts occur during any rebase, the script pauses and tells you
# which branch failed. Resolve conflicts, run `git rebase --continue`,
# then re-run this script to pick up where it left off.
#
# Feature branches are listed in FEATURE_BRANCHES below. Update this list
# when you create or remove feature branches.
#
set -euo pipefail

FEATURE_BRANCHES=(
  "feature/bastionclaw-adapter"
  "feature/company-kill-switch"
  "feature/heartbeat-model-override"
  "feature/post-import-defaults"
  "feature/youtube-intelligence-plugin"
  "chore/update-issue-templates"
)

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
fi

ORIGINAL_BRANCH=$(git branch --show-current)
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[rebase]${NC} $*"; }
warn()  { echo -e "${YELLOW}[rebase]${NC} $*"; }
error() { echo -e "${RED}[rebase]${NC} $*"; }

cleanup() {
  if [[ -n "${ORIGINAL_BRANCH:-}" ]]; then
    git checkout "$ORIGINAL_BRANCH" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# Check for clean working tree
if [[ -n "$(git status --porcelain)" ]]; then
  error "Working tree is dirty. Commit or stash changes first."
  exit 1
fi

# 1. Fetch upstream
info "Fetching upstream..."
if $DRY_RUN; then
  info "(dry-run) Would fetch upstream"
else
  git fetch upstream
fi

# 2. Rebase dev onto upstream/master
info ""
info "=== Rebasing dev onto upstream/master ==="
if $DRY_RUN; then
  BEHIND=$(git rev-list --count dev..upstream/master 2>/dev/null || echo "?")
  info "(dry-run) dev is $BEHIND commits behind upstream/master"
else
  git checkout dev

  if ! git rebase upstream/master; then
    error ""
    error "Conflicts during dev rebase onto upstream/master."
    error "Resolve conflicts, then run:"
    error "  git rebase --continue"
    error ""
    error "Once dev is clean, re-run this script to rebase feature branches."
    exit 1
  fi
  info "dev rebased successfully"
fi

# 3. Rebase each feature branch onto dev
info ""
info "=== Rebasing feature branches onto dev ==="

SUCCEEDED=()
FAILED=()
SKIPPED=()

for branch in "${FEATURE_BRANCHES[@]}"; do
  if ! git rev-parse --verify "$branch" &>/dev/null; then
    warn "  $branch — not found locally, skipping"
    SKIPPED+=("$branch")
    continue
  fi

  if $DRY_RUN; then
    BEHIND=$(git rev-list --count "$branch..dev" 2>/dev/null || echo "?")
    AHEAD=$(git rev-list --count "dev..$branch" 2>/dev/null || echo "?")
    info "  $branch — $AHEAD ahead, $BEHIND behind dev"
    SUCCEEDED+=("$branch")
    continue
  fi

  info "  Rebasing $branch..."
  git checkout "$branch"

  if git rebase dev; then
    info "  $branch — OK"
    SUCCEEDED+=("$branch")
  else
    error "  $branch — CONFLICTS"
    error ""
    error "  Resolve conflicts, then run:"
    error "    git rebase --continue"
    error "    git checkout dev"
    error ""
    error "  Then re-run this script to continue with remaining branches."
    FAILED+=("$branch")
    # Don't exit — let the user see the summary
    # But we can't continue rebasing other branches while in conflict state
    break
  fi
done

# 4. Return to original branch
if ! $DRY_RUN; then
  git checkout "$ORIGINAL_BRANCH" 2>/dev/null || git checkout dev
fi

# 5. Summary
info ""
info "=== Summary ==="
if [[ ${#SUCCEEDED[@]} -gt 0 ]]; then
  info "  Succeeded: ${SUCCEEDED[*]}"
fi
if [[ ${#SKIPPED[@]} -gt 0 ]]; then
  warn "  Skipped:   ${SKIPPED[*]}"
fi
if [[ ${#FAILED[@]} -gt 0 ]]; then
  error "  Failed:    ${FAILED[*]}"
  error ""
  error "  Resolve conflicts in the failed branch, then re-run this script."
  exit 1
fi

# 6. Optionally push all branches
if ! $DRY_RUN; then
  info ""
  read -p "Push all rebased branches to origin? (y/N) " -n 1 -r
  echo
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    info "Pushing dev..."
    git push origin dev --force-with-lease

    for branch in "${SUCCEEDED[@]}"; do
      info "Pushing $branch..."
      git push origin "$branch" --force-with-lease
    done
    info "All branches pushed."
  fi
fi

info "Done."
