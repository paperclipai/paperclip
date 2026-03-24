#!/bin/bash
# SENTINEL GPS Scraper Gap Check
# Deploy to: /home/nail/sentinel/scraper-check.sh
# Cron: */10 * * * * /home/nail/sentinel/scraper-check.sh

set -euo pipefail

WEBHOOK_URL="${SENTINEL_WEBHOOK:-https://nail.n8n.evohaus.org/webhook/sentinel-alert}"
MAX_GAP_MINUTES=30
TIMESTAMP=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
LOG_DIR="/home/nail/sentinel/logs"
mkdir -p "$LOG_DIR"

echo "[$TIMESTAMP] SENTINEL Scraper Gap Check Starting..."

# Query Supabase for last data per provider
# Adjust the docker exec command based on your actual Supabase container name
SUPABASE_DB_CONTAINER="${SUPABASE_DB_CONTAINER:-supabase-db-sw8g8cgs0kkco04kgwowcogw}"
RESULT=$(docker exec "$SUPABASE_DB_CONTAINER" psql -U postgres -d postgres -t -A -F '|' -c "
SELECT
  provider_id as provider,
  COALESCE(TO_CHAR(MAX(created_at), 'YYYY-MM-DD HH24:MI:SS'), 'NO DATA') as last_data,
  COALESCE(EXTRACT(EPOCH FROM (NOW() - MAX(created_at)))/60, 99999)::int as gap_minutes
FROM navico.gps_buddy_data
GROUP BY provider_id
ORDER BY gap_minutes DESC;
" 2>/dev/null) || {
  echo "[$TIMESTAMP] ERROR: Could not query Supabase"
  curl -s -X POST "$WEBHOOK_URL" \
    -H "Content-Type: application/json" \
    -d "{
      \"type\": \"sentinel_scraper_check\",
      \"machine\": \"vps\",
      \"severity\": \"critical\",
      \"finding\": \"Cannot connect to Supabase to check scraper gaps\",
      \"timestamp\": \"$TIMESTAMP\"
    }" 2>/dev/null
  exit 1
}

ALERTS=""
ALL_OK=true

while IFS='|' read -r provider last_data gap_minutes; do
  # Skip empty lines
  [ -z "$provider" ] && continue
  
  # Clean whitespace
  provider=$(echo "$provider" | xargs)
  gap_minutes=$(echo "$gap_minutes" | xargs)
  
  if [ "$gap_minutes" -gt "$MAX_GAP_MINUTES" ]; then
    ALL_OK=false
    ALERTS="$ALERTS\n🔴 $provider: ${gap_minutes}min gap (last: $last_data)"
    echo "[$TIMESTAMP] ALERT: $provider gap=${gap_minutes}min (max=${MAX_GAP_MINUTES}min)"
  else
    echo "[$TIMESTAMP] OK: $provider gap=${gap_minutes}min"
  fi
done <<< "$RESULT"

# Log
echo "[$TIMESTAMP] Scraper check complete. All OK: $ALL_OK" >> "$LOG_DIR/scraper.log"

# Alert if any gaps found
if [ "$ALL_OK" = false ]; then
  ALERT_TEXT=$(echo -e "$ALERTS")
  curl -s -X POST "$WEBHOOK_URL" \
    -H "Content-Type: application/json" \
    -d "{
      \"type\": \"sentinel_scraper_gap\",
      \"machine\": \"vps\",
      \"severity\": \"critical\",
      \"finding\": \"GPS scraper gaps detected: $ALERT_TEXT\",
      \"max_gap_minutes\": $MAX_GAP_MINUTES,
      \"timestamp\": \"$TIMESTAMP\"
    }" 2>/dev/null || echo "WARNING: Failed to send alert"
  
  echo "[$TIMESTAMP] CRITICAL: Scraper gaps detected!"
else
  echo "[$TIMESTAMP] All scrapers within SLA (${MAX_GAP_MINUTES}min)"
fi
