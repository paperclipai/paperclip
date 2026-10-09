#!/usr/bin/env bash
set -euo pipefail

test "$(id -u)" = "1000"
test "$(id -g)" = "1000"
test ! -w /
test -w /tmp

for command_name in git gh jq node npm rg just kustomize yq ruby opencode; do
  command -v "$command_name" >/dev/null
done

tini --version >/dev/null
opencode --version >/dev/null
mkdir -p "$XDG_CACHE_HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME"
printf 'TOOL_PROBE=PASS\n'
