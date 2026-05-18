# Deployment Overview

Paperclip runs on a single Hetzner VM (`paperclip-01`, Ubuntu arm64).

## Services (systemd)

| Service | Description |
|---------|-------------|
| `paperclip.service` | Paperclip control plane (Express/Node on 127.0.0.1:3101) |
| `cloudflared-paperclip.service` | Cloudflare Tunnel for public ingress |
| `paperclip-watchdog.timer` | Health monitoring and auto-remediation (60s interval) |

## Infrastructure

- **Compute**: Hetzner Cloud VM, arm64, Ubuntu
- **Database**: Embedded PostgreSQL on :54330
- **Ingress**: Cloudflare Tunnel → `paperclip.thegoodguys.la`
- **IaC**: Cloudflare settings managed via Terraform in `ops/terraform/cloudflare/`

## Logs

- Server: `~/.paperclip/instances/default/logs/server.log`
- Watchdog: `/var/log/paperclip-watchdog.log`
- Systemd: `journalctl -u paperclip.service`, `journalctl -u cloudflared-paperclip.service`

## Monitoring

- Health: `http://127.0.0.1:3101/healthz`
- Metrics: `http://127.0.0.1:3101/metrics` (Prometheus format)

## Quick Recovery

```bash
sudo systemctl restart cloudflared-paperclip.service
sudo systemctl restart paperclip.service
```
