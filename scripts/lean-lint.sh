#!/usr/bin/env bash
# Lean lint — runs a package's lint and prints only error/warning lines plus a
# count, using eslint's compact-style output where available.
#
# Usage:  scripts/lean-lint.sh <pnpm-filter>
#   e.g.  scripts/lean-lint.sh @paperclipai/server
#
# Honors LEAN_MAX_LINES (default 60).
set -uo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MAX_LINES="${LEAN_MAX_LINES:-60}"

if [[ $# -lt 1 ]]; then
  echo "lean-lint: missing <pnpm-filter> (e.g. @paperclipai/server)." >&2
  exit 2
fi
FILTER="$1"; shift

RAW="$( cd "$ROOT_DIR" && pnpm --filter "$FILTER" lint 2>&1 )"
STATUS=$?

# Keep eslint problem lines (`  12:3  error  ...` / `... warning ...`) and the
# file headers that precede them; drop the run banner + summary fluff.
PROBLEMS="$(printf '%s\n' "$RAW" | grep -E '(error|warning)' | grep -vE '^\s*(>|pnpm|\$|ELIFECYCLE|npm error)' || true)"

if [[ -z "$PROBLEMS" ]]; then
  if [[ $STATUS -eq 0 ]]; then
    echo "✓ lint clean ($FILTER)"
  else
    echo "✗ lint failed before reporting ($FILTER, exit $STATUS):"
    printf '%s\n' "$RAW" | tail -n 15
  fi
  exit "$STATUS"
fi

COUNT="$(printf '%s\n' "$PROBLEMS" | wc -l | tr -d ' ')"
printf '%s\n' "$PROBLEMS" | head -n "$MAX_LINES"
echo ""
echo "$COUNT lint problem line(s)"
exit "$STATUS"
