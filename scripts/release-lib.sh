#!/usr/bin/env bash

if [ -z "${REPO_ROOT:-}" ]; then
  REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

release_info() {
  echo "$@"
}

release_warn() {
  echo "Warning: $*" >&2
}

release_fail() {
  echo "Error: $*" >&2
  exit 1
}

git_remote_exists() {
  git -C "$REPO_ROOT" remote get-url "$1" >/dev/null 2>&1
}

github_repo_from_remote() {
  local remote_url

  remote_url="$(git -C "$REPO_ROOT" remote get-url "$1" 2>/dev/null || true)"
  [ -n "$remote_url" ] || return 1

  remote_url="${remote_url%.git}"
  remote_url="${remote_url#ssh://}"

  node - "$remote_url" <<'NODE'
const remoteUrl = process.argv[2];

const patterns = [
  /^https?:\/\/github\.com\/([^/]+\/[^/]+)$/,
  /^git@github\.com:([^/]+\/[^/]+)$/,
  /^[^:]+:([^/]+\/[^/]+)$/
];

for (const pattern of patterns) {
  const match = remoteUrl.match(pattern);
  if (!match) continue;
  process.stdout.write(match[1]);
  process.exit(0);
}

process.exit(1);
NODE
}

resolve_release_remote() {
  local remote="${RELEASE_REMOTE:-${PUBLISH_REMOTE:-}}"

  if [ -n "$remote" ]; then
    git_remote_exists "$remote" || release_fail "git remote '$remote' does not exist."
    printf '%s\n' "$remote"
    return
  fi

  if git_remote_exists public-gh; then
    printf 'public-gh\n'
    return
  fi

  if git_remote_exists origin; then
    printf 'origin\n'
    return
  fi

  release_fail "no git remote found. Configure RELEASE_REMOTE or PUBLISH_REMOTE."
}

fetch_release_remote() {
  git -C "$REPO_ROOT" fetch "$1" --prune --tags
}

get_last_stable_tag() {
  git -C "$REPO_ROOT" tag --list 'v*' --sort=-version:refname | head -1
}

get_current_stable_version() {
  local tag
  tag="$(get_last_stable_tag)"
  if [ -z "$tag" ]; then
    printf '0.0.0\n'
  else
    printf '%s\n' "${tag#v}"
  fi
}

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

release_branch_name() {
  printf 'release/%s\n' "$1"
}

release_notes_file() {
  printf '%s/releases/v%s.md\n' "$REPO_ROOT" "$1"
}

default_release_worktree_path() {
  local version="$1"
  local parent_dir
  local repo_name

  parent_dir="$(cd "$REPO_ROOT/.." && pwd)"
  repo_name="$(basename "$REPO_ROOT")"
  printf '%s/%s-release-%s\n' "$parent_dir" "$repo_name" "$version"
}

git_current_branch() {
  git -C "$REPO_ROOT" symbolic-ref --quiet --short HEAD 2>/dev/null || true
}

git_local_branch_exists() {
  git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$1"
}

git_remote_branch_exists() {
  git -C "$REPO_ROOT" ls-remote --exit-code --heads "$2" "refs/heads/$1" >/dev/null 2>&1
}

git_local_tag_exists() {
  git -C "$REPO_ROOT" show-ref --verify --quiet "refs/tags/$1"
}

git_remote_tag_exists() {
  git -C "$REPO_ROOT" ls-remote --exit-code --tags "$2" "refs/tags/$1" >/dev/null 2>&1
}

npm_version_exists() {
  local version="$1"
  local resolved

  resolved="$(npm view "paperclipai@${version}" version 2>/dev/null || true)"
  [ "$resolved" = "$version" ]
}

require_clean_worktree() {
  if [ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]; then
    release_fail "working tree is not clean. Commit, stash, or remove changes before releasing."
  fi
}

git_worktree_path_for_branch() {
  local branch_ref="refs/heads/$1"

  git -C "$REPO_ROOT" worktree list --porcelain | awk -v branch_ref="$branch_ref" '
    $1 == "worktree" { path = substr($0, 10) }
    $1 == "branch" && $2 == branch_ref { print path; exit }
  '
}

path_is_worktree_for_branch() {
  local path="$1"
  local branch="$2"
  local current_branch

  [ -d "$path" ] || return 1
  current_branch="$(git -C "$path" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  [ "$current_branch" = "$branch" ]
}

ensure_release_branch_for_version() {
  local stable_version="$1"
  local current_branch
  local expected_branch

  current_branch="$(git_current_branch)"
  expected_branch="$(release_branch_name "$stable_version")"

  if [ -z "$current_branch" ]; then
    release_fail "release work must run from branch $expected_branch, but HEAD is detached."
  fi

  if [ "$current_branch" != "$expected_branch" ]; then
    release_fail "release work must run from branch $expected_branch, but current branch is $current_branch."
  fi
}

stable_release_exists_anywhere() {
  local stable_version="$1"
  local remote="$2"
  local tag="v$stable_version"

  git_local_tag_exists "$tag" || git_remote_tag_exists "$tag" "$remote" || npm_version_exists "$stable_version"
}

release_train_is_frozen() {
  stable_release_exists_anywhere "$1" "$2"
}
