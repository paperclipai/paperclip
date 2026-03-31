# Paperclip Setup Notes

## Local Config
- **Port**: 3200 (default 3100 conflicts with Mission Control)
- **Auth**: Disabled via `DISABLE_APP_AUTH=1`
- **URL**: http://localhost:3200

## LaunchAgent
- **Plist**: `~/Library/LaunchAgents/com.paperclip.plist`
- **Logs**: `~/.cloudflared/paperclip.log` / `paperclip.err.log`
- **Control**: `launchctl start/stop com.paperclip`

## Cloudflare Tunnel
- **Hostname**: paperclip.n3vins.com
- **Tunnel ID**: c860cb98-f33f-4131-b678-c4234138bde1 (shared with mission-control)
- **Config**: `~/.cloudflared/mission-control.yml` (paperclip hostname added to existing tunnel)

## OpenClaw Webhook
- Configured in `~/.openclaw/openclaw.json` under `hooks.paperclip`
- **Needs gateway restart to activate** (`openclaw gateway restart`)

## Manual Steps Required

### 1. DNS Record
Add CNAME record in Cloudflare DNS dashboard:
- **Name**: paperclip
- **Target**: c860cb98-f33f-4131-b678-c4234138bde1.cfargotunnel.com
- **Proxied**: Yes

### 2. Cloudflare Zero Trust Access Policy
1. Go to Cloudflare Zero Trust → Access → Applications
2. Click "Add an application" → Self-hosted
3. Application name: **Paperclip**
4. Application domain: **paperclip.n3vins.com**
5. Add a Policy: Allow users matching email `richjnevins@gmail.com`
6. Save

### 3. Create Companies in Paperclip UI
Once running, create these companies:
- PAL (Precision AI Labs)
- Nevins Investments LLC
- FloorOps

### 4. OpenClaw Adapter
Wire via Settings → Agents → Add Agent → OpenClaw → webhook URL:
`https://paperclip.n3vins.com/hooks`
