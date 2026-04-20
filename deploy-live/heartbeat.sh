#!/bin/bash
# Heartbeat watchdog — run via crontab every 2 minutes
# */2 * * * * /app/heartbeat.sh

HEARTBEAT_FILE="${DATA_DIR:-/app/data}/heartbeat"
BOT_TOKEN="${TELEGRAM_BOT_TOKEN}"
CHAT_ID="${TELEGRAM_CHAT_ID}"
MAX_AGE=180  # 3 minutes

if [ ! -f "$HEARTBEAT_FILE" ]; then
    curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
        -d "chat_id=${CHAT_ID}" \
        -d "text=🚨 REAL TRADER HEARTBEAT MISSING — bot may be crashed" \
        -d "parse_mode=Markdown" > /dev/null
    exit 1
fi

LAST=$(cat "$HEARTBEAT_FILE")
NOW=$(date +%s)
AGE=$((NOW - ${LAST%.*}))

if [ "$AGE" -gt "$MAX_AGE" ]; then
    curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
        -d "chat_id=${CHAT_ID}" \
        -d "text=🚨 REAL TRADER HEARTBEAT STALE (${AGE}s) — bot may be stuck" \
        -d "parse_mode=Markdown" > /dev/null
fi
