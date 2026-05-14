---
title: Paperclip Watchdog
summary: Systemd-driven health checks and auto-remediation for Paperclip
---

## What it does

`paperclip-watchdog` runs every minute and checks:

- `/healthz` availability (`3` consecutive failures triggers restart action)
- disk usage (`>90%` triggers forced logrotate action)
- `ESTABLISHED` connections to `:3101` (`>200` warning, `>500` cloudflared restart action)
- `CLOSE_WAIT` connections to `:3101` (`>50` cloudflared restart action)

All actions are logged to `/var/log/paperclip-watchdog.log`.

## Dry-run and enforcement

- Dry-run mode is default for the first `48` hours.
- During dry-run, restart/logrotate actions are logged and alerted but **not executed**.
- After `48` hours, watchdog auto-switches to enforcement mode and sends confirmation alerts.

## Flap protection

- Service restart cap: max `3` restarts per service per `15` minutes.
- If cap is exceeded, watchdog stops restarting that service and emits a critical escalation alert/proposal.

## Install

```sh
sudo ./scripts/install-paperclip-watchdog.sh
```

## Required environment variables

Set these in the systemd service environment for real alert routing:

- `WATCHDOG_TELEGRAM_BOT_TOKEN`
- `WATCHDOG_TELEGRAM_CHAT_ID`
- `WATCHDOG_PAPERCLIP_API_URL`
- `WATCHDOG_PAPERCLIP_API_KEY`
- `WATCHDOG_PAPERCLIP_COMPANY_ID`

Optional:

- `WATCHDOG_PAPERCLIP_ALERT_ASSIGNEE` (agent ID for proposal assignment)
- `WATCHDOG_HEALTH_URL` (default `http://127.0.0.1:3101/healthz`)
- `WATCHDOG_DRY_RUN_HOURS` (default `48`)

