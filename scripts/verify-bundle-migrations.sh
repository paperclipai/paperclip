#!/usr/bin/env bash
#
# Verify no stale Pipedream MCP references remain in agent bundles after
# the 2026-04-24 Composio migration. Composio replaced Pipedream as the
# gateway for Apollo, Lusha, Pipedrive, GSC, and GA4 — bundles that still
# reference `mcp__pipedream__*` slugs or "via Pipedream MCP" headings will
# fail because those MCP servers no longer exist in `~/.gemini/settings.json`.
#
# Usage: scripts/verify-bundle-migrations.sh [path...]
#   With no args, scans the current working directory.
#   Each path may be a directory (scanned recursively for TOOLS.md /
#   HEARTBEAT.md) or a specific file.
#
# Exit codes:
#   0 — no stale references found
#   1 — at least one bundle still references Pipedream
#
# Designed for use as a pre-commit hook or local check in agent-bundle
# repositories (e.g. extremesolution/p-extremesolution, jigawattcorp/paper-naya).
set -euo pipefail

declare -a TARGETS=()
if [ "$#" -eq 0 ]; then
  TARGETS=(".")
else
  TARGETS=("$@")
fi

PATTERN='mcp__pipedream__|mcp__pd__|via Pipedream MCP'
fail=0
files_scanned=0

scan_file() {
  local f="$1"
  files_scanned=$((files_scanned + 1))
  if grep -qE "$PATTERN" "$f" 2>/dev/null; then
    echo "FAIL: $f still references Pipedream MCP" >&2
    grep -nE "$PATTERN" "$f" >&2 | head -10
    fail=1
  fi
}

for target in "${TARGETS[@]}"; do
  if [ -f "$target" ]; then
    scan_file "$target"
  elif [ -d "$target" ]; then
    while IFS= read -r -d '' f; do
      scan_file "$f"
    done < <(find "$target" \( -name 'TOOLS.md' -o -name 'HEARTBEAT.md' \) -not -path '*/node_modules/*' -not -path '*/.git/*' -print0 2>/dev/null)
  else
    echo "WARN: $target is not a file or directory; skipping" >&2
  fi
done

if [ "$fail" -eq 0 ]; then
  echo "OK: scanned $files_scanned bundle file(s); no stale Pipedream references found." >&2
fi

exit $fail
