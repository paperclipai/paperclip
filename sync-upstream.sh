#!/bin/bash
# Sync fork with upstream main and rebuild.
# Run this to pull latest upstream changes into the patch branch.
#
# Usage: ./sync-upstream.sh
#
# This merges upstream/master into fix/hermes-gateway-delta-log-fragmentation,
# keeping the transcript fragmentation fix on top of the latest main.
# If the PR has been merged upstream, the merge will be a no-op for the patch
# (git will recognize it as already applied) and you can switch to plain master.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

BRANCH="fix/hermes-gateway-delta-log-fragmentation"

echo "=== Safety net: rollback tag ==="
TAG="backup/pre-sync-$(date +%Y%m%d-%H%M)"
PRE_MERGE_HEAD="$(git rev-parse HEAD)"
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  TAG="$TAG-$$"
fi
git tag "$TAG" "$PRE_MERGE_HEAD"
echo "Tagged rollback point: $TAG ($PRE_MERGE_HEAD)"
echo "Rollback: git reset --hard $TAG && pnpm install --frozen-lockfile && pnpm build"

echo "=== Fetching upstream ==="
git fetch upstream

echo "=== Current branch: $(git branch --show-current) ==="
if [ "$(git branch --show-current)" != "$BRANCH" ]; then
  echo "Switching to $BRANCH..."
  git checkout "$BRANCH"
fi

echo "=== Merging upstream/master ==="
git merge upstream/master --no-edit

if [ $? -ne 0 ]; then
  echo ""
  echo "⚠️  Merge conflicts detected. Resolve them manually:"
  echo "   cd $SCRIPT_DIR"
  echo "   git status                    # see conflicted files"
  echo "   # edit conflicted files..."
  echo "   git add . && git commit --no-edit"
  echo ""
  echo "If the PR has been merged upstream, the patch line removal"
  echo "will already be in upstream/master — resolve by keeping"
  echo "the upstream version (the fix is the same one-line deletion)."
  exit 1
fi

echo "=== Installing dependencies ==="
# Node 24 required since upstream #11792; pnpm lives in the metricgator profile bin.
# CI=1 avoids an interactive "remove node_modules and reinstall?" prompt that
# aborts non-tty runs and leaves the tree half-installed.
export PATH="/root/.nvm/versions/node/v24.15.0/bin:/root/.hermes/profiles/metricgator/node/bin:$PATH"
export CI=1
pnpm install --frozen-lockfile

echo "=== Building ==="
pnpm build

echo ""
echo "✅ Synced and built. Restart Paperclip to pick up changes:"
echo "   $SCRIPT_DIR/run-paperclip.sh"
echo ""
echo "Or if the PR was merged upstream, you can now use plain master:"
echo "   git checkout master && $SCRIPT_DIR/run-paperclip.sh"