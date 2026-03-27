#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="${1:-$PWD}"
CANONICAL_URL="${2:-}"

if [[ ! -d "$ROOT_DIR" ]]; then
  echo "Root directory does not exist: $ROOT_DIR" >&2
  exit 1
fi

if [[ -z "$CANONICAL_URL" ]]; then
  echo "Usage: $0 <root-dir> <canonical-origin-url>" >&2
  exit 1
fi

find_git_entries() {
  find "$ROOT_DIR" \( -type d -name .git -o -type f -name .git \) -print | sort
}

printf 'repo_path\tgit_common_dir\told_origin_url\tnew_origin_url\taction\n'

while IFS= read -r git_entry; do
  repo_dir="$(dirname "$git_entry")"

  if ! git -C "$repo_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    continue
  fi

  common_dir="$(git -C "$repo_dir" rev-parse --git-common-dir)"
  origin_url="$(git -C "$repo_dir" config --get remote.origin.url || true)"

  if [[ -z "$origin_url" ]]; then
    printf '%s\t%s\t%s\t%s\tskip_missing_origin\n' \
      "$repo_dir" "$common_dir" "$origin_url" "$CANONICAL_URL"
    continue
  fi

  if [[ "$origin_url" == "$CANONICAL_URL" ]]; then
    printf '%s\t%s\t%s\t%s\tskip_already_canonical\n' \
      "$repo_dir" "$common_dir" "$origin_url" "$CANONICAL_URL"
    continue
  fi

  if [[ "$origin_url" =~ ^https:// ]] || [[ "$origin_url" =~ ^git@ ]] || [[ "$origin_url" =~ ^ssh:// ]]; then
    printf '%s\t%s\t%s\t%s\tskip_hosted_origin\n' \
      "$repo_dir" "$common_dir" "$origin_url" "$CANONICAL_URL"
    continue
  fi

  git -C "$repo_dir" remote set-url origin "$CANONICAL_URL"
  printf '%s\t%s\t%s\t%s\tupdated\n' \
    "$repo_dir" "$common_dir" "$origin_url" "$CANONICAL_URL"
done < <(find_git_entries)
