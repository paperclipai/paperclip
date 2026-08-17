#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=./release-lib.sh
. "$REPO_ROOT/scripts/release-lib.sh"

beta_version=""
out_file=""
repo_dir="$REPO_ROOT"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/draft-stable-notes.sh <beta-version> [--out PATH] [--repo-dir PATH]

Examples:
  ./scripts/draft-stable-notes.sh 2026.817.1-beta.0
  ./scripts/draft-stable-notes.sh 2026.817.1-beta.0 --out /tmp/draft.md

Notes:
  - Generates a stable release-notes draft for the given published beta:
    the commit range from the newest stable tag (v*) to the beta's source
    commit, grouped by conventional-commit type.
  - Written to releases/beta/v<beta-version>.md by default. The draft is
    meant to be committed to master via PR and edited during the beta
    soak; the stable promotion reads it from master.
  - With no stable tag yet, the range falls back to the previous beta
    tag, and failing that to the full history of the source commit.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --out)
      shift
      [ $# -gt 0 ] || release_fail "--out requires a path."
      out_file="$1"
      ;;
    --repo-dir)
      shift
      [ $# -gt 0 ] || release_fail "--repo-dir requires a path."
      repo_dir="$1"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [ -n "$beta_version" ]; then
        release_fail "only one beta version may be provided."
      fi
      beta_version="$1"
      ;;
  esac
  shift
done

if [ -z "$beta_version" ]; then
  usage
  exit 1
fi

if [[ ! "$beta_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+-beta\.[0-9]+$ ]]; then
  release_fail "beta version must look like 2026.318.1-beta.0, got: $beta_version"
fi

beta_tag="beta/v${beta_version}"
if ! git -C "$repo_dir" rev-parse --verify "refs/tags/${beta_tag}" >/dev/null 2>&1; then
  release_fail "beta tag ${beta_tag} does not exist. Draft notes are generated from a published beta."
fi
source_sha="$(git -C "$repo_dir" rev-parse "${beta_tag}^{commit}")"

if [ -z "$out_file" ]; then
  out_file="${repo_dir}/releases/beta/v${beta_version}.md"
fi

# Range start: the newest stable tag reachable from the source commit —
# not the newest by version, which can sit on a divergent lineage (a
# stable cut from a candidate branch, or a source that predates it) and
# would produce an empty or wrong range. Before the first reachable
# stable, fall back to the nearest beta tag strictly before the source;
# with no marker at all, cover the source commit's full history.
range_start="$(git -C "$repo_dir" describe --tags --match 'v[0-9]*' --abbrev=0 "$source_sha" 2>/dev/null || true)"
range_label="$range_start"
if [ -z "$range_start" ]; then
  range_start="$(git -C "$repo_dir" describe --tags --match 'beta/v*' --abbrev=0 "${source_sha}^" 2>/dev/null || true)"
  range_label="$range_start"
fi
if [ -n "$range_start" ]; then
  range="${range_start}..${source_sha}"
else
  range="$source_sha"
  range_label="the beginning of history"
  release_info "No stable or prior beta tag found; drafting from full history."
fi

subjects="$(git -C "$repo_dir" log --no-merges --format='%s' "$range")"

section() {
  local title="$1" pattern="$2" invert="${3:-false}" body
  if [ "$invert" = true ]; then
    body="$(printf '%s\n' "$subjects" | grep -Ev "$pattern" || true)"
  else
    body="$(printf '%s\n' "$subjects" | grep -E "$pattern" || true)"
  fi
  [ -n "$body" ] || return 0
  printf '## %s\n\n' "$title"
  printf '%s\n' "$body" | sed 's/^/- /'
  printf '\n'
}

conventional='^(feat|fix)(\([^)]*\))?!?: '
mkdir -p "$(dirname "$out_file")"
{
  printf '# Paperclip stable draft — from beta %s\n\n' "$beta_version"
  printf '> Auto-generated at beta publish from `git log %s..%s`.\n' "${range_label}" "${source_sha:0:9}"
  printf '> Edit freely during the soak: rewrite for release-notes voice,\n'
  printf '> fold noise, and call out anything a self-hoster must act on.\n'
  printf '> The stable promotion reads this file from master and publishes\n'
  printf '> it as the GitHub Release body under the stable version.\n\n'
  section 'Features' '^feat(\([^)]*\))?!?: '
  section 'Fixes' '^fix(\([^)]*\))?!?: '
  section 'Other changes' "$conventional" true
} > "$out_file"

release_info "Draft stable notes written to $out_file"
release_info "  Source beta: $beta_version ($source_sha)"
release_info "  Range start: $range_label"
