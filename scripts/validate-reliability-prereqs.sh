#!/usr/bin/env bash
set -euo pipefail

required_env=(
  CLOUDFLARE_API_TOKEN
  CLOUDFLARE_ACCOUNT_ID
  CLOUDFLARE_ZONE_ID
  CLOUDFLARE_TUNNEL_ID
)

for key in "${required_env[@]}"; do
  if [[ -z "${!key:-}" ]]; then
    echo "FAIL: missing env $key" >&2
    exit 1
  fi
done

if ! command -v curl >/dev/null 2>&1; then
  echo "FAIL: curl missing" >&2
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "FAIL: systemctl missing" >&2
  exit 1
fi

AUTH_HEADER="Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"

check_setting() {
  local setting="$1"
  local response
  response="$(curl -sS "https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/settings/${setting}" -H "$AUTH_HEADER")"
  if [[ "$response" != *'"success":true'* ]]; then
    echo "FAIL: cloudflare token cannot access zone setting '${setting}'" >&2
    echo "$response" >&2
    exit 1
  fi
}

check_setting "security_level"
check_setting "bot_fight_mode"

apps_response="$(curl -sS "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/access/apps" -H "$AUTH_HEADER")"
if [[ "$apps_response" != *'"success":true'* ]]; then
  echo "FAIL: cloudflare token cannot manage access applications" >&2
  echo "$apps_response" >&2
  exit 1
fi

tunnel_response="$(curl -sS "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel/${CLOUDFLARE_TUNNEL_ID}/token" -H "$AUTH_HEADER")"
if [[ "$tunnel_response" != *'"success":true'* ]]; then
  echo "FAIL: cloudflare token cannot fetch tunnel token (rotation scope missing)" >&2
  echo "$tunnel_response" >&2
  exit 1
fi

if [[ "${EUID}" -ne 0 ]]; then
  echo "FAIL: root required for service/token rotation (run via sudo)" >&2
  exit 1
fi

if ! command -v terraform >/dev/null 2>&1; then
  echo "FAIL: terraform missing (>=1.5 required)" >&2
  exit 1
fi

echo "OK: reliability rollout prerequisites satisfied."
