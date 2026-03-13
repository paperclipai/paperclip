#!/bin/bash
set -e

# Fix volume ownership (runs as root initially)
chown -R paperclip:paperclip /paperclip

# ---------------------------------------------------------------------------
# Claude OAuth credential provisioning
#
# Supports three layers (highest priority wins):
#   1. Per-agent override:  CLAUDE_OAUTH_AGENT_<agent_id_underscored>
#   2. Per-company token:   CLAUDE_OAUTH_COMPANY_<company_id_underscored>
#      (auto-resolved via DB — any new agent in that company gets it)
#   3. Global default:      CLAUDE_OAUTH_TOKEN
# ---------------------------------------------------------------------------

write_creds() {
  local DIR="$1" TOKEN="$2"
  mkdir -p "$DIR/.claude"
  cat > "$DIR/.claude/.credentials.json" <<EOF
{"claudeAiOauth":{"accessToken":"$TOKEN","refreshToken":"","expiresAt":4102444800000,"scopes":["user:inference","user:profile","user:sessions:claude_code"]}}
EOF
  chown -R paperclip:paperclip "$DIR"
  chmod 600 "$DIR/.claude/.credentials.json"
}

# 1. Write global default credentials
if [ -n "$CLAUDE_OAUTH_TOKEN" ]; then
  write_creds /paperclip "$CLAUDE_OAUTH_TOKEN"
  echo "[entrypoint] Global Claude OAuth credentials configured"
fi

# 2. Build company→token map from CLAUDE_OAUTH_COMPANY_* env vars
declare -A COMPANY_TOKENS
for var in $(env | grep -oP '^CLAUDE_OAUTH_COMPANY_[^=]+'); do
  TOKEN="${!var}"
  COMPANY_ID=$(echo "$var" | sed 's/^CLAUDE_OAUTH_COMPANY_//' | tr '_' '-')
  if [ -n "$TOKEN" ] && [ -n "$COMPANY_ID" ]; then
    COMPANY_TOKENS["$COMPANY_ID"]="$TOKEN"
    echo "[entrypoint] Company $COMPANY_ID has dedicated OAuth token"
  fi
done

# 3. Query DB for all agents and their company IDs, set up HOME + credentials
if [ -n "$DATABASE_URL" ] || [ -n "$POSTGRES_URL" ]; then
  DB_URL="${DATABASE_URL:-$POSTGRES_URL}"
  echo "[entrypoint] Querying DB for agent→company mapping..."

  AGENT_ROWS=$(psql "$DB_URL" -t -A -F'|' -c "SELECT a.id, a.company_id FROM agents a;" 2>/dev/null || true)

  if [ -n "$AGENT_ROWS" ]; then
    while IFS='|' read -r AGENT_ID COMPANY_ID; do
      [ -z "$AGENT_ID" ] && continue
      AGENT_HOME="/paperclip/agent-homes/$AGENT_ID"

      # Check per-agent override first
      AGENT_VAR="CLAUDE_OAUTH_AGENT_$(echo "$AGENT_ID" | tr '-' '_')"
      AGENT_TOKEN="${!AGENT_VAR}"

      if [ -n "$AGENT_TOKEN" ]; then
        write_creds "$AGENT_HOME" "$AGENT_TOKEN"
        echo "[entrypoint] Agent $AGENT_ID → per-agent OAuth"
      elif [ -n "${COMPANY_TOKENS[$COMPANY_ID]+x}" ]; then
        write_creds "$AGENT_HOME" "${COMPANY_TOKENS[$COMPANY_ID]}"
        echo "[entrypoint] Agent $AGENT_ID → company $COMPANY_ID OAuth"
      elif [ -n "$CLAUDE_OAUTH_TOKEN" ]; then
        write_creds "$AGENT_HOME" "$CLAUDE_OAUTH_TOKEN"
        echo "[entrypoint] Agent $AGENT_ID → global OAuth"
      fi

      # Ensure agent has HOME in adapter_config
      psql "$DB_URL" -c "
        UPDATE agents
        SET adapter_config = jsonb_set(
          COALESCE(adapter_config, '{}'::jsonb),
          '{env,HOME}',
          '\"$AGENT_HOME\"'::jsonb
        )
        WHERE id = '$AGENT_ID'
        AND (adapter_config->'env'->>'HOME' IS NULL OR adapter_config->'env'->>'HOME' != '$AGENT_HOME');
      " 2>/dev/null || true

    done <<< "$AGENT_ROWS"
    echo "[entrypoint] All agents provisioned"
  else
    echo "[entrypoint] WARNING: Could not query agents from DB"
  fi
else
  echo "[entrypoint] WARNING: No DATABASE_URL — falling back to env-var-only provisioning"

  # Fallback: per-agent env vars
  for var in $(env | grep -oP '^CLAUDE_OAUTH_AGENT_[^=]+'); do
    TOKEN="${!var}"
    AGENT_ID=$(echo "$var" | sed 's/^CLAUDE_OAUTH_AGENT_//' | tr '_' '-')
    if [ -n "$TOKEN" ] && [ -n "$AGENT_ID" ]; then
      write_creds "/paperclip/agent-homes/$AGENT_ID" "$TOKEN"
      echo "[entrypoint] Agent $AGENT_ID → per-agent OAuth (no DB)"
    fi
  done

  # Fallback: PAPERCLIP_AGENT_HOMES list
  if [ -n "$CLAUDE_OAUTH_TOKEN" ] && [ -n "$PAPERCLIP_AGENT_HOMES" ]; then
    IFS=',' read -ra AGENT_IDS <<< "$PAPERCLIP_AGENT_HOMES"
    for AGENT_ID in "${AGENT_IDS[@]}"; do
      AGENT_HOME="/paperclip/agent-homes/$AGENT_ID"
      if [ ! -f "$AGENT_HOME/.claude/.credentials.json" ]; then
        write_creds "$AGENT_HOME" "$CLAUDE_OAUTH_TOKEN"
        echo "[entrypoint] Agent $AGENT_ID → global OAuth (no DB)"
      fi
    done
  fi
fi

# Telegram notifications (optional)
# TELEGRAM_BOT_TOKEN  — Bot API token from @BotFather
# TELEGRAM_CHAT_ID    — Chat/group ID to send notifications to

# Start Qwen proxy in background (if API key is configured)
if [ -n "$QWEN_API_KEY" ]; then
  echo "[entrypoint] Starting Qwen proxy on port ${QWEN_PROXY_PORT:-3199}..."
  gosu paperclip node /app/qwen-proxy.mjs &
fi

# Switch to paperclip user and start server
exec gosu paperclip node --import ./server/node_modules/tsx/dist/loader.mjs server/dist/index.js
