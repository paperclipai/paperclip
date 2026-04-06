#!/usr/bin/env bash
set -euo pipefail
file=$(jq -r '.tool_input.file_path // ""')
# Only run tests for source files
if echo "$file" | grep -qiE '\.(tsx?|jsx?)$'; then
  cd "$(dirname "$0")/../.."
  # Run related tests only, not full suite
  npx vitest related "$file" --run 2>&1 | tail -20 || true
fi
exit 0
