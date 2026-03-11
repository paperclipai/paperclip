#!/usr/bin/env bash
set -euo pipefail

# Collect harness artifacts after a run.
# Called by run-agent-task.sh with --collect-artifacts flag.
#
# Usage: collect-artifacts.sh <artifacts-dir>

ARTIFACTS_DIR="${1:?Usage: collect-artifacts.sh <artifacts-dir>}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "Collecting artifacts to $ARTIFACTS_DIR"

# 1. Copy test results if they exist
if [[ -d "$ROOT_DIR/tests/e2e/test-results" ]]; then
  cp -r "$ROOT_DIR/tests/e2e/test-results" "$ARTIFACTS_DIR/e2e-test-results" 2>/dev/null || true
  echo "  - Collected e2e test results"
fi

if [[ -d "$ROOT_DIR/tests/e2e/playwright-report" ]]; then
  cp -r "$ROOT_DIR/tests/e2e/playwright-report" "$ARTIFACTS_DIR/playwright-report" 2>/dev/null || true
  echo "  - Collected Playwright report"
fi

# 2. Capture git status
git -C "$ROOT_DIR" status --short > "$ARTIFACTS_DIR/git-status.txt" 2>/dev/null || true
git -C "$ROOT_DIR" diff --stat > "$ARTIFACTS_DIR/git-diff-stat.txt" 2>/dev/null || true
echo "  - Captured git status"

# 3. Capture dependency state
if [[ -f "$ROOT_DIR/pnpm-lock.yaml" ]]; then
  echo "  - pnpm-lock.yaml exists (not copied — use git for diff)"
fi

# 4. Capture failing test output (vitest produces to stdout already captured)
echo "  - stdout.log and stderr.log already captured by runner"

echo "Artifact collection complete."
