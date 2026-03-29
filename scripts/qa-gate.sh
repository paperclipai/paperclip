#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CANDIDATE_REF="HEAD"
REPORT_FILE="$REPO_ROOT/report/qa-verification-substrate.json"

usage() {
  cat <<'USAGE'
Usage:
  ./scripts/qa-gate.sh [--candidate-ref <git-ref>] [--report-file <path>]

Examples:
  ./scripts/qa-gate.sh
  ./scripts/qa-gate.sh --candidate-ref origin/master
  ./scripts/qa-gate.sh --candidate-ref 64fae79c --report-file report/cmp-253-qa.json
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --candidate-ref)
      shift
      [ $# -gt 0 ] || {
        echo "Error: --candidate-ref requires a git ref or commit." >&2
        exit 1
      }
      CANDIDATE_REF="$1"
      ;;
    --report-file)
      shift
      [ $# -gt 0 ] || {
        echo "Error: --report-file requires a path." >&2
        exit 1
      }
      REPORT_FILE="$1"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Error: unexpected argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

node "$REPO_ROOT/scripts/candidate-gate-runner.mjs" \
  --repo-root "$REPO_ROOT" \
  --candidate-ref "$CANDIDATE_REF" \
  --report-file "$REPORT_FILE" \
  --command "pnpm test" \
  --command "pnpm test:run -- server/src/__tests__/paperclip-skill-utils.test.ts" \
  --command "pnpm test:release-smoke -- --list"
