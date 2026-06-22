# Vultr Deployment Runbook — paperclip + recovery Workflow go-live

> Goal: run the paperclip server (this branch) on a Vultr VM, expose it to Cloudflare via a
> named Tunnel, and bring the recovery Workflow live (shadow → active).
> Secrets are staged locally in `.env.recovery-workflow.local` (gitignored) and the SSH key
> at `~/.ssh/paperclip_vultr`. Branch to deploy: `feat/model-policy-layer`.

## 0. Provision the VM (Vultr console)
- Compute → Deploy New Server → Cloud Compute (Shared/Regular).
- Location: **Sydney**. Image: **Ubuntu 24.04**. Plan: **2 vCPU / 4 GB** (~US$24/mo).
- SSH Keys: add the public key:
  ```
  # on your laptop:
  cat ~/.ssh/paperclip_vultr.pub      # paste this into Vultr → SSH Keys → Add
  ```
- Deploy. Note the server's **public IP** (call it `$VM_IP`).

## 1. First SSH + base packages
```bash
ssh -i ~/.ssh/paperclip_vultr root@$VM_IP

# on the VM:
apt-get update && apt-get install -y curl git build-essential ca-certificates
# Node 22 + pnpm (via corepack)
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
corepack enable && corepack prepare pnpm@latest --activate
node -v && pnpm -v
```

## 2. Get the code (this branch)
```bash
# on the VM (uses the adme-dev fork, which has feat/model-policy-layer):
cd /opt
git clone https://github.com/adme-dev/paperclip.git
cd paperclip && git checkout feat/model-policy-layer
pnpm install
pnpm --filter @paperclipai/db build
pnpm --filter @paperclipai/server build   # optional; `pnpm --filter @paperclipai/server dev` also works
```

## 3. Environment file on the VM
Create `/opt/paperclip/server.env` with the values from your local `.env.recovery-workflow.local`
plus the server-runtime vars. **Do not commit this.** Fill `<...>` from the staged file:
```ini
PORT=8088
PAPERCLIP_MIGRATION_AUTO_APPLY=true
# host allowlist: include the tunnel hostname you choose in step 5
PAPERCLIP_ALLOWED_HOSTNAMES=recovery.<your-domain>,localhost,127.0.0.1
# --- from .env.recovery-workflow.local ---
PAPERCLIP_CF_ACCOUNT_ID=a5b299b3ad15c1b5b895dc66f9357b17
PAPERCLIP_CF_API_TOKEN=<cfut_… from the staged file>
PAPERCLIP_CF_RECOVERY_WORKFLOW_NAME=recovery-workflow
PAPERCLIP_INTERNAL_API_SECRET=<shared secret from the staged file>
# rollout: start empty, fill one company id in step 6
PAPERCLIP_RECOVERY_WORKFLOW_SHADOW_COMPANIES=
PAPERCLIP_RECOVERY_WORKFLOW_COMPANIES=
```
> Database: this uses paperclip's **embedded Postgres** (data under `~/.paperclip/instances/default`),
> which auto-applies migrations `0088`/`0089` on first boot (AUTO_APPLY=true). For a managed
> Postgres instead, set `DATABASE_URL` and run `pnpm --filter @paperclipai/db migrate`.

## 4. Run as a service (systemd)
```bash
cat >/etc/systemd/system/paperclip.service <<'UNIT'
[Unit]
Description=Paperclip server
After=network.target
[Service]
WorkingDirectory=/opt/paperclip/server
EnvironmentFile=/opt/paperclip/server.env
ExecStart=/usr/bin/env pnpm --filter @paperclipai/server dev
Restart=always
RestartSec=5
User=root
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload && systemctl enable --now paperclip
sleep 20 && curl -s http://127.0.0.1:8088/api/health   # expect {"status":"ok",...}
```

## 5. Expose to Cloudflare via a named Tunnel
A named tunnel gives a **stable** hostname (unlike the demo's ephemeral quick tunnel) and keeps
the server private (no open port).
```bash
# on the VM:
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared
chmod +x /usr/local/bin/cloudflared
cloudflared tunnel login                      # opens a URL; authorize your Cloudflare account/zone
cloudflared tunnel create paperclip-recovery  # note the tunnel UUID
# route a hostname on your CF domain to it:
cloudflared tunnel route dns paperclip-recovery recovery.<your-domain>
# config:
mkdir -p /etc/cloudflared
cat >/etc/cloudflared/config.yml <<'CFG'
tunnel: paperclip-recovery
credentials-file: /root/.cloudflared/<TUNNEL_UUID>.json
ingress:
  - hostname: recovery.<your-domain>
    service: http://127.0.0.1:8088
  - service: http_status:404
CFG
cloudflared service install && systemctl enable --now cloudflared
# verify from anywhere:
curl -s https://recovery.<your-domain>/api/health
```
> Make sure `recovery.<your-domain>` is in `PAPERCLIP_ALLOWED_HOSTNAMES` (step 3); restart paperclip if you change it.

## 6. Point the Worker at the server + redeploy
On your laptop (wrangler is already authed):
```bash
cd <repo>/packages/recovery-workflow
# set the stable tunnel URL as the Worker's callback base:
#   edit wrangler.jsonc -> "INTERNAL_API_BASE_URL": "https://recovery.<your-domain>"
pnpm exec wrangler deploy
# INTERNAL_API_SECRET is already set on the Worker (matches PAPERCLIP_INTERNAL_API_SECRET).
```

## 7. Validate in shadow, then promote
```bash
# pick a company id (GET /api/companies through the tunnel), put it in shadow:
#   server.env -> PAPERCLIP_RECOVERY_WORKFLOW_SHADOW_COMPANIES=<companyId>
systemctl restart paperclip
```
- When a real recovery action occurs for that company, the trigger starts a Workflow instance;
  it calls back over the tunnel and records shadow decisions.
- Check agreement:
  `GET https://recovery.<your-domain>/internal/recovery/:actionId/shadow-diff?companyId=&sourceIssueId=&liveActive=&liveStatus=&liveAttemptCount=`
  with header `x-internal-secret: <secret>`.
- Promote: move the company id from the shadow var to `PAPERCLIP_RECOVERY_WORKFLOW_COMPANIES`, restart.
  Now the poll loop skips it and the Workflow drives real attempts.

## 8. Rollback
- Authority → shadow: move the company id back to the shadow var, restart.
- Full off: empty both vars, restart (pure legacy poll loop).
- Tear down: `systemctl disable --now paperclip cloudflared`; destroy the VM in the Vultr console.

## Security notes
- `.env.recovery-workflow.local` / `server.env` hold a **live CF API token** + the internal secret — never commit; `chmod 600`. Rotate the token if exposed.
- The `x-internal-secret` header is the only auth on `/internal/recovery/*`; the named tunnel keeps the origin private.
