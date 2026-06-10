# Deployment — Paperclip

## Mac Mini Deployment
Paperclip runs on the Mac Mini as a persistent service via launchd.

### LaunchAgent
- **Label**: `ai.paperclip`
- **Plist**: `~/Library/LaunchAgents/ai.paperclip.plist`
- **Port**: 3100 (HTTP, localhost) / 3443 (HTTPS, Tailscale)
- **Reverse Proxy**: Caddy (system LaunchDaemon)

### Service Management
```bash
# Start
launchctl kickstart -k gui/$(id -u)/ai.paperclip

# Stop
launchctl kill SIGTERM gui/$(id -u)/ai.paperclip

# Restart
launchctl kickstart -k gui/$(id -u)/ai.paperclip

# Check status
launchctl list | grep ai.paperclip
```

### Health Check
```bash
curl -sk https://mac-mini-de-chris.tail606c16.ts.net:3443/health
```

### Update Procedure
```bash
cd ~/Dev/paperclip
git fetch origin
git merge origin/master
pnpm install
pnpm build
launchctl kickstart -k gui/$(id -u)/ai.paperclip
```

### Related LaunchAgents
- `ai.paperclip.backup` — Daily DB backup
- `ai.paperclip.discord-alerts` — Discord alert bot
- `ai.paperclip.discord-digest` — Daily digest
- `ai.paperclip.update` — Weekly auto-update check

### Logs
```bash
# Paperclip logs
log show --predicate 'subsystem == "ai.paperclip"' --last 1h

# Embedded PostgreSQL logs
ls ~/.paperclip/instances/default/logs/
```

### TLS
Caddy handles TLS using Let's Encrypt certificates via Tailscale (`tailscale cert`).
