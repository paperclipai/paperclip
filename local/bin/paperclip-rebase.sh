#!/usr/bin/env bash
#
# Rebase local `main` onto the latest upstream origin/master, then
# force-push to the LinkCast backup remote (paperclip/main).
#
# Usage: ./paperclip-rebase.sh
#
set -euo pipefail

cd "$(dirname "$0")/../.."

BOLD="\033[1m"
GREEN="\033[0;32m"
YELLOW="\033[0;33m"
RED="\033[0;31m"
RESET="\033[0m"

info()    { echo -e "${BOLD}==> $*${RESET}"; }
success() { echo -e "${GREEN}✓ $*${RESET}"; }
warn()    { echo -e "${YELLOW}⚠ $*${RESET}"; }
die()     { echo -e "${RED}✗ $*${RESET}" >&2; exit 1; }

# ── Preflight ─────────────────────────────────────────────────────────────────

current_branch=$(git rev-parse --abbrev-ref HEAD)
if [[ "$current_branch" != "main" ]]; then
  die "Must be on 'main' to rebase (currently on '$current_branch')"
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  die "Working tree has uncommitted changes — stash or commit before rebasing"
fi

# ── Fetch ─────────────────────────────────────────────────────────────────────

info "Fetching upstream (origin)..."
git fetch origin

behind=$(git log --oneline main..origin/master | wc -l | tr -d ' ')
if [[ "$behind" -eq 0 ]]; then
  success "Already up to date with origin/master — nothing to do"
  exit 0
fi

info "main is $behind commits behind origin/master"

# ── Rebase ────────────────────────────────────────────────────────────────────

info "Rebasing main onto origin/master..."
if ! git rebase origin/master; then
  warn "Rebase stopped due to conflicts."
  echo ""
  echo "  Resolve conflicts, then run:"
  echo "    git add <files>"
  echo "    git rebase --continue"
  echo ""
  echo "  Once the rebase completes, re-run this script to push:"
  echo "    ./paperclip-rebase.sh"
  exit 1
fi

success "Rebase complete"

# ── Force-push to backup remote ───────────────────────────────────────────────

info "Force-pushing to paperclip/main (LinkCast backup)..."
git push paperclip main --force-with-lease

success "paperclip/main is up to date"
echo ""
echo -e "${BOLD}Done.${RESET} You can now Sync normally in your editor."
