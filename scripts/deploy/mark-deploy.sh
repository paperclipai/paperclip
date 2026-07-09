#!/usr/bin/env bash
set -euo pipefail

# Record "what is intentionally running" for a control-plane checkout, so
# scripts/deploy/check-deploy-state.sh can later tell a deliberate deploy
# apart from silent branch/dirty-tree drift.
#
# Run this every time you intentionally switch the branch/commit that a
# control-plane instance (e.g. paperclip.service on vd-fw) should run.
#
# Usage:
#   ./scripts/deploy/mark-deploy.sh [note]
#
# Writes <repo>/.git/deploy-marker (untracked, host-local — never committed).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$PROJECT_ROOT"

GIT_DIR="$(git rev-parse --git-dir)"
MARKER_FILE="$GIT_DIR/deploy-marker"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
SHA="$(git rev-parse HEAD)"
DIRTY="clean"
if [ -n "$(git status --porcelain)" ]; then
  DIRTY="dirty"
fi
NOTE="${1:-}"
TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
OPERATOR="${USER:-unknown}"

{
  echo "branch=$BRANCH"
  echo "sha=$SHA"
  echo "dirty=$DIRTY"
  echo "marked_at=$TIMESTAMP"
  echo "marked_by=$OPERATOR"
  echo "note=$NOTE"
} > "$MARKER_FILE"

echo "Marked deploy state: $BRANCH@${SHA:0:12} ($DIRTY) at $TIMESTAMP"
if [ "$DIRTY" = "dirty" ]; then
  echo "WARNING: tree is dirty — this is now the acknowledged 'intended' state, uncommitted changes and all." >&2
fi
