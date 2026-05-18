# Cloudflare Configuration

## IaC Location

`ops/terraform/cloudflare/` — Terraform-managed Cloudflare settings for `paperclip.thegoodguys.la`.

## Applied Settings

- **Bot Fight Mode**: OFF (false-positives on internal API polling)
- **Security Level**: Medium
- **Cloudflare Access**: Email-gated, session duration 24h

## Apply

```bash
cd ops/terraform/cloudflare
cp terraform.tfvars.example terraform.tfvars
# Fill in terraform.tfvars with real values
terraform init
terraform plan
terraform apply
```

## Verify

```bash
# Check zone settings
curl -s -H "Authorization: Bearer $CF_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/settings" | jq

# Check Access application
curl -s -H "Authorization: Bearer $CF_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/access/apps" | jq
```

## Tunnel Token Rotation

```bash
bash scripts/rotate-cloudflared-tunnel-token.sh
systemctl restart cloudflared-paperclip.service
systemctl status cloudflared-paperclip.service
```