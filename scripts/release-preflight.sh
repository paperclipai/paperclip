#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
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
  - shows the last stable tag and the target version(s)
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

compute_bumped_version() {
  node - "$1" "$2" <<'NODE'
const current = process.argv[2];
const bump = process.argv[3];
const match = current.match(/^(\d+)\.(\d+)\.(\d+)$/);

if (!match) {
  throw new Error(`invalid semver version: ${current}`);
}

let [major, minor, patch] = match.slice(1).map(Number);

if (bump === 'patch') {
  patch += 1;
} else if (bump === 'minor') {
  minor += 1;
  patch = 0;
} else if (bump === 'major') {
  major += 1;
  minor = 0;
  patch = 0;
} else {
  throw new Error(`unsupported bump type: ${bump}`);
}

process.stdout.write(`${major}.${minor}.${patch}`);
NODE
}

next_canary_version() {
  local stable_version="$1"
  local versions_json

  versions_json="$(npm view paperclipai versions --json 2>/dev/null || echo '[]')"

  node - "$stable_version" "$versions_json" <<'NODE'
const stable = process.argv[2];
const versionsArg = process.argv[3];

let versions = [];
try {
  const parsed = JSON.parse(versionsArg);
  versions = Array.isArray(parsed) ? parsed : [parsed];
} catch {
  versions = [];
}

const pattern = new RegExp(`^${stable.replace(/\./g, '\\.')}-canary\\.(\\d+)$`);
let max = -1;

for (const version of versions) {
  const match = version.match(pattern);
  if (!match) continue;
  max = Math.max(max, Number(match[1]));
}

process.stdout.write(`${stable}-canary.${max + 1}`);
NODE
}

LAST_STABLE_TAG="$(git -C "$REPO_ROOT" tag --list 'v*' --sort=-version:refname | head -1)"
CURRENT_STABLE_VERSION="${LAST_STABLE_TAG#v}"
if [ -z "$CURRENT_STABLE_VERSION" ]; then
  CURRENT_STABLE_VERSION="0.0.0"
fi

TARGET_STABLE_VERSION="$(compute_bumped_version "$CURRENT_STABLE_VERSION" "$bump_type")"
TARGET_CANARY_VERSION="$(next_canary_version "$TARGET_STABLE_VERSION")"

if [ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]; then
  echo "Error: working tree is not clean. Commit, stash, or remove changes before releasing." >&2
  exit 1
fi

if [ "$TARGET_STABLE_VERSION" = "$CURRENT_STABLE_VERSION" ]; then
  echo "Error: next stable version matches the current stable version." >&2
  exit 1
fi

if [[ "$TARGET_CANARY_VERSION" == "${CURRENT_STABLE_VERSION}-canary."* ]]; then
  echo "Error: canary target was derived from the current stable version, which is not allowed." >&2
  exit 1
fi

echo ""
echo "==> Release preflight"
echo "  Channel: $channel"
echo "  Bump: $bump_type"
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
echo "  Channel: $channel"
echo "  Bump: $bump_type"
echo "  Last stable tag: ${LAST_STABLE_TAG:-<none>}"
echo "  Current stable version: $CURRENT_STABLE_VERSION"
echo "  Next stable version: $TARGET_STABLE_VERSION"
if [ "$channel" = "canary" ]; then
  echo "  Next canary version: $TARGET_CANARY_VERSION"
  echo "  Guard: canaries are always derived from the next stable version, never ${CURRENT_STABLE_VERSION}-canary.N"
fi

echo ""
echo "Preflight passed for $channel release."
