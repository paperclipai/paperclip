#!/usr/bin/env bash
# Lean typecheck — runs a package's typecheck and prints only the tsc error
# lines (files with TSxxxx), plus a count. Strips the build-tool noise that
# precedes tsc output.
#
# Usage:  scripts/lean-typecheck.sh <pnpm-filter>
#   e.g.  scripts/lean-typecheck.sh @paperclipai/server
#
# Honors LEAN_MAX_LINES (default 60).
set -uo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MAX_LINES="${LEAN_MAX_LINES:-60}"

if [[ $# -lt 1 ]]; then
  echo "lean-typecheck: missing <pnpm-filter> (e.g. @paperclipai/server)." >&2
  exit 2
fi
FILTER="$1"; shift

RAW="$( cd "$ROOT_DIR" && pnpm --filter "$FILTER" typecheck 2>&1 )"
STATUS=$?

# tsc errors look like `path/file.ts(12,5): error TS2345: ...` or
# `path/file.ts:12:5 - error TS2345: ...`. Keep only those lines.
ERRORS="$(printf '%s\n' "$RAW" | grep -E 'error TS[0-9]+' || true)"

if [[ -z "$ERRORS" ]]; then
  if [[ $STATUS -eq 0 ]]; then
    echo "✓ typecheck clean ($FILTER)"
  else
    # Non-tsc failure (build dep, config) — surface the tail so it's debuggable.
    echo "✗ typecheck failed before tsc ($FILTER, exit $STATUS):"
    printf '%s\n' "$RAW" | tail -n 15
  fi
  exit "$STATUS"
fi

COUNT="$(printf '%s\n' "$ERRORS" | wc -l | tr -d ' ')"
printf '%s\n' "$ERRORS" | head -n "$MAX_LINES"
echo ""
echo "$COUNT type error(s)"
exit "$STATUS"
