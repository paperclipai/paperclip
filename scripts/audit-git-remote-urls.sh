#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="${1:-$PWD}"

if [[ ! -d "$ROOT_DIR" ]]; then
  echo "Root directory does not exist: $ROOT_DIR" >&2
  exit 1
fi

classify_origin() {
  local url="$1"

  if [[ -z "$url" ]]; then
    printf 'missing'
    return
  fi

  if [[ "$url" =~ ^https:// ]] || [[ "$url" =~ ^git@ ]] || [[ "$url" =~ ^ssh:// ]]; then
    printf 'hosted'
    return
  fi

  if [[ "$url" =~ ^/ ]] || [[ "$url" =~ ^\.\.?/ ]]; then
    printf 'local_path'
    return
  fi

  printf 'other'
}

find_git_entries() {
  find "$ROOT_DIR" \( -type d -name .git -o -type f -name .git \) -print | sort
}

printf 'repo_path\tgit_common_dir\torigin_url\torigin_kind\n'

while IFS= read -r git_entry; do
  repo_dir="$(dirname "$git_entry")"

  if ! git -C "$repo_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    continue
  fi

  common_dir="$(git -C "$repo_dir" rev-parse --git-common-dir)"
  origin_url="$(git -C "$repo_dir" config --get remote.origin.url || true)"
  origin_kind="$(classify_origin "$origin_url")"

  printf '%s\t%s\t%s\t%s\n' "$repo_dir" "$common_dir" "$origin_url" "$origin_kind"
done < <(find_git_entries)
