#!/usr/bin/env bash
set -euo pipefail
: "${RUNNER_TEMP:?RUNNER_TEMP must select an isolated test directory}"
: "${GITHUB_PATH:?GITHUB_PATH must select the CI path file}"
version=2.1.207
prefix="$RUNNER_TEMP/paperclip-claude-cli"
bin_dir="$RUNNER_TEMP/paperclip-claude-bin"
npm install --prefix "$prefix" --cache "$RUNNER_TEMP/paperclip-claude-npm-cache"   --omit=dev --ignore-scripts --no-audit --no-fund "@anthropic-ai/claude-code@$version"
launcher="$prefix/node_modules/@anthropic-ai/claude-code/cli-wrapper.cjs"
chmod +x "$launcher"
mkdir -p "$bin_dir"
ln -sf "$launcher" "$bin_dir/claude"
actual="$("$bin_dir/claude" --version)"
if [ "$actual" != "$version (Claude Code)" ]; then
  printf 'Unexpected Claude CLI version: %s\n' "$actual" >&2
  exit 1
fi
printf '%s\n' "$bin_dir" >> "$GITHUB_PATH"
printf '%s\n' "$actual"
