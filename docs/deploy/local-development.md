---
title: Local Development
summary: Set up Ironworks for local development
---

Run Ironworks locally with zero external dependencies.

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

No Docker or external database required. Ironworks uses embedded PostgreSQL automatically.

## One-Command Bootstrap

For a first-time install:

```sh
pnpm ironworksai run
```

This does:

1. Auto-onboards if config is missing
2. Runs `ironworksai doctor` with repair enabled
3. Starts the server when checks pass

## Tailscale/Private Auth Dev Mode

To run in `authenticated/private` mode for network access:

```sh
pnpm dev --tailscale-auth
```

This binds the server to `0.0.0.0` for private-network access.

Alias:

```sh
pnpm dev --authenticated-private
```

Allow additional private hostnames:

```sh
pnpm ironworksai allowed-hostname dotta-macbook-pro
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
rm -rf ~/.ironworks/instances/default/db
pnpm dev
```

## Data Locations

| Data | Path |
|------|------|
| Config | `~/.ironworks/instances/default/config.json` |
| Database | `~/.ironworks/instances/default/db` |
| Storage | `~/.ironworks/instances/default/data/storage` |
| Secrets key | `~/.ironworks/instances/default/secrets/master.key` |
| Logs | `~/.ironworks/instances/default/logs` |

Override with environment variables:

```sh
IRONWORKS_HOME=/custom/path IRONWORKS_INSTANCE_ID=dev pnpm ironworksai run
```
