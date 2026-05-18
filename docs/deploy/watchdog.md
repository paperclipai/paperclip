# Paperclip Watchdog

## Overview

The watchdog monitors the paperclip server health and automatically remediates common failure modes.

## Installation

```bash
sudo bash scripts/install-paperclip-watchdog.sh
```

This installs:
- `/usr/local/bin/paperclip-watchdog` — the watchdog script
- `/etc/systemd/system/paperclip-watchdog.service` — oneshot systemd service
- `/etc/systemd/system/paperclip-watchdog.timer` — 60-second timer

## Operation

The watchdog runs every 60 seconds and checks:

1. **Health check** (`/healthz`): If unhealthy for 3 consecutive checks, restarts `paperclip.service`.
2. **Disk usage**: If > 90%, forces logrotate.
3. **Connection count**: If > 200 ESTABLISHED to :3101, logs warning. If > 500, restarts `cloudflared-paperclip.service`.
4. **CLOSE_WAIT sockets**: If > 50, restarts `cloudflared-paperclip.service`.

## Flap Protection

Max 3 service restarts per 15-minute window. Exceeding triggers CRITICAL alert and stops auto-remediation until human acknowledgment.

## Dry-Run Mode

First 48 hours after installation: logs actions and sends notifications but does NOT restart services. After 48 hours of clean operation, automatically switches to enforcement mode.

## State

Persisted at `/var/lib/paperclip-watchdog/state.env`:
- `CONSECUTIVE_HEALTHZ_FAILS`
- `RESTART_COUNT_15M`
- `RESTART_WINDOW_START`
- `INSTALLED_AT`
- `ENFORCEMENT_MODE`

## Logs

`/var/log/paperclip-watchdog.log`
