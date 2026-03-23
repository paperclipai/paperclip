#!/usr/bin/env bash
set -euo pipefail

base_cwd="${PAPERCLIP_WORKSPACE_BASE_CWD:?PAPERCLIP_WORKSPACE_BASE_CWD is required}"
worktree_cwd="${PAPERCLIP_WORKSPACE_CWD:?PAPERCLIP_WORKSPACE_CWD is required}"

if [[ ! -d "$base_cwd" ]]; then
  echo "Base workspace does not exist: $base_cwd" >&2
  exit 1
fi

if [[ ! -d "$worktree_cwd" ]]; then
  echo "Derived worktree does not exist: $worktree_cwd" >&2
  exit 1
fi

while IFS= read -r relative_path; do
  [[ -n "$relative_path" ]] || continue
  source_path="$base_cwd/$relative_path"
  target_path="$worktree_cwd/$relative_path"

  [[ -d "$source_path" ]] || continue
  [[ -e "$target_path" || -L "$target_path" ]] && continue

  mkdir -p "$(dirname "$target_path")"
  ln -s "$source_path" "$target_path"
done < <(
  cd "$base_cwd" &&
    find . \
      -mindepth 1 \
      -maxdepth 3 \
      -type d \
      -name node_modules \
      ! -path './.git/*' \
      ! -path './.paperclip/*' \
      | sed 's#^\./##'
)
