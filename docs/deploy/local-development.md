---
title: Local Development
summary: Set up Orchestrero for local development
---

Run Orchestrero locally with zero external dependencies.

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

No Docker or external database required. Orchestrero uses embedded PostgreSQL automatically.

Related commands:

```sh
pnpm dev:once
pnpm dev:list
pnpm dev:stop
```

- `pnpm dev:once` starts the full stack without watch mode.
- `pnpm dev:list` and `pnpm dev:stop` inspect or stop the repo's managed dev runner.

If embedded PostgreSQL fails to start because of local shared-memory or IPC leftovers, run:

```sh
pnpm dev:recover
```

## One-Command Bootstrap

For a first-time install:

```sh
pnpm paperclipai run
```

This does:

1. Auto-onboards if config is missing
2. Runs `paperclipai doctor` with repair enabled
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
pnpm paperclipai allowed-hostname dotta-macbook-pro
```

If authenticated dev starts with no instance admin yet, the app stays in setup mode until you generate the first admin invite:

```sh
pnpm paperclipai auth bootstrap-ceo
```

For full setup and troubleshooting, see [Tailscale Private Access](/deploy/tailscale-private-access).

## Restart Awareness

`pnpm dev:once` tracks backend-relevant file changes and pending migrations. When the current boot is stale, the board UI shows a `Restart required` banner instead of silently drifting out of date.

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
rm -rf ~/.paperclip/instances/default/db
pnpm dev
```

## Data Locations

| Data | Path |
|------|------|
| Config | `~/.paperclip/instances/default/config.json` |
| Database | `~/.paperclip/instances/default/db` |
| Storage | `~/.paperclip/instances/default/data/storage` |
| Secrets key | `~/.paperclip/instances/default/secrets/master.key` |
| Logs | `~/.paperclip/instances/default/logs` |

Override with environment variables:

```sh
PAPERCLIP_HOME=/custom/path PAPERCLIP_INSTANCE_ID=dev pnpm paperclipai run
```
