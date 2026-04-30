#!/bin/bash
# Wrapper for launchd — sources .env.koenig so PAPERCLIP_API_KEY stays out of the plist.
set -e

REPO="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$REPO/.env.koenig"

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

export PAPERCLIP_HOST="${PAPERCLIP_HOST:-http://localhost:3100}"
export KOENIG_COMPANY_ID="${KOENIG_COMPANY_ID:-2a77f89b-33f0-4133-a20c-77ddaac5e744}"
export WATCHDOG_INTERVAL_MS="${WATCHDOG_INTERVAL_MS:-600000}"

NODE="$HOME/.nvm/versions/node/v24.14.1/bin/node"
[ -x "$NODE" ] || NODE="$(which node)"

exec "$NODE" "$REPO/watchdog/watchdog.mjs"
