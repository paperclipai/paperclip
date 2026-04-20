---
title: Local Development
summary: Set up AiTeamCorp for local development
---

Run AiTeamCorp locally with zero external dependencies.

## Prerequisites

- Node.js 20+
- pnpm 9+

## Start Dev Server

```sh
pnpm install
pnpm dev
```

This starts:

- **API server** at `http://localhost:3100`
- **UI** served by the API server in dev middleware mode (same origin)

No Docker or external database required. AiTeamCorp uses embedded PostgreSQL automatically.

## One-Command Bootstrap

For a first-time install:

```sh
pnpm aiteamcorp run
```

This does:

1. Auto-onboards if config is missing
2. Runs `aiteamcorp doctor` with repair enabled
3. Starts the server when checks pass

## Bind Presets In Dev

Default `pnpm dev` stays in `local_trusted` with loopback-only binding.

To open AiTeamCorp to a private network with login enabled:

```sh
pnpm dev --bind lan
```

For Tailscale-only binding on a detected tailnet address:

```sh
pnpm dev --bind tailnet
```

Legacy aliases still work and map to the older broad private-network behavior:

```sh
pnpm dev --tailscale-auth
pnpm dev --authenticated-private
```

Allow additional private hostnames:

```sh
pnpm aiteamcorp allowed-hostname dotta-macbook-pro
```

For full setup and troubleshooting, see [Tailscale Private Access](/deploy/tailscale-private-access).

## Health Checks

```sh
curl http://localhost:3100/api/health
# -> {"status":"ok"}

curl http://localhost:3100/api/companies
# -> []
```

## Reset Dev Data

To wipe local data and start fresh:

```sh
rm -rf ~/.aiteamcorp/instances/default/db
pnpm dev
```

## Data Locations

| Data | Path |
|------|------|
| Config | `~/.aiteamcorp/instances/default/config.json` |
| Database | `~/.aiteamcorp/instances/default/db` |
| Storage | `~/.aiteamcorp/instances/default/data/storage` |
| Secrets key | `~/.aiteamcorp/instances/default/secrets/master.key` |
| Logs | `~/.aiteamcorp/instances/default/logs` |

Override with environment variables:

```sh
AITEAMCORP_HOME=/custom/path AITEAMCORP_INSTANCE_ID=dev pnpm aiteamcorp run
```
