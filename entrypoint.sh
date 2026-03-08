#!/bin/bash
set -e

# Fix volume ownership (runs as root initially)
chown -R paperclip:paperclip /paperclip

# Write per-agent Claude OAuth credentials
# Env vars: CLAUDE_OAUTH_TOKEN (global default)
#           CLAUDE_OAUTH_TOKEN_<AGENT_ID_UNDERSCORED> (per-agent override)
# Agent HOME dirs are at /paperclip/agent-homes/<agent-id>/

# Write global default credentials
if [ -n "$CLAUDE_OAUTH_TOKEN" ]; then
  mkdir -p /paperclip/.claude
  cat > /paperclip/.claude/.credentials.json <<EOF
{"claudeAiOauth":{"accessToken":"$CLAUDE_OAUTH_TOKEN","refreshToken":"","expiresAt":4102444800000,"scopes":["user:inference","user:profile","user:sessions:claude_code"]}}
EOF
  chown paperclip:paperclip /paperclip/.claude/.credentials.json
  chmod 600 /paperclip/.claude/.credentials.json
  echo "[entrypoint] Global Claude OAuth credentials configured"
fi

# Write per-agent credentials (CLAUDE_OAUTH_TOKEN_<id-with-underscores>)
for var in $(env | grep -oP '^CLAUDE_OAUTH_AGENT_[^=]+'); do
  TOKEN="${!var}"
  AGENT_ID=$(echo "$var" | sed 's/^CLAUDE_OAUTH_AGENT_//' | tr '_' '-')
  if [ -n "$TOKEN" ] && [ -n "$AGENT_ID" ]; then
    AGENT_HOME="/paperclip/agent-homes/$AGENT_ID"
    mkdir -p "$AGENT_HOME/.claude"
    cat > "$AGENT_HOME/.claude/.credentials.json" <<EOF
{"claudeAiOauth":{"accessToken":"$TOKEN","refreshToken":"","expiresAt":4102444800000,"scopes":["user:inference","user:profile","user:sessions:claude_code"]}}
EOF
    chown -R paperclip:paperclip "$AGENT_HOME"
    chmod 600 "$AGENT_HOME/.claude/.credentials.json"
    echo "[entrypoint] Agent $AGENT_ID OAuth credentials configured at $AGENT_HOME"
  fi
done

# Also create agent homes for all known IDs that use global token as fallback
if [ -n "$CLAUDE_OAUTH_TOKEN" ] && [ -n "$PAPERCLIP_AGENT_HOMES" ]; then
  IFS=',' read -ra AGENT_IDS <<< "$PAPERCLIP_AGENT_HOMES"
  for AGENT_ID in "${AGENT_IDS[@]}"; do
    AGENT_HOME="/paperclip/agent-homes/$AGENT_ID"
    if [ ! -f "$AGENT_HOME/.claude/.credentials.json" ]; then
      mkdir -p "$AGENT_HOME/.claude"
      cp /paperclip/.claude/.credentials.json "$AGENT_HOME/.claude/.credentials.json"
      chown -R paperclip:paperclip "$AGENT_HOME"
      chmod 600 "$AGENT_HOME/.claude/.credentials.json"
      echo "[entrypoint] Agent $AGENT_ID using global OAuth (HOME=$AGENT_HOME)"
    fi
  done
fi

# Switch to paperclip user and start server
exec gosu paperclip node --import ./server/node_modules/tsx/dist/loader.mjs server/dist/index.js
