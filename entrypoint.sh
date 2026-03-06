#!/bin/bash
set -euo pipefail

# ANTHROPIC_SETUP_TOKEN is passed directly as an env var — no file injection needed.
# The claude CLI picks it up natively.

# Inject Codex/OpenAI subscription credentials
if [[ -n "${CODEX_CREDENTIALS:-}" ]]; then
  mkdir -p /paperclip/.codex
  echo "$CODEX_CREDENTIALS" > /paperclip/.codex/credentials.json
  echo "[entrypoint] Codex credentials written to /paperclip/.codex/credentials.json"
fi

# Authenticate gh CLI with the GitHub token
# Unset GITHUB_TOKEN before calling gh auth login so gh doesn't refuse to store
# credentials (gh exits non-zero when GITHUB_TOKEN env var is present).
if [[ -n "${GITHUB_TOKEN:-}" ]]; then
  _gh_token="$GITHUB_TOKEN"
  unset GITHUB_TOKEN
  echo "$_gh_token" | gh auth login --with-token
  echo "[entrypoint] gh CLI authenticated"
fi

exec node --import ./server/node_modules/tsx/dist/loader.mjs server/dist/index.js
