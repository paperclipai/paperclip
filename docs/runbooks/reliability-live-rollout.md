# Reliability Live Rollout

One-command rollout for all reliability hardening on the production VM.

## Prerequisites

- Hetzner VM (paperclip-01), Ubuntu, arm64
- Root access
- Cloudflare API token configured

## Rollout

```bash
sudo bash scripts/apply-reliability-rollout.sh
```

This single command:

1. Validates prerequisites (Cloudflare token, required tools)
2. Applies Cloudflare Terraform (Bot Fight OFF, Access policy)
3. Rotates the cloudflared tunnel token
4. Installs logrotate config
5. Installs the watchdog script + systemd timer

## Post-Rollout Verification

```bash
# Check server health
curl http://127.0.0.1:3101/healthz | jq .

# Check metrics
curl http://127.0.0.1:3101/metrics | head -10

# Check watchdog
systemctl status paperclip-watchdog.timer
systemctl status paperclip-watchdog.service

# Check logrotate
logrotate -d /etc/logrotate.d/paperclip

# Check Cloudflare
curl -s -H "Authorization: Bearer $CF_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/settings" | jq '.result[] | select(.id=="browser_check" or .id=="security_level") | {id, value}'
```
