#!/usr/bin/env bash
# Daily upstream sync: rebase btiknas/paperclip fork onto paperclipai/paperclip master,
# pull locally, and report whether a restart is needed.
#
# Usage: bash scripts/sync-upstream.sh [--report-only]
#   --report-only   Check sync status without making changes

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UPSTREAM_REMOTE="upstream"
UPSTREAM_URL="https://github.com/paperclipai/paperclip.git"
ORIGIN_REMOTE="origin"
BRANCH="master"

cd "$REPO_DIR"

REPORT_ONLY=0
for arg in "$@"; do
  [[ "$arg" == "--report-only" ]] && REPORT_ONLY=1
done

echo "=== Paperclip upstream sync ==="
echo "Repo: $REPO_DIR"
echo "Date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo ""

# 1. Ensure upstream remote exists
if ! git remote get-url "$UPSTREAM_REMOTE" &>/dev/null; then
  echo "[setup] Adding upstream remote: $UPSTREAM_URL"
  git remote add "$UPSTREAM_REMOTE" "$UPSTREAM_URL"
fi

# 2. Check working tree
if [[ -n "$(git status --porcelain)" ]]; then
  echo "[error] Working tree is not clean. Aborting sync."
  git status --short
  exit 1
fi

# 3. Fetch upstream
echo "[fetch] Fetching upstream/$BRANCH..."
git fetch "$UPSTREAM_REMOTE" "$BRANCH" 2>&1

# 4. Check sync status
AHEAD=$(git rev-list upstream/$BRANCH..HEAD | wc -l | tr -d ' ')
BEHIND=$(git rev-list HEAD..upstream/$BRANCH | wc -l | tr -d ' ')

echo "[status] Local is $AHEAD ahead, $BEHIND behind upstream/$BRANCH"

if [[ "$BEHIND" -eq 0 ]]; then
  echo "[ok] Fork is already up-to-date with upstream."
  if [[ "$REPORT_ONLY" -eq 1 ]]; then exit 0; fi
  # Still push to ensure fork remote is in sync with local
  echo "[push] Ensuring origin/$BRANCH is up-to-date..."
  git push "$ORIGIN_REMOTE" "$BRANCH" 2>&1 || git push --force-with-lease "$ORIGIN_REMOTE" "$BRANCH" 2>&1
  echo "[done] No restart needed (no new code)."
  echo "RESTART_NEEDED=false"
  exit 0
fi

if [[ "$REPORT_ONLY" -eq 1 ]]; then
  echo "[info] $BEHIND new upstream commits pending."
  git log --oneline HEAD..upstream/$BRANCH
  exit 0
fi

# 5. Rebase local branch onto upstream
echo ""
echo "[rebase] Rebasing $BRANCH onto upstream/$BRANCH..."
if ! git rebase "$UPSTREAM_REMOTE/$BRANCH" 2>&1; then
  echo "[error] Rebase had conflicts — aborting and reporting."
  git rebase --abort 2>/dev/null || true
  echo "CONFLICT=true"
  exit 2
fi

echo "[rebase] Success."

# 6. Force-push rebased branch to fork
echo "[push] Force-pushing to $ORIGIN_REMOTE/$BRANCH..."
git push --force-with-lease "$ORIGIN_REMOTE" "$BRANCH" 2>&1
echo "[push] Done."

# 7. Check if new migrations were applied
NEW_MIGRATION_FILES=$(git diff HEAD~${BEHIND}..HEAD --name-only -- "packages/db/src/migrations/*.sql" 2>/dev/null | wc -l | tr -d ' ')
echo ""
echo "[migrations] New migration files in $BEHIND upstream commits: $NEW_MIGRATION_FILES"

# 8. Determine restart behavior
# tsx watch auto-restarts when TS source changes; migrations apply on restart
if [[ "$NEW_MIGRATION_FILES" -gt 0 ]]; then
  echo "[restart] New migrations detected — tsx watch will auto-restart and apply them."
  echo "RESTART_NEEDED=auto_tsx_watch"
else
  echo "[restart] No new migrations — tsx watch hot-reload is sufficient."
  echo "RESTART_NEEDED=false"
fi

echo ""
echo "=== Sync complete ==="
echo "Ahead: $AHEAD"
echo "Behind processed: $BEHIND"
echo "New migrations: $NEW_MIGRATION_FILES"
