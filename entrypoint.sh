#!/bin/bash
set -e

# Fix volume ownership (runs as root initially)
chown -R paperclip:paperclip /paperclip

# Write Claude OAuth credentials if provided
if [ -n "$CLAUDE_OAUTH_TOKEN" ]; then
  mkdir -p /paperclip/.claude
  cat > /paperclip/.claude/.credentials.json <<EOF
{"claudeAiOauth":{"accessToken":"$CLAUDE_OAUTH_TOKEN","refreshToken":"","expiresAt":4102444800000,"scopes":["user:inference","user:profile","user:sessions:claude_code"]}}
EOF
  chown paperclip:paperclip /paperclip/.claude/.credentials.json
  chmod 600 /paperclip/.claude/.credentials.json
  echo "[entrypoint] Claude OAuth credentials configured"
fi

# Switch to paperclip user and start server
exec gosu paperclip node --import ./server/node_modules/tsx/dist/loader.mjs server/dist/index.js
