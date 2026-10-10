#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

WEBHOOK_URL="${DISCORD_WEBHOOK_URL:-}"
DATE="${1:-$(date +%Y-%m-%d)}"
REPO_URL="https://github.com/paperclipai/paperclip"

if [[ -z "$WEBHOOK_URL" ]]; then
  echo "Error: DISCORD_WEBHOOK_URL env var is required" >&2
  echo "Usage: DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/... $0 [date]" >&2
  echo "  date defaults to today (YYYY-MM-DD format)" >&2
  exit 1
fi

NEXT_DATE=$(date -j -v+1d -f "%Y-%m-%d" "$DATE" "+%Y-%m-%d" 2>/dev/null \
  || date -d "$DATE + 1 day" "+%Y-%m-%d" 2>/dev/null)

COMMITS=$(git log --since="${DATE}T00:00:00" --until="${NEXT_DATE}T00:00:00" master \
  --format="%h|%s|%an" 2>/dev/null || true)

json_escape() {
  python3 -c 'import json, sys; print(json.dumps(sys.stdin.read().rstrip("\n"))[1:-1])'
}
if [[ -z "$COMMITS" ]]; then
  PAYLOAD=$(cat <<ENDJSON
{
  "embeds": [{
    "title": "📋 Daily Merge Digest — ${DATE}",
    "description": "No commits were merged into \`master\` today.",
    "color": 9807270
  }]
}
ENDJSON
)
else
  COMMIT_COUNT=$(echo "$COMMITS" | wc -l | tr -d ' ')

  LINES=""
  while IFS='|' read -r hash subject author; do
    escaped_subject=$(printf '%s' "$subject" | json_escape)
    escaped_author=$(printf '%s' "$author" | json_escape)
    LINES="${LINES}• [\`${hash}\`](${REPO_URL}/commit/${hash}) ${escaped_subject} — *${escaped_author}*\\n"
  done <<< "$COMMITS"

  PAYLOAD=$(cat <<ENDJSON
{
  "embeds": [{
    "title": "📋 Daily Merge Digest — ${DATE}",
    "description": "**${COMMIT_COUNT} commit(s)** merged into \`master\` today:\\n\\n${LINES}",
    "color": 3066993,
    "footer": {
      "text": "paperclipai/paperclip • master"
    }
  }]
}
ENDJSON
)
fi

if [[ "${DRY_RUN:-}" == "1" ]]; then
  echo "$PAYLOAD" | python3 -m json.tool 2>/dev/null || echo "$PAYLOAD"
  exit 0
fi

RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  "$WEBHOOK_URL")

if [[ "$RESPONSE" == "204" || "$RESPONSE" == "200" ]]; then
  echo "Discord digest posted for ${DATE} (${COMMIT_COUNT:-0} commits)"
else
  echo "Error: Discord webhook returned HTTP ${RESPONSE}" >&2
  exit 1
fi
