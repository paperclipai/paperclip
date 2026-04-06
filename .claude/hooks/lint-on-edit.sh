#!/usr/bin/env bash
set -euo pipefail
file=$(jq -r '.tool_input.file_path // ""')
# Only lint TS/JS files
if echo "$file" | grep -qiE '\.(tsx?|jsx?)$'; then
  cd "$(dirname "$0")/../.."
  npx eslint --fix "$file" 2>&1 | tail -10 || true
fi
exit 0
