#!/usr/bin/env bash
set -euo pipefail

# Harness runner: execute a scoped agent task in an isolated context.
#
# Usage:
#   scripts/harness/run-agent-task.sh [--collect-artifacts] [--worktree] -- <command...>
#
# Options:
#   --collect-artifacts   Run artifact collection after task completes
#   --worktree            Run in a git worktree (isolated workspace)
#   --help                Show this help
#
# Examples:
#   scripts/harness/run-agent-task.sh -- pnpm test:run
#   scripts/harness/run-agent-task.sh --collect-artifacts -- pnpm test:run
#   pnpm harness:run -- pnpm test:run

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
ARTIFACTS_DIR="$ROOT_DIR/.harness-artifacts"
RUN_ID="$(date +%Y%m%d-%H%M%S)-$(git rev-parse --short HEAD 2>/dev/null || echo 'nosha')"
COLLECT_ARTIFACTS=false
USE_WORKTREE=false

show_help() {
  sed -n '/^# Usage:/,/^$/p' "$0" | sed 's/^# //' | sed 's/^#//'
  echo ""
  echo "Environment variables:"
  echo "  HARNESS_ARTIFACTS_DIR   Override artifacts directory (default: .harness-artifacts)"
  echo "  HARNESS_RUN_ID          Override run ID (default: timestamp-sha)"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --collect-artifacts)
      COLLECT_ARTIFACTS=true
      shift
      ;;
    --worktree)
      USE_WORKTREE=true
      shift
      ;;
    --help|-h)
      show_help
      exit 0
      ;;
    --)
      shift
      break
      ;;
    *)
      break
      ;;
  esac
done

if [[ $# -eq 0 ]]; then
  echo "Error: no command specified. Usage: $0 [options] -- <command...>"
  echo "Run '$0 --help' for usage."
  exit 1
fi

# Override from env
ARTIFACTS_DIR="${HARNESS_ARTIFACTS_DIR:-$ARTIFACTS_DIR}"
RUN_ID="${HARNESS_RUN_ID:-$RUN_ID}"
RUN_ARTIFACTS="$ARTIFACTS_DIR/$RUN_ID"

echo "=== Harness Run: $RUN_ID ==="
echo "Command: $*"
echo "Artifacts: $RUN_ARTIFACTS"
echo ""

mkdir -p "$RUN_ARTIFACTS"

# Record metadata
cat > "$RUN_ARTIFACTS/metadata.json" <<METAEOF
{
  "run_id": "$RUN_ID",
  "command": "$*",
  "git_sha": "$(git rev-parse HEAD 2>/dev/null || echo 'unknown')",
  "git_branch": "$(git branch --show-current 2>/dev/null || echo 'unknown')",
  "started_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "node_version": "$(node --version 2>/dev/null || echo 'unknown')",
  "cwd": "$ROOT_DIR"
}
METAEOF

# Run the command, capturing stdout/stderr
EXIT_CODE=0
"$@" > >(tee "$RUN_ARTIFACTS/stdout.log") 2> >(tee "$RUN_ARTIFACTS/stderr.log" >&2) || EXIT_CODE=$?

# Record result
cat > "$RUN_ARTIFACTS/result.json" <<RESULTEOF
{
  "exit_code": $EXIT_CODE,
  "finished_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "success": $([ $EXIT_CODE -eq 0 ] && echo true || echo false)
}
RESULTEOF

if [[ "$COLLECT_ARTIFACTS" == "true" ]]; then
  echo ""
  echo "=== Collecting artifacts ==="
  "$SCRIPT_DIR/collect-artifacts.sh" "$RUN_ARTIFACTS"
fi

echo ""
if [[ $EXIT_CODE -eq 0 ]]; then
  echo "=== Harness Run PASSED ==="
else
  echo "=== Harness Run FAILED (exit code: $EXIT_CODE) ==="
fi
echo "Artifacts saved to: $RUN_ARTIFACTS"

exit $EXIT_CODE
