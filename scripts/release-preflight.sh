#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=./release-lib.sh
. "$REPO_ROOT/scripts/release-lib.sh"
export GIT_PAGER=cat

channel=""
bump_type=""

usage() {
  cat <<'EOF'
Usage:
  ./scripts/release-preflight.sh <canary|stable> <patch|minor|major>

Examples:
  ./scripts/release-preflight.sh canary patch
  ./scripts/release-preflight.sh stable minor

What it does:
  - verifies the git worktree is clean, including untracked files
  - verifies you are on the matching release/X.Y.Z branch
  - shows the last stable tag and the target version(s)
  - shows the git/npm/GitHub release-train state
  - shows commits since the last stable tag
  - highlights migration/schema/breaking-change signals
  - runs the verification gate:
      pnpm -r typecheck
      pnpm test:run
      pnpm build
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [ -z "$channel" ]; then
        channel="$1"
      elif [ -z "$bump_type" ]; then
        bump_type="$1"
      else
        echo "Error: unexpected argument: $1" >&2
        exit 1
      fi
      ;;
  esac
  shift
done

if [ -z "$channel" ] || [ -z "$bump_type" ]; then
  usage
  exit 1
fi

if [[ ! "$channel" =~ ^(canary|stable)$ ]]; then
  usage
  exit 1
fi

if [[ ! "$bump_type" =~ ^(patch|minor|major)$ ]]; then
  usage
  exit 1
fi

RELEASE_REMOTE="$(resolve_release_remote)"
fetch_release_remote "$RELEASE_REMOTE"

LAST_STABLE_TAG="$(get_last_stable_tag)"
CURRENT_STABLE_VERSION="$(get_current_stable_version)"
TARGET_STABLE_VERSION="$(compute_bumped_version "$CURRENT_STABLE_VERSION" "$bump_type")"
TARGET_CANARY_VERSION="$(next_canary_version "$TARGET_STABLE_VERSION")"
EXPECTED_RELEASE_BRANCH="$(release_branch_name "$TARGET_STABLE_VERSION")"
CURRENT_BRANCH="$(git_current_branch)"
RELEASE_TAG="v$TARGET_STABLE_VERSION"
NOTES_FILE="$(release_notes_file "$TARGET_STABLE_VERSION")"

require_clean_worktree

if [ "$TARGET_STABLE_VERSION" = "$CURRENT_STABLE_VERSION" ]; then
  echo "Error: next stable version matches the current stable version." >&2
  exit 1
fi

if [[ "$TARGET_CANARY_VERSION" == "${CURRENT_STABLE_VERSION}-canary."* ]]; then
  echo "Error: canary target was derived from the current stable version, which is not allowed." >&2
  exit 1
fi

ensure_release_branch_for_version "$TARGET_STABLE_VERSION"

REMOTE_BRANCH_EXISTS="no"
REMOTE_TAG_EXISTS="no"
LOCAL_TAG_EXISTS="no"
NPM_STABLE_EXISTS="no"

if git_remote_branch_exists "$EXPECTED_RELEASE_BRANCH" "$RELEASE_REMOTE"; then
  REMOTE_BRANCH_EXISTS="yes"
fi

if git_local_tag_exists "$RELEASE_TAG"; then
  LOCAL_TAG_EXISTS="yes"
fi

if git_remote_tag_exists "$RELEASE_TAG" "$RELEASE_REMOTE"; then
  REMOTE_TAG_EXISTS="yes"
fi

if npm_version_exists "$TARGET_STABLE_VERSION"; then
  NPM_STABLE_EXISTS="yes"
fi

if [ "$LOCAL_TAG_EXISTS" = "yes" ] || [ "$REMOTE_TAG_EXISTS" = "yes" ] || [ "$NPM_STABLE_EXISTS" = "yes" ]; then
  echo "Error: release train $EXPECTED_RELEASE_BRANCH is frozen because $RELEASE_TAG already exists locally, remotely, or version $TARGET_STABLE_VERSION is already on npm." >&2
  exit 1
fi

echo ""
echo "==> Release preflight"
echo "  Remote: $RELEASE_REMOTE"
echo "  Channel: $channel"
echo "  Bump: $bump_type"
echo "  Current branch: ${CURRENT_BRANCH:-<detached>}"
echo "  Expected branch: $EXPECTED_RELEASE_BRANCH"
echo "  Last stable tag: ${LAST_STABLE_TAG:-<none>}"
echo "  Current stable version: $CURRENT_STABLE_VERSION"
echo "  Next stable version: $TARGET_STABLE_VERSION"
if [ "$channel" = "canary" ]; then
  echo "  Next canary version: $TARGET_CANARY_VERSION"
  echo "  Guard: canaries are always derived from the next stable version, never ${CURRENT_STABLE_VERSION}-canary.N"
fi

echo ""
echo "==> Working tree"
echo "  ✓ Clean"
echo "  ✓ Branch matches release train"

echo ""
echo "==> Release train state"
echo "  Remote branch exists: $REMOTE_BRANCH_EXISTS"
echo "  Local stable tag exists: $LOCAL_TAG_EXISTS"
echo "  Remote stable tag exists: $REMOTE_TAG_EXISTS"
echo "  Stable version on npm: $NPM_STABLE_EXISTS"
if [ -f "$NOTES_FILE" ]; then
  echo "  Release notes: present at $NOTES_FILE"
else
  echo "  Release notes: missing at $NOTES_FILE"
fi

if [ "$REMOTE_BRANCH_EXISTS" = "no" ]; then
  echo "  Warning: remote branch $EXPECTED_RELEASE_BRANCH does not exist on $RELEASE_REMOTE yet."
fi

echo ""
echo "==> Commits since last stable tag"
if [ -n "$LAST_STABLE_TAG" ]; then
  git -C "$REPO_ROOT" --no-pager log "${LAST_STABLE_TAG}..HEAD" --oneline --no-merges || true
else
  git -C "$REPO_ROOT" --no-pager log --oneline --no-merges || true
fi

echo ""
echo "==> Migration / breaking change signals"
if [ -n "$LAST_STABLE_TAG" ]; then
  echo "-- migrations --"
  git -C "$REPO_ROOT" --no-pager diff --name-only "${LAST_STABLE_TAG}..HEAD" -- packages/db/src/migrations/ || true
  echo "-- schema --"
  git -C "$REPO_ROOT" --no-pager diff "${LAST_STABLE_TAG}..HEAD" -- packages/db/src/schema/ || true
  echo "-- breaking commit messages --"
  git -C "$REPO_ROOT" --no-pager log "${LAST_STABLE_TAG}..HEAD" --format="%s" | grep -E 'BREAKING CHANGE|BREAKING:|^[a-z]+!:' || true
else
  echo "No stable tag exists yet. Review the full current tree manually."
fi

echo ""
echo "==> Verification gate"
cd "$REPO_ROOT"
pnpm -r typecheck
pnpm test:run
pnpm build

echo ""
echo "==> Release preflight summary"
echo "  Remote: $RELEASE_REMOTE"
echo "  Channel: $channel"
echo "  Bump: $bump_type"
echo "  Release branch: $EXPECTED_RELEASE_BRANCH"
echo "  Last stable tag: ${LAST_STABLE_TAG:-<none>}"
echo "  Current stable version: $CURRENT_STABLE_VERSION"
echo "  Next stable version: $TARGET_STABLE_VERSION"
if [ "$channel" = "canary" ]; then
  echo "  Next canary version: $TARGET_CANARY_VERSION"
  echo "  Guard: canaries are always derived from the next stable version, never ${CURRENT_STABLE_VERSION}-canary.N"
fi

echo ""
echo "Preflight passed for $channel release."
