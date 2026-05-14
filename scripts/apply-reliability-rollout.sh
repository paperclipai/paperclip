#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

required_env=(
  CLOUDFLARE_API_TOKEN
  CLOUDFLARE_ACCOUNT_ID
  CLOUDFLARE_ZONE_ID
  CLOUDFLARE_TUNNEL_ID
)

for key in "${required_env[@]}"; do
if [[ -z "${!key:-}" ]]; then
    echo "Missing required env: $key" >&2
    exit 1
  fi
done

"$REPO_ROOT/scripts/validate-reliability-prereqs.sh"

export TF_VAR_cloudflare_api_token="$CLOUDFLARE_API_TOKEN"
export TF_VAR_cloudflare_account_id="$CLOUDFLARE_ACCOUNT_ID"
export TF_VAR_cloudflare_zone_id="$CLOUDFLARE_ZONE_ID"
export TF_VAR_paperclip_subdomain="${PAPERCLIP_SUBDOMAIN:-paperclip}"
if [[ -n "${CLOUDFLARE_ALLOWED_EMAILS_CSV:-}" ]]; then
  IFS=',' read -r -a emails <<<"$CLOUDFLARE_ALLOWED_EMAILS_CSV"
  # Optional; caller can still manage allowed_emails in tfvars.
  printf 'allowed_emails = [%s]\n' "$(printf '"%s",' "${emails[@]}" | sed 's/,$//')" >"$REPO_ROOT/ops/terraform/cloudflare/allowed-emails.auto.tfvars"
fi

pushd "$REPO_ROOT/ops/terraform/cloudflare" >/dev/null
terraform init
terraform apply -auto-approve
popd >/dev/null

sudo env \
  CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" \
  CLOUDFLARE_ACCOUNT_ID="$CLOUDFLARE_ACCOUNT_ID" \
  CLOUDFLARE_TUNNEL_ID="$CLOUDFLARE_TUNNEL_ID" \
  "$REPO_ROOT/scripts/rotate-cloudflared-tunnel-token.sh"

sudo "$REPO_ROOT/scripts/install-paperclip-logrotate.sh"
sudo "$REPO_ROOT/scripts/install-paperclip-watchdog.sh"

echo "Reliability rollout apply complete."
