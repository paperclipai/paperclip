#!/usr/bin/env bash
set -euo pipefail
file=$(jq -r '.tool_input.file_path // ""')
# Only format JS/TS/JSON/CSS files
if echo "$file" | grep -qiE '\.(tsx?|jsx?|json|css|scss|md)$'; then
  cd "$(dirname "$0")/../.."
  npx prettier --write "$file" 2>/dev/null || true
fi
exit 0
