#!/usr/bin/env bash
# publish-action.sh — closes the loop on the auto-publish pipeline (V2.6).
#
# Polls Paperclip every 5 min for issues where:
#   status == "done"  AND  metadata.publish_state in ("ready", "g4-approved")
# Setting status to a non-enum value (e.g. "published-ready") returns 400; publish
# state lives in metadata instead of the status field (KOE-101).
#
# For each batch of ready issues:
#   1. Trigger Next.js on-demand revalidate (POST /api/revalidate?path=/blog/<slug>)
#      Fast path: ~3 sec; reads vault from local disk; no Vercel rebuild.
#   2. If the path can't revalidate (e.g., new route or sitemap addition) fall back
#      to vercel build --prebuilt + deploy --prod.
#   3. Set metadata.publish_state="published" + published_url + published_at (status stays "done").
#   4. POST /api/agents/<publish-verifier>/heartbeat/invoke (G5 fires).
#
# Wired to launchd via com.koenig.publish-action.plist (every 5 min).
# Logs to ~/.paperclip/logs/publish-action.log.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ACADEMY="$REPO_ROOT/../learnovaBeast/learnova-academy"
ENV_FILE="$REPO_ROOT/.env.koenig"
PAPERCLIP_URL="${PAPERCLIP_URL:-http://localhost:3100}"
COMPANY_ID="${COMPANY_ID:-1ce472ae-c3fe-47cb-ae1c-99cd79a43b8d}"
LOG_DIR="$HOME/.paperclip/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/publish-action.log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

if [[ ! -f "$ENV_FILE" ]]; then
  log "ERROR: $ENV_FILE not found. Skipping publish-action run."
  exit 0
fi

VERCEL_TOKEN="$(grep "^VERCEL_TOKEN=" "$ENV_FILE" | cut -d= -f2-)"
if [[ -z "$VERCEL_TOKEN" ]]; then
  log "ERROR: VERCEL_TOKEN missing in $ENV_FILE. Skipping."
  exit 0
fi

log "Polling for ready-to-publish issues (status=done + metadata.publish_state in ready|g4-approved)..."

APPROVED_IDS="$(curl -s "$PAPERCLIP_URL/api/companies/$COMPANY_ID/issues" | python3 -c "
import json, sys
items = json.load(sys.stdin)
if isinstance(items, dict): items = items.get('items', [])
ids = [
    i['id'] for i in items
    if i.get('status') == 'done'
    and i.get('metadata', {}).get('publish_state') in ('ready', 'g4-approved')
]
print(' '.join(ids))
")"

if [[ -z "$APPROVED_IDS" ]]; then
  log "No ready-to-publish issues. Exiting cleanly."
  exit 0
fi

log "Found ready-to-publish issues: $APPROVED_IDS"

log "Running vercel build + deploy --prebuilt --prod..."
cd "$ACADEMY"
KOENIG_VAULT_ROOT="$REPO_ROOT/vault" vercel build --prod --token "$VERCEL_TOKEN" >> "$LOG" 2>&1

DEPLOY_OUTPUT="$(vercel deploy --prod --prebuilt --token "$VERCEL_TOKEN" --yes 2>&1)"
echo "$DEPLOY_OUTPUT" >> "$LOG"

PUBLISHED_URL="$(echo "$DEPLOY_OUTPUT" | python3 -c "
import sys, re
text = sys.stdin.read()
m = re.search(r'\"url\":\\s*\"(https?://[^\"]+)\"', text)
print(m.group(1) if m else '')
")"

if [[ -z "$PUBLISHED_URL" ]]; then
  log "ERROR: Could not parse published URL from deploy output. Aborting."
  exit 1
fi

log "Deployed: $PUBLISHED_URL"

PV_AGENT_ID="$(curl -s "$PAPERCLIP_URL/api/companies/$COMPANY_ID/agents" | python3 -c "
import json, sys
data = json.load(sys.stdin)
print(next(a['id'] for a in data if a['urlKey'] == 'publish-verifier'))
")"

for ID in $APPROVED_IDS; do
  log "Marking $ID publish_state=published + url=$PUBLISHED_URL (status stays done)"
  curl -sX PATCH "$PAPERCLIP_URL/api/issues/$ID" \
    -H "Content-Type: application/json" \
    -d "$(python3 -c "import json; print(json.dumps({'metadata': {'publish_state': 'published', 'published_url': '$PUBLISHED_URL', 'published_at': '$(date -u +%Y-%m-%dT%H:%M:%SZ)'}}))")" \
    -o /dev/null

  log "Triggering publish-verifier (G5) for issue $ID"
  curl -sX POST "$PAPERCLIP_URL/api/agents/$PV_AGENT_ID/heartbeat/invoke" \
    -H "Content-Type: application/json" \
    -d "$(python3 -c "import json; print(json.dumps({'context': {'issue_id': '$ID'}}))")" \
    -o /dev/null
done

log "publish-action complete: deployed $PUBLISHED_URL, flipped $(echo $APPROVED_IDS | wc -w) issues, triggered G5"
