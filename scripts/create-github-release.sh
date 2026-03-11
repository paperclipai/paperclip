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
  ./scripts/create-github-release.sh 1.2.3
  ./scripts/create-github-release.sh 1.2.3 --dry-run

Notes:
  - Run this after pushing the stable release branch and tag.
  - Defaults to git remote public-gh.
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
  echo "Error: version must be a stable semver like 1.2.3." >&2
  exit 1
fi

tag="v$version"
notes_file="$REPO_ROOT/releases/${tag}.md"
PUBLISH_REMOTE="${PUBLISH_REMOTE:-public-gh}"
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

if [ "$dry_run" = true ]; then
  echo "[dry-run] gh release create $tag -R $GITHUB_REPO --title $tag --notes-file $notes_file"
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
