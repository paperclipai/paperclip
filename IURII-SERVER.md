# Running the Local Server with Railway Postgres

## Quick Start

```bash
cd /Users/cvvl/conductor/workspaces/paperclip-v1/havana

pnpm install
pnpm update
pnpm --filter @paperclipai/plugin-sdk build
pnpm --filter @paperclipai/ui build

DATABASE_URL="postgresql://postgres:nk80i6gdclspvhehau9dg2ia0s8cdtr4@gondola.proxy.rlwy.net:39595/railway" \
PORT=3101 \
PAPERCLIP_AGENT_JWT_SECRET="bg5uj5il7cst2f2w220mi7vozya3r1v3" \
pnpm --filter @paperclipai/server dev
```

## Why These Env Vars

| Variable | Value | Why |
|---|---|---|
| `DATABASE_URL` | `postgresql://postgres:nk80i6gdclspvhehau9dg2ia0s8cdtr4@gondola.proxy.rlwy.net:39595/railway` | Points to Railway Postgres instead of the default embedded Postgres. This is where agent records and API keys live. |
| `PORT` | `3101` | Agents have `PAPERCLIP_API_URL` set to `http://127.0.0.1:3101`. Must match. |
| `PAPERCLIP_AGENT_JWT_SECRET` | `bg5uj5il7cst2f2w220mi7vozya3r1v3` | Same value as `BETTER_AUTH_SECRET` on Railway. Required for the server to sign and verify agent JWTs. Without it, all agent auth returns 401. |

## Getting Railway Credentials

If the credentials change, fetch them with:

```bash
# Link to the Postgres service first
railway service Postgres
railway variable list -k

# Link to the Paperclip service for BETTER_AUTH_SECRET
railway service Paperclip
railway variable list -k
```

Railway project: `e4798893-4884-4247-8cc6-35b023a33701`, environment: `db732799-7e4c-4fd5-8b3c-8d200887ffcb`.

## Troubleshooting

- **Agents getting 401**: Most likely `PAPERCLIP_AGENT_JWT_SECRET` is missing or doesn't match the secret used to sign the agent's JWT. Restart the server with the correct secret — agents will self-heal on their next heartbeat (new JWT gets issued).
- **Port conflict**: Check `lsof -i :3101` to see if another server is already running. Kill it first.
- **Embedded Postgres starts instead**: Make sure `DATABASE_URL` is set. Without it, the server defaults to embedded Postgres which has a separate, empty database.

## Syncing Upstream Updates

This repo is a private mirror of `paperclipai/paperclip`. To pull in new changes:

```bash
git fetch upstream master
git merge upstream/master
git push origin master
```

The `upstream` remote points to `https://github.com/paperclipai/paperclip.git`.
