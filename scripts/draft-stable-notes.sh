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
source_short="$(git -C "$repo_dir" rev-parse --short "$source_sha")"

if [ -z "$out_file" ]; then
  out_file="${repo_dir}/releases/beta/v${beta_version}.md"
fi

# Range start: walk stable tags newest-first and take the first whose
# merge-base with the source is a proper ancestor of the source. A stable
# cut from a candidate branch is not itself an ancestor of master, but
# its merge-base with the source is the promoted source commit — exactly
# the point the shipped stable's content diverges from. A stable that
# already contains the source (promoting an older commit) is skipped so
# the range never collapses to empty. Before the first stable, fall back
# to the nearest beta tag strictly before the source; with no marker at
# all, cover the source commit's full history.
range_start=""
range_label=""
range_cmd_start=""
while IFS= read -r stable_tag; do
  [ -n "$stable_tag" ] || continue
  mb="$(git -C "$repo_dir" merge-base "$stable_tag" "$source_sha" 2>/dev/null || true)"
  [ -n "$mb" ] || continue
  if [ "$mb" != "$source_sha" ]; then
    range_start="$mb"
    if [ "$mb" = "$(git -C "$repo_dir" rev-parse "${stable_tag}^{commit}")" ]; then
      range_label="$stable_tag"
      range_cmd_start="$stable_tag"
    else
      # rev-parse --short picks an abbreviation that is unambiguous in
      # this repository, unlike a fixed nine-character truncation.
      mb_short="$(git -C "$repo_dir" rev-parse --short "$mb")"
      range_label="${stable_tag} (merge-base ${mb_short})"
      range_cmd_start="$mb_short"
    fi
    break
  fi
done < <(git -C "$repo_dir" tag -l 'v[0-9]*' --sort=-v:refname)
if [ -z "$range_start" ]; then
  range_start="$(git -C "$repo_dir" describe --tags --match 'beta/v*' --abbrev=0 "${source_sha}^" 2>/dev/null || true)"
  range_label="$range_start"
  range_cmd_start="$range_start"
fi
if [ -n "$range_start" ]; then
  range="${range_start}..${source_sha}"
else
  range="$source_sha"
  range_label="the beginning of history"
  range_cmd_start="the beginning of history"
  release_info "No stable or prior beta tag found; drafting from full history."
fi

subjects="$(git -C "$repo_dir" log --no-merges --format='%s' "$range")"

# Best-effort thoroughness: nest each referenced PR's own summary under its
# subject line, so the skeleton is a genuinely thorough raw document at
# creation time instead of a bare commit list. Prefers the PR template's
# "What Changed" bullets, falls back to the first prose lines. Degrades
# silently when gh or the network is unavailable (tests, offline runs);
# set DRAFT_NOTES_SKIP_PR_ENRICHMENT=1 to disable explicitly.
enrich_pr() {
  local pr_num="$1" pr_body excerpt
  [ "${DRAFT_NOTES_SKIP_PR_ENRICHMENT:-0}" = "1" ] && return 0
  pr_body="$(cd "$repo_dir" && gh pr view "$pr_num" --json body --jq .body 2>/dev/null || true)"
  [ -n "$pr_body" ] || return 0
  if printf '%s\n' "$pr_body" | grep -q '^## What Changed'; then
    excerpt="$(printf '%s\n' "$pr_body" | sed -n '/^## What Changed/,/^## /p' | grep -E '^- ' | head -3 || true)"
  else
    excerpt="$(printf '%s\n' "$pr_body" | grep -vE '^[[:space:]]*$|^#|^>|^<!--' | head -2 || true)"
  fi
  [ -n "$excerpt" ] || return 0
  printf '%s\n' "$excerpt" | sed 's/^/  > /'
}

section() {
  local title="$1" pattern="$2" invert="${3:-false}" body
  if [ "$invert" = true ]; then
    body="$(printf '%s\n' "$subjects" | grep -Ev "$pattern" || true)"
  else
    body="$(printf '%s\n' "$subjects" | grep -E "$pattern" || true)"
  fi
  [ -n "$body" ] || return 0
  printf '## %s\n\n' "$title"
  while IFS= read -r subject_line; do
    [ -n "$subject_line" ] || continue
    printf -- '- %s\n' "$subject_line"
    pr_ref="$(printf '%s' "$subject_line" | grep -oE '\(#[0-9]+\)$' | tr -dc '0-9' || true)"
    if [ -n "$pr_ref" ]; then
      enrich_pr "$pr_ref"
    fi
  done <<< "$body"
  printf '\n'
}

conventional='^(feat|fix)(\([^)]*\))?!?: '
mkdir -p "$(dirname "$out_file")"
{
  printf '# Paperclip stable draft — from beta %s\n\n' "$beta_version"
  printf '> Auto-generated at beta publish from `git log %s..%s` (baseline: %s).\n' "${range_cmd_start}" "${source_short}" "${range_label}"
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
