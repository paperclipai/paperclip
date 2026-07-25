#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=./release-lib.sh
. "$REPO_ROOT/scripts/release-lib.sh"

dry_run=false
version=""

usage() {
  cat <<'EOF'
Usage:
  ./scripts/create-github-release.sh <version> [--dry-run]

Examples:
  ./scripts/create-github-release.sh 2026.318.0
  ./scripts/create-github-release.sh 2026.318.0 --dry-run

Notes:
  - Run this after pushing the stable tag.
  - Resolves the git remote automatically.
  - In GitHub Actions, origin is used explicitly.
  - If the release already exists, this script updates its title and notes.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry_run=true ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [ -n "$version" ]; then
        echo "Error: only one version may be provided." >&2
        exit 1
      fi
      version="$1"
      ;;
  esac
  shift
done

if [ -z "$version" ]; then
  usage
  exit 1
fi

if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Error: version must be a stable calendar version like 2026.318.0." >&2
  exit 1
fi

tag="v$version"
notes_file="$REPO_ROOT/releases/${tag}.md"
if [ "${GITHUB_ACTIONS:-}" = "true" ] && [ -z "${PUBLISH_REMOTE:-}" ] && git_remote_exists origin; then
  PUBLISH_REMOTE=origin
fi
PUBLISH_REMOTE="$(resolve_release_remote)"
if ! command -v gh >/dev/null 2>&1; then
  echo "Error: gh CLI is required to create GitHub releases." >&2
  exit 1
fi

GITHUB_REPO="$(github_repo_from_remote "$PUBLISH_REMOTE" || true)"
if [ -z "$GITHUB_REPO" ]; then
  echo "Error: could not determine GitHub repository from remote $PUBLISH_REMOTE." >&2
  exit 1
fi

if [ ! -f "$notes_file" ]; then
  echo "Error: release notes file not found at $notes_file." >&2
  exit 1
fi

if ! git -C "$REPO_ROOT" rev-parse "$tag" >/dev/null 2>&1; then
  echo "Error: local git tag $tag does not exist." >&2
  exit 1
fi

# The catalog is derived from the checked-out sources, so it must be generated
# from the exact commit the release tag points at, with no local edits.
tag_commit="$(git -C "$REPO_ROOT" rev-parse "$tag^{commit}")"
head_commit="$(git -C "$REPO_ROOT" rev-parse HEAD)"
if [ "$head_commit" != "$tag_commit" ]; then
  echo "Error: HEAD ($head_commit) does not match tag $tag ($tag_commit). Check out the release tag before generating the feature catalog." >&2
  exit 1
fi
if [ -n "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=no)" ]; then
  echo "Error: working tree has uncommitted changes. The feature catalog must be generated from the pristine release commit." >&2
  exit 1
fi

catalog_dir="$(mktemp -d)"
trap 'rm -rf "$catalog_dir"' EXIT
catalog_file="$catalog_dir/feature-catalog.json"
node "$REPO_ROOT/cli/node_modules/tsx/dist/cli.mjs" \
  "$REPO_ROOT/scripts/generate-feature-catalog.ts" \
  --version "$version" \
  --out "$catalog_file"

if [ "$dry_run" = true ]; then
  echo "[dry-run] gh release create $tag -R $GITHUB_REPO --title $tag --notes-file $notes_file"
  echo "[dry-run] gh release upload $tag -R $GITHUB_REPO --clobber $catalog_file"
  exit 0
fi

if ! git -C "$REPO_ROOT" ls-remote --exit-code --tags "$PUBLISH_REMOTE" "refs/tags/$tag" >/dev/null 2>&1; then
  echo "Error: remote tag $tag was not found on $PUBLISH_REMOTE. Push the release commit and tag first." >&2
  exit 1
fi

if gh release view "$tag" -R "$GITHUB_REPO" >/dev/null 2>&1; then
  gh release edit "$tag" -R "$GITHUB_REPO" --title "$tag" --notes-file "$notes_file"
  echo "Updated GitHub Release $tag"
else
  gh release create "$tag" -R "$GITHUB_REPO" --title "$tag" --notes-file "$notes_file"
  echo "Created GitHub Release $tag"
fi

gh release upload "$tag" -R "$GITHUB_REPO" --clobber "$catalog_file"
echo "Uploaded feature-catalog.json to GitHub Release $tag"
