#!/usr/bin/env bash
set -euo pipefail

URL="${1:-http://localhost:4711}"
KEY="${DPO_SHARED_KEY:?DPO_SHARED_KEY required}"

echo "==> GET /health"
curl -s -f "$URL/health" | tee /dev/stderr
echo

echo "==> POST /anonymize"
RESP=$(curl -s -f \
  -H "x-dpo-key: $KEY" \
  -H "content-type: application/json" \
  -d '{"text":"Hi Max Mustermann (max@whitestag.de)","targetLlm":"gpt-4o","agent":"smoke"}' \
  "$URL/anonymize")
echo "$RESP"

MID=$(echo "$RESP" | node -e 'process.stdin.on("data",b=>console.log(JSON.parse(b).mappingId||""))')
ATEXT=$(echo "$RESP" | node -e 'process.stdin.on("data",b=>console.log(JSON.parse(b).anonymizedText||""))')

if [[ -z "$MID" ]]; then echo "anonymize did not return mappingId (blocked?)" >&2; exit 1; fi

echo "==> POST /deanonymize"
curl -s -f \
  -H "x-dpo-key: $KEY" \
  -H "content-type: application/json" \
  -d "{\"mappingId\":\"$MID\",\"text\":\"Reply to $ATEXT\"}" \
  "$URL/deanonymize"
echo

echo "smoke OK"
