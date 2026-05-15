#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

TELEGRAM_ALERTS_ENABLED="${TELEGRAM_ALERTS_ENABLED:-true}"
if [[ "$TELEGRAM_ALERTS_ENABLED" == "false" || "$TELEGRAM_ALERTS_ENABLED" == "0" ]]; then
  exit 0
fi

BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-${BOT_TOKEN:-}}"
CHAT_ID="${JEFF_TELEGRAM_CHAT_ID:-${CHAT_ID:-}}"

if [[ -z "$BOT_TOKEN" || -z "$CHAT_ID" ]]; then
  echo "ERROR: TELEGRAM_BOT_TOKEN (or BOT_TOKEN) and JEFF_TELEGRAM_CHAT_ID (or CHAT_ID) env vars are required." >&2
  echo "Set them in your environment or .env file." >&2
  exit 1
fi

if [[ -z "${PAPERCLIP_API_URL:-}" || -z "${PAPERCLIP_API_KEY:-}" || -z "${PAPERCLIP_COMPANY_ID:-}" ]]; then
  echo "ERROR: PAPERCLIP_API_URL, PAPERCLIP_API_KEY, and PAPERCLIP_COMPANY_ID are required." >&2
  exit 1
fi

TSX="$REPO_ROOT/cli/node_modules/.bin/tsx"
if [[ ! -x "$TSX" ]]; then
  echo "ERROR: tsx not found at $TSX" >&2
  exit 1
fi
exec "$TSX" "$REPO_ROOT/scripts/telegram-exec-alert/index.ts" "$@"
