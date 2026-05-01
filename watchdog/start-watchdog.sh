#!/bin/bash
# Wrapper for launchd — sources .env.koenig so PAPERCLIP_API_KEY stays out of the plist.
#
# 2026-05-01: hardened against launchd env quirks
#   - launchd does not set $HOME for LaunchAgents in some macOS versions; fall back
#     to the absolute path so the absolute nvm node binary still resolves.
#   - explicit error path on missing node so logs are written before exit.
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

# Fallback when launchd doesn't propagate HOME.
HOME_DIR="${HOME:-/Users/vardaankoenig}"

NODE="$HOME_DIR/.nvm/versions/node/v24.14.1/bin/node"
if [ ! -x "$NODE" ]; then
  if command -v node >/dev/null 2>&1; then
    NODE="$(command -v node)"
  else
    echo "[start-watchdog] ERROR: cannot locate node binary (HOME=$HOME_DIR PATH=$PATH)" >&2
    exit 1
  fi
fi

exec "$NODE" "$REPO/watchdog/watchdog.mjs"
