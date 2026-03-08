#!/bin/bash
set -e

# Write Claude OAuth credentials if provided
if [ -n "$CLAUDE_OAUTH_TOKEN" ]; then
  mkdir -p "$HOME/.claude"
  cat > "$HOME/.claude/.credentials.json" <<EOF
{"claudeAiOauth":{"accessToken":"$CLAUDE_OAUTH_TOKEN","refreshToken":"","expiresAt":4102444800000,"scopes":["user:inference","user:profile","user:sessions:claude_code"]}}
EOF
  chmod 600 "$HOME/.claude/.credentials.json"
  echo "[entrypoint] Claude OAuth credentials configured"
fi

# Start the server
exec node --import ./server/node_modules/tsx/dist/loader.mjs server/dist/index.js
