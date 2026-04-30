#!/usr/bin/env bash
# Mint a 1-year watchdog JWT signed with BETTER_AUTH_SECRET.
# Updates PAPERCLIP_API_KEY in .env.koenig.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
ENV_APP="$REPO/../../../app/.env"
ENV_KOENIG="$REPO/.env.koenig"

BETTER_AUTH_SECRET=""
if [ -f "$ENV_APP" ]; then
  BETTER_AUTH_SECRET="$(grep '^BETTER_AUTH_SECRET=' "$ENV_APP" | cut -d= -f2-)"
fi
if [ -z "$BETTER_AUTH_SECRET" ] && [ -f "/app/.env" ]; then
  BETTER_AUTH_SECRET="$(grep '^BETTER_AUTH_SECRET=' /app/.env | cut -d= -f2-)"
fi
if [ -z "$BETTER_AUTH_SECRET" ]; then
  echo "ERROR: BETTER_AUTH_SECRET not found" >&2
  exit 1
fi

AGENT_ID="b90788a0-d3de-42da-8e77-7dc8f7c01fd3"
COMPANY_ID="2a77f89b-33f0-4133-a20c-77ddaac5e744"

TOKEN=$(node -e "
const crypto = require('crypto');
const secret = process.env.SECRET;
const now = Math.floor(Date.now()/1000);
const exp = now + 31536000;
const header = Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
const payload = Buffer.from(JSON.stringify({
  sub: '$AGENT_ID',
  company_id: '$COMPANY_ID',
  adapter_type: 'watchdog',
  run_id: 'watchdog-persistent-daemon',
  iat: now, exp, iss: 'paperclip', aud: 'paperclip-api'
})).toString('base64url');
const sig = crypto.createHmac('sha256', secret).update(header+'.'+payload).digest('base64url');
console.log(header+'.'+payload+'.'+sig);
" SECRET="$BETTER_AUTH_SECRET")

# Replace PAPERCLIP_API_KEY line in .env.koenig
if grep -q '^PAPERCLIP_API_KEY=' "$ENV_KOENIG"; then
  sed -i.bak "s|^PAPERCLIP_API_KEY=.*|PAPERCLIP_API_KEY=$TOKEN|" "$ENV_KOENIG" && rm -f "$ENV_KOENIG.bak"
else
  echo "PAPERCLIP_API_KEY=$TOKEN" >> "$ENV_KOENIG"
fi

echo "Token minted and written to .env.koenig"
echo "Reload launchd: launchctl unload ~/Library/LaunchAgents/com.koenig.watchdog.plist && launchctl load ~/Library/LaunchAgents/com.koenig.watchdog.plist"
