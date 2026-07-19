# Paperclip ↔ Hermes Integration (this deployment)

This file documents how this Paperclip instance is wired to the host's Hermes
Agent. It is deployment-specific — the upstream `paperclipai/paperclip` repo
does not have this wiring. Keep this file when merging upstream changes.

## Topology

```
Paperclip (Dokku container)
    │
    │  HTTP + Bearer auth (API_SERVER_KEY)
    │  http://172.17.0.1:8642
    ▼
Hermes Gateway API server (host, bound 0.0.0.0:8642)
    │
    │  uses host's GLM_API_KEY
    ▼
Z.AI / GLM (model)
```

Paperclip calls Hermes directly over the Docker bridge IP — no socat, no
reverse proxy, no public port. Port 8642 is reachable only from the Docker
network (172.17.0.0/16) and localhost.

## Why hermes_gateway, not hermes_local

Paperclip has two Hermes adapters:

- `hermes_local` — Paperclip spawns the `hermes` CLI inside its own container.
  Requires baking Hermes into this image (see commit f15f5b914 which adds
  hermes-agent to the image for that path).
- `hermes_gateway` — Paperclip calls an already-running Hermes API server over
  HTTP. The Hermes runtime lives on the host.

This deployment uses **`hermes_gateway`** because:

1. Host Hermes already has working Discord, memory, skills, terminal tools,
   cron jobs, and a configured GLM provider. `hermes_local` would start a
   second, isolated Hermes inside the container that has none of that.
2. `hermes_gateway` lets the Paperclip-driven agent reuse the host's
   authenticated sessions, persisted skills, and messaging integrations.
3. No secrets need to be baked into the container image — the only key
   Paperclip holds is the Hermes gateway API key, stored as a secret_ref in
   Postgres (see below).

## Host-side configuration

All host-side config lives in `/root/.hermes/.env`:

```
API_SERVER_ENABLED=true
API_SERVER_HOST=0.0.0.0              # bind all interfaces so Docker bridge can reach it
API_SERVER_PORT=8642                 # MUST NOT be 9119 (that's the dashboard)
API_SERVER_KEY=<48-char secret>      # shared with Paperclip (stored in company_secrets)
```

The Hermes gateway is run as a systemd user service:

```
systemctl --user status hermes-gateway
systemctl --user restart hermes-gateway
```

Port 9119 is the Hermes web dashboard (separate service, unrelated to the
Paperclip integration):

```
hermes-dashboard.service → /root/.hermes/hermes-agent/.../hermes dashboard --port 9119
```

If the API server ever shows `state: fatal` with `api_server_port_in_use`,
it means port 9119 leaked into API_SERVER_PORT (the dashboard got there
first). Fix: keep `API_SERVER_PORT=8642` in `.env` and restart the gateway.

## Paperclip-side configuration

The integration is stored entirely in Postgres — it survives every redeploy:

| What | Where |
|---|---|
| Agent definition (name, adapter type, config) | `agents` table, `adapter_type='hermes_gateway'` |
| Hermes API key (NOT plaintext) | `company_secrets` table, referenced via `secret_ref` in `agents.adapter_config` |
| CLI auth token (board user) | `/var/lib/dokku/data/storage/paperclip/.paperclip/` (mounted volume) |
| Company / users / issues | Postgres tables |

The agent's `adapter_config` (logical shape; the apiKey is a secret_ref at
rest):

```json
{
  "apiBaseUrl": "http://172.17.0.1:8642",
  "apiKey": "<API_SERVER_KEY from /root/.hermes/.env>",
  "paperclipApiUrl": "http://172.17.0.1:3100",
  "dangerouslyAllowInsecureRemoteHttp": true
}
```

`dangerouslyAllowInsecureRemoteHttp` is required because Paperclip flags the
Docker bridge IP (172.17.0.1) as a "remote" address and refuses to send the
bearer token over plain HTTP without it. This is safe in this topology —
172.17.0.1 is the host's own Docker bridge, not routable from the public
internet.

## Common operations

### Verify the connection is alive

```bash
# From the host — should return {"status":"ok",...}
curl http://127.0.0.1:8642/health

# From inside the Paperclip container (use the new container ID after deploys)
docker exec <paperclip_container_id> \
  curl -s http://172.17.0.1:8642/health
```

### Rotate the Hermes API key

```bash
# 1. Generate a new key
NEW_KEY=$(openssl rand -hex 24)
echo "New key: $NEW_KEY"

# 2. Update host Hermes
sed -i "s|^API_SERVER_KEY=.*|API_SERVER_KEY=$NEW_KEY|" /root/.hermes/.env
systemctl --user restart hermes-gateway

# 3. Update Paperclip (via the CLI inside the container)
docker exec <paperclip_container_id> sh -c '
  cd /app && node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts \
    agent update <AGENT_ID> \
    --payload-json "{\"adapterConfig\":{\"apiKey\":\"'$NEW_KEY'\"}}"
'
```

### Trigger a heartbeat manually

```bash
docker exec <paperclip_container_id> sh -c '
  cd /app && node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts \
    agent heartbeat:invoke <AGENT_ID>
'
```

### Find the agent ID

```sql
-- On the Postgres container (dokku postgres:enter paperclip-db)
SELECT id, name, adapter_type, status FROM agents WHERE adapter_type='hermes_gateway';
```

## What survives a redeploy (`git push dokku master`)

- ✅ Agent definition and adapter config (Postgres)
- ✅ Hermes API key (Postgres `company_secrets`)
- ✅ CLI auth token, company data, issues, users (Postgres + mounted volume)
- ✅ Host-side Hermes config (`/root/.hermes/.env`) — not in the container at all

## What does NOT survive a redeploy

- ❌ Any change made inside the container's ephemeral filesystem (e.g. editing
  files under `/app/`). Make changes in the git repo and push.
- ❌ Manually-installed npm packages inside the container. Add them to
  `package.json` and rebuild.

## Updating Paperclip

Two git remotes are configured in `/home/dokku/paperclip`:

- `origin`  → `https://github.com/paperclipai/paperclip.git` (official upstream)
- `remote`  → `https://github.com/bojakbyco/paperclip.git`   (this fork)

This fork carries two custom commits on top of upstream master:

- `f15f5b914` — feat: add hermes-agent to production image for hermes_local adapter
- `fa74c0e95` — fix: force-reinstall packaging to avoid debian RECORD conflict

To bring in a new upstream release:

```bash
# On your local machine:
git clone git@github.com:bojakbyco/paperclip.git   # one-time
cd paperclip
git remote add upstream https://github.com/paperclipai/paperclip.git

# Each time you want to sync:
git fetch upstream
git checkout master
git merge upstream/master
# Resolve conflicts against the two custom commits above, then:
git push origin master

# Deploy:
git remote add dokku dokku@<dokku-host>:paperclip   # one-time
git push dokku master
```

After the deploy lands, verify the integration:

```bash
docker exec $(docker ps --format '{{.Names}}' | grep ^paperclip | head -1) \
  curl -s http://172.17.0.1:8642/health
```

If that returns `{"status":"ok",...}` the integration survived. If the agent
shows an `error` state in the Paperclip UI afterwards, check whether the new
Paperclip version still supports the `hermes_gateway` adapter (it's a
documented built-in, so this is very unlikely).

## Troubleshooting

### Agent heartbeat fails with "apiBaseUrl uses remote plain HTTP"

`dangerouslyAllowInsecureRemoteHttp: true` got dropped from adapter_config.
Re-add it:

```bash
docker exec <container> sh -c '
  cd /app && node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts \
    agent update <AGENT_ID> \
    --payload-json "{\"adapterConfig\":{\"dangerouslyAllowInsecureRemoteHttp\":true}}"
'
```

### Agent heartbeat fails with 401 / connection refused

- 401 = the API key in Paperclip doesn't match `/root/.hermes/.env` → rotate
  it (see above) or re-set the same value.
- Connection refused = the Hermes gateway API server isn't running →
  `systemctl --user status hermes-gateway` and check that `api_server` is in
  `connected` state in `~/.hermes/gateway_state.json`.

### API server goes fatal with "port in use"

`API_SERVER_PORT` is set to 9119 in `/root/.hermes/.env` (collides with the
dashboard). Set it back to 8642 and restart the gateway.
