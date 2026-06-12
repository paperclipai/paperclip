#!/usr/bin/env bash
# Lean test runner — runs vitest for ONE package and prints only failures
# (file · test · first error lines) plus a pass/fail tally. Token-economy
# wrapper for dev agents: never dump a full green test log into context.
#
# Usage:  scripts/lean-test.sh <pnpm-filter> [vitest args...]
#   e.g.  scripts/lean-test.sh @paperclipai/server
#         scripts/lean-test.sh @paperclipai/server src/services/__tests__/plan-gates.test.ts
#         scripts/lean-test.sh @paperclipai/ui src/lib/blockedInbox.test.ts
#
# Honors LEAN_MAX_LINES (default 60) as a hard cap on emitted lines.
set -uo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MAX_LINES="${LEAN_MAX_LINES:-60}"

if [[ $# -lt 1 ]]; then
  echo "lean-test: missing <pnpm-filter> (e.g. @paperclipai/server)." >&2
  exit 2
fi
FILTER="$1"; shift

JSON_OUT="$(mktemp -t lean-test-XXXXXX.json)"
trap 'rm -f "$JSON_OUT"' EXIT

( cd "$ROOT_DIR" && pnpm --filter "$FILTER" exec vitest run \
    --reporter=json --outputFile="$JSON_OUT" "$@" ) >/dev/null 2>&1
RUN_STATUS=$?

if [[ ! -s "$JSON_OUT" ]]; then
  echo "lean-test: no JSON report produced (run failed before tests — exit $RUN_STATUS)."
  echo "Re-run 'pnpm --filter $FILTER exec vitest run $*' to see the bootstrap error."
  exit "${RUN_STATUS:-1}"
fi

node "$ROOT_DIR/scripts/lean-report.mjs" test "$JSON_OUT" "$MAX_LINES"
exit "$RUN_STATUS"
