#!/usr/bin/env bash
set -euo pipefail

BASE_REF="origin/master"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base)
      BASE_REF="${2:-}"
      shift 2
      ;;
    -h|--help)
      cat <<'USAGE'
Usage: scripts/check-pr-publication-readiness.sh [--base <base-ref>]

Print a PR publication preflight summary. Use this before pushing a branch or
opening a PR from reviewed local changes.
USAGE
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$BASE_REF" ]]; then
  echo "--base requires a non-empty ref" >&2
  exit 2
fi

if ! git rev-parse --show-toplevel >/dev/null 2>&1; then
  echo "Not inside a git repository" >&2
  exit 2
fi

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

if ! git rev-parse --verify "$BASE_REF^{commit}" >/dev/null 2>&1; then
  echo "Base ref not found: $BASE_REF" >&2
  echo "Fetch the base ref first, then rerun this check." >&2
  exit 2
fi

CURRENT_BRANCH="$(git branch --show-current || true)"
HEAD_SHA="$(git rev-parse --short HEAD)"
AHEAD_COUNT="$(git rev-list --count "$BASE_REF"..HEAD)"

echo "PR publication readiness"
echo "repo: $ROOT"
echo "branch: ${CURRENT_BRANCH:-detached}"
echo "head: $HEAD_SHA"
echo "base: $BASE_REF"
echo "commits_ahead_of_base: $AHEAD_COUNT"
echo

echo "status:"
git status --short
echo

echo "commits:"
git log --oneline "$BASE_REF"..HEAD || true
echo

echo "tracked_diff_files:"
git diff --name-only "$BASE_REF"...HEAD
echo

echo "working_tree_diff_files:"
git diff --name-only
echo

echo "untracked_files:"
git ls-files --others --exclude-standard
echo

if git status --porcelain | grep -q .; then
  echo "RESULT: review_required"
  echo "Reason: working tree is not clean. Verify every listed file is intended before pushing."
else
  echo "RESULT: clean"
fi
