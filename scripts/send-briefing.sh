#!/usr/bin/env bash
set -euo pipefail

BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-${BOT_TOKEN:-}}"
CHAT_ID="${JEFF_TELEGRAM_CHAT_ID:-${CHAT_ID:-}}"

if [[ -z "$BOT_TOKEN" || -z "$CHAT_ID" ]]; then
  echo "ERROR: TELEGRAM_BOT_TOKEN and JEFF_TELEGRAM_CHAT_ID are required." >&2
  exit 1
fi

BRIEFING="${BRIEFING_TEXT:-}"
if [[ -z "$BRIEFING" ]]; then
  BRIEFING=$(cat)
fi

if [[ -z "$BRIEFING" ]]; then
  echo "ERROR: No briefing text provided (stdin or BRIEFING_TEXT env var)." >&2
  exit 1
fi

TIMESTAMP=$(TZ='America/Chicago' date '+%B %-d, %Y, %-I:%M %p Central')
BODY=$(cat <<EOF
{
  "chat_id": $CHAT_ID,
  "text": "📋 *Daily Executive Briefing*\n\n${BRIEFING}\n\n_Generated: ${TIMESTAMP}_",
  "parse_mode": "Markdown",
  "disable_web_page_preview": true
}
EOF
)

URL="https://api.telegram.org/bot${BOT_TOKEN}/sendMessage"
RESPONSE=$(curl -s -w "\n%{http_code}" --max-time 30 -X POST "$URL" \
  -H "Content-Type: application/json" \
  -d "$BODY" 2>&1)

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY_RESP=$(echo "$RESPONSE" | sed '$d')

if [[ "$HTTP_CODE" != "200" ]]; then
  echo "ERROR: Telegram API returned HTTP $HTTP_CODE" >&2
  echo "$BODY_RESP" >&2
  exit 1
fi

echo "Briefing delivered to Telegram (chat_id=$CHAT_ID)."
