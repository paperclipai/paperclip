#!/usr/bin/env bash
set -euo pipefail

# Show what a control-plane checkout will actually run on next restart, and
# compare it against the last state recorded by scripts/deploy/mark-deploy.sh.
#
# Exists to make "service runs something other than what was intended" loud
# instead of silent (TWX-1314) — e.g. a hotfix committed on a feature branch
# while the checkout has since been switched to an unrelated sync branch that
# doesn't contain it.
#
# Usage:
#   ./scripts/deploy/check-deploy-state.sh            # print status, warn on drift
#   ./scripts/deploy/check-deploy-state.sh --enforce   # exit non-zero on drift
#
# Safe to wire into a restart unit as a non-blocking pre-check:
#   ExecStartPre=-/path/to/check-deploy-state.sh
# (the leading "-" keeps a non-zero exit from blocking the restart; the
# warning still lands in the journal).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$PROJECT_ROOT"

ENFORCE=0
if [ "${1:-}" = "--enforce" ]; then
  ENFORCE=1
fi

GIT_DIR="$(git rev-parse --git-dir)"
MARKER_FILE="$GIT_DIR/deploy-marker"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
SHA="$(git rev-parse HEAD)"
DIRTY="clean"
if [ -n "$(git status --porcelain)" ]; then
  DIRTY="dirty"
fi

echo "RUNNING TREE : $PROJECT_ROOT"
echo "  branch     : $BRANCH"
echo "  HEAD       : $SHA"
echo "  tree state : $DIRTY"

if [ ! -f "$MARKER_FILE" ]; then
  echo "EXPECTED     : no deploy marker found — nobody has run mark-deploy.sh here yet" >&2
  echo "STATUS       : UNKNOWN (cannot confirm this is the intended deploy)" >&2
  [ "$ENFORCE" = "1" ] && exit 1 || exit 0
fi

# shellcheck disable=SC1090
EXP_BRANCH=""
EXP_SHA=""
EXP_DIRTY=""
EXP_MARKED_AT=""
EXP_MARKED_BY=""
EXP_NOTE=""
while IFS='=' read -r key value; do
  case "$key" in
    branch) EXP_BRANCH="$value" ;;
    sha) EXP_SHA="$value" ;;
    dirty) EXP_DIRTY="$value" ;;
    marked_at) EXP_MARKED_AT="$value" ;;
    marked_by) EXP_MARKED_BY="$value" ;;
    note) EXP_NOTE="$value" ;;
  esac
done < "$MARKER_FILE"

echo "EXPECTED     : $EXP_BRANCH@${EXP_SHA:0:12} ($EXP_DIRTY) — marked $EXP_MARKED_AT by $EXP_MARKED_BY${EXP_NOTE:+ (\"$EXP_NOTE\")}"

if [ "$SHA" = "$EXP_SHA" ] && [ "$DIRTY" = "$EXP_DIRTY" ]; then
  echo "STATUS       : OK — matches last marked deploy state"
  exit 0
fi

echo "STATUS       : DRIFT — running tree does not match the last marked deploy state" >&2
if [ "$BRANCH" != "$EXP_BRANCH" ]; then
  echo "  branch changed: $EXP_BRANCH -> $BRANCH" >&2
fi
if [ "$SHA" != "$EXP_SHA" ]; then
  if git merge-base --is-ancestor "$EXP_SHA" "$SHA" 2>/dev/null; then
    echo "  HEAD moved forward from the marked commit (contains it, plus more)" >&2
  else
    echo "  HEAD does NOT contain the marked commit $EXP_SHA — a believed-deployed commit may be missing" >&2
  fi
fi
if [ "$DIRTY" != "$EXP_DIRTY" ]; then
  echo "  tree state changed: $EXP_DIRTY -> $DIRTY" >&2
fi

[ "$ENFORCE" = "1" ] && exit 1 || exit 0
