#!/bin/bash
# wake-triage.sh — wake the triage-agent every 30 min if there's backlog work.
# Skips the wake if the queue has zero backlog items (saves Sonnet tokens).
#
# Wired via com.koenig.triage.plist (StartInterval=1800).

set -euo pipefail

PAPERCLIP_URL="${PAPERCLIP_URL:-http://localhost:3100}"
COMPANY_ID="${COMPANY_ID:-2a77f89b-33f0-4133-a20c-77ddaac5e744}"
LOG_DIR="$HOME/.paperclip/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/triage.stdout.log"

# Find triage-agent's id (handles both 'triage' and 'triage-agent' slugs)
TRIAGE_ID="$(curl -s "$PAPERCLIP_URL/api/companies/$COMPANY_ID/agents" 2>/dev/null \
  | /opt/homebrew/bin/python3.12 -c "
import json, sys
agents = json.load(sys.stdin)
agents = agents if isinstance(agents, list) else agents.get('items', [])
for a in agents:
    slug = a.get('urlKey') or ''
    if slug in ('triage', 'triage-agent'):
        print(a.get('id', ''))
        break
")"

if [[ -z "$TRIAGE_ID" ]]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] triage-agent not found in roster; skipping" >> "$LOG"
  exit 0
fi

# Count backlog items — skip wake if zero
BACKLOG_COUNT="$(curl -s "$PAPERCLIP_URL/api/companies/$COMPANY_ID/issues" 2>/dev/null \
  | /opt/homebrew/bin/python3.12 -c "
import json, sys
data = json.load(sys.stdin)
items = data if isinstance(data, list) else data.get('items', [])
print(sum(1 for i in items if i.get('status') == 'backlog'))
")"

if [[ "$BACKLOG_COUNT" -eq 0 ]]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] backlog empty; skipping triage wake (saves tokens)" >> "$LOG"
  exit 0
fi

# Fire the wake
RESPONSE="$(curl -s -X POST "$PAPERCLIP_URL/api/agents/$TRIAGE_ID/heartbeat/invoke" \
  -H 'Content-Type: application/json' \
  -d "{\"context\": {\"trigger\": \"cron-30min\", \"backlog_count\": $BACKLOG_COUNT}}" 2>&1)"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] backlog=$BACKLOG_COUNT triage_id=$TRIAGE_ID woke: $(echo "$RESPONSE" | head -c 200)" >> "$LOG"
