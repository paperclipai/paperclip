# Reliability Live Rollout (No Terraform Knowledge Needed)

This wraps the remaining production steps into one command.

## Required inputs

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_ZONE_ID`
- `CLOUDFLARE_TUNNEL_ID`
- Optional: `CLOUDFLARE_ALLOWED_EMAILS_CSV` (comma separated)

## One-command apply

```sh
export CLOUDFLARE_API_TOKEN=...
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_ZONE_ID=...
export CLOUDFLARE_TUNNEL_ID=...
export CLOUDFLARE_ALLOWED_EMAILS_CSV="nick@thegoodguys.la"

./scripts/apply-reliability-rollout.sh
```

## What it does

1. Applies Cloudflare Terraform settings.
2. Rotates cloudflared tunnel token and restarts service.
3. Installs logrotate config.
4. Installs and enables watchdog timer.

## Post-run verification

```sh
systemctl status cloudflared-paperclip.service --no-pager
systemctl status paperclip-watchdog.timer --no-pager
curl -sS http://127.0.0.1:3101/healthz | jq .
curl -sS http://127.0.0.1:3101/metrics | head -80
```

