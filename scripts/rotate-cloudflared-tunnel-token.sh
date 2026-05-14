#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root (sudo)." >&2
  exit 1
fi

: "${CLOUDFLARE_API_TOKEN:?Missing CLOUDFLARE_API_TOKEN}"
: "${CLOUDFLARE_ACCOUNT_ID:?Missing CLOUDFLARE_ACCOUNT_ID}"
: "${CLOUDFLARE_TUNNEL_ID:?Missing CLOUDFLARE_TUNNEL_ID}"

ENV_FILE="${CLOUDFLARED_ENV_FILE:-/etc/default/cloudflared-paperclip}"
SERVICE_NAME="${CLOUDFLARED_SERVICE_NAME:-cloudflared-paperclip.service}"

TOKEN_JSON="$(curl -sS -X GET \
  "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel/${CLOUDFLARE_TUNNEL_ID}/token" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json")"

NEW_TOKEN="$(printf '%s' "$TOKEN_JSON" | sed -n 's/.*"result":"\([^"]*\)".*/\1/p')"
if [[ -z "$NEW_TOKEN" ]]; then
  echo "Failed to parse tunnel token from Cloudflare API response." >&2
  exit 1
fi

mkdir -p "$(dirname "$ENV_FILE")"
touch "$ENV_FILE"
chmod 0600 "$ENV_FILE"

if grep -q '^TUNNEL_TOKEN=' "$ENV_FILE"; then
  sed -i.bak "s|^TUNNEL_TOKEN=.*$|TUNNEL_TOKEN=${NEW_TOKEN}|" "$ENV_FILE"
else
  printf '\nTUNNEL_TOKEN=%s\n' "$NEW_TOKEN" >>"$ENV_FILE"
fi

systemctl daemon-reload
systemctl restart "$SERVICE_NAME"
sleep 2
systemctl --no-pager --full status "$SERVICE_NAME"

echo "Cloudflared tunnel token rotated and service restarted."
