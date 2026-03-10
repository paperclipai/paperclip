#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=./release-lib.sh
. "$REPO_ROOT/scripts/release-lib.sh"

dry_run=false
push_branch=true
bump_type=""
worktree_path=""

usage() {
  cat <<'EOF'
Usage:
  ./scripts/release-start.sh <patch|minor|major> [--dry-run] [--no-push] [--worktree-dir PATH]

Examples:
  ./scripts/release-start.sh patch
  ./scripts/release-start.sh minor --dry-run
  ./scripts/release-start.sh major --worktree-dir ../paperclip-release-1.0.0

What it does:
  - fetches the release remote and tags
  - computes the next stable version from the latest stable tag
  - creates or resumes branch release/X.Y.Z
  - creates or resumes a dedicated worktree for that branch
  - pushes the release branch to the remote by default

Notes:
  - Stable publishes freeze a release train. If vX.Y.Z already exists locally,
    remotely, or on npm, this script refuses to reuse release/X.Y.Z.
  - Use --no-push only if you intentionally do not want the release branch on
    GitHub yet.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry_run=true ;;
    --no-push) push_branch=false ;;
    --worktree-dir)
      shift
      [ $# -gt 0 ] || release_fail "--worktree-dir requires a path."
      worktree_path="$1"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [ -n "$bump_type" ]; then
        release_fail "only one bump type may be provided."
      fi
      bump_type="$1"
      ;;
  esac
  shift
done

if [[ ! "$bump_type" =~ ^(patch|minor|major)$ ]]; then
  usage
  exit 1
fi

release_remote="$(resolve_release_remote)"
fetch_release_remote "$release_remote"

last_stable_tag="$(get_last_stable_tag)"
current_stable_version="$(get_current_stable_version)"
target_stable_version="$(compute_bumped_version "$current_stable_version" "$bump_type")"
target_canary_version="$(next_canary_version "$target_stable_version")"
release_branch="$(release_branch_name "$target_stable_version")"
release_tag="v$target_stable_version"

if [ -z "$worktree_path" ]; then
  worktree_path="$(default_release_worktree_path "$target_stable_version")"
fi

if stable_release_exists_anywhere "$target_stable_version" "$release_remote"; then
  release_fail "release train $release_branch is frozen because $release_tag already exists locally, remotely, or version $target_stable_version is already on npm."
fi

branch_exists_local=false
branch_exists_remote=false
branch_worktree_path=""
created_worktree=false
created_branch=false
pushed_branch=false

if git_local_branch_exists "$release_branch"; then
  branch_exists_local=true
fi

if git_remote_branch_exists "$release_branch" "$release_remote"; then
  branch_exists_remote=true
fi

branch_worktree_path="$(git_worktree_path_for_branch "$release_branch")"
if [ -n "$branch_worktree_path" ]; then
  worktree_path="$branch_worktree_path"
fi

if [ -e "$worktree_path" ] && ! path_is_worktree_for_branch "$worktree_path" "$release_branch"; then
  release_fail "path $worktree_path already exists and is not a worktree for $release_branch."
fi

if [ -z "$branch_worktree_path" ]; then
  if [ "$dry_run" = true ]; then
    if [ "$branch_exists_local" = true ] || [ "$branch_exists_remote" = true ]; then
      release_info "[dry-run] Would add worktree $worktree_path for existing branch $release_branch"
    else
      release_info "[dry-run] Would create branch $release_branch from $release_remote/master"
      release_info "[dry-run] Would add worktree $worktree_path"
    fi
  else
    if [ "$branch_exists_local" = true ]; then
      git -C "$REPO_ROOT" worktree add "$worktree_path" "$release_branch"
    elif [ "$branch_exists_remote" = true ]; then
      git -C "$REPO_ROOT" branch --track "$release_branch" "$release_remote/$release_branch"
      git -C "$REPO_ROOT" worktree add "$worktree_path" "$release_branch"
      created_branch=true
    else
      git -C "$REPO_ROOT" worktree add -b "$release_branch" "$worktree_path" "$release_remote/master"
      created_branch=true
    fi
    created_worktree=true
  fi
fi

if [ "$dry_run" = false ] && [ "$push_branch" = true ] && [ "$branch_exists_remote" = false ]; then
  git -C "$worktree_path" push -u "$release_remote" "$release_branch"
  pushed_branch=true
fi

if [ "$dry_run" = false ] && [ "$branch_exists_remote" = true ]; then
  git -C "$worktree_path" branch --set-upstream-to "$release_remote/$release_branch" "$release_branch" >/dev/null 2>&1 || true
fi

release_info ""
release_info "==> Release train"
release_info "  Remote: $release_remote"
release_info "  Last stable tag: ${last_stable_tag:-<none>}"
release_info "  Current stable version: $current_stable_version"
release_info "  Bump: $bump_type"
release_info "  Target stable version: $target_stable_version"
release_info "  Next canary version: $target_canary_version"
release_info "  Branch: $release_branch"
release_info "  Tag (reserved until stable publish): $release_tag"
release_info "  Worktree: $worktree_path"
release_info "  Release notes path: $worktree_path/releases/v${target_stable_version}.md"

release_info ""
release_info "==> Status"
if [ -n "$branch_worktree_path" ]; then
  release_info "  ✓ Reusing existing worktree for $release_branch"
elif [ "$dry_run" = true ]; then
  release_info "  ✓ Dry run only; no branch or worktree created"
else
  [ "$created_branch" = true ] && release_info "  ✓ Created branch $release_branch"
  [ "$created_worktree" = true ] && release_info "  ✓ Created worktree $worktree_path"
fi

if [ "$branch_exists_remote" = true ]; then
  release_info "  ✓ Remote branch already exists on $release_remote"
elif [ "$dry_run" = true ] && [ "$push_branch" = true ]; then
  release_info "  [dry-run] Would push $release_branch to $release_remote"
elif [ "$push_branch" = true ] && [ "$pushed_branch" = true ]; then
  release_info "  ✓ Pushed $release_branch to $release_remote"
elif [ "$push_branch" = false ]; then
  release_warn "release branch was not pushed. Stable publish will later refuse until the branch exists on $release_remote."
fi

release_info ""
release_info "Next steps:"
release_info "  cd $worktree_path"
release_info "  Draft or update releases/v${target_stable_version}.md"
release_info "  ./scripts/release-preflight.sh canary $bump_type"
release_info "  ./scripts/release.sh $bump_type --canary"
release_info ""
release_info "Merge rule:"
release_info "  Merge $release_branch back to master without squash or rebase so tag $release_tag remains reachable from master."
