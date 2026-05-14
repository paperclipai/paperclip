# Cloudflare Runbook (Paperclip)

## Scope

This runbook manages Cloudflare settings for `paperclip.thegoodguys.la`:

- Bot Fight Mode: **OFF**
- Security Level: **Medium**
- Cloudflare Access policy in front of Paperclip dashboard
- Cloudflared tunnel token rotation

## IaC Location

- Terraform module: `ops/terraform/cloudflare`

Files:

- `versions.tf`
- `variables.tf`
- `main.tf`
- `terraform.tfvars.example`

## Apply Terraform

1. Export API token:

```sh
export TF_VAR_cloudflare_api_token="..."
```

2. Copy and edit vars:

```sh
cp ops/terraform/cloudflare/terraform.tfvars.example ops/terraform/cloudflare/terraform.tfvars
```

3. Apply:

```sh
cd ops/terraform/cloudflare
terraform init
terraform plan
terraform apply
```

## Verify State

Confirm in Cloudflare dashboard:

- Zone setting `bot_fight_mode` = `off`
- Zone setting `security_level` = `medium`
- Access application exists for `paperclip.thegoodguys.la`
- Access policy allows the intended email allowlist

## Rotate Exposed Tunnel Token

Use the scripted rotation workflow:

```sh
sudo CLOUDFLARE_API_TOKEN=... \
  CLOUDFLARE_ACCOUNT_ID=... \
  CLOUDFLARE_TUNNEL_ID=... \
  ./scripts/rotate-cloudflared-tunnel-token.sh
```

What the script does:

- Fetches a new tunnel token from Cloudflare API
- Updates env file (default `/etc/default/cloudflared-paperclip`)
- Restarts `cloudflared-paperclip.service`
- Prints service status for quick validation

## Post-rotation Validation

1. `systemctl status cloudflared-paperclip.service`
2. Confirm tunnel reconnects in Cloudflare Zero Trust dashboard
3. Verify `https://paperclip.thegoodguys.la/api/health` returns `200`

