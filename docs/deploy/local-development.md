---
title: Local Development
summary: Set up Paperclip for local development
---

Run Paperclip locally with zero external dependencies.

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

No Docker or external database required. Paperclip uses embedded PostgreSQL automatically.

## One-Command Bootstrap

For a first-time install:

```sh
pnpm paperclipai run
```

This does:

1. Auto-onboards if config is missing
2. Runs `paperclipai doctor` with repair enabled
3. Starts the server when checks pass

## Bind Presets In Dev

Default `pnpm dev` stays in `local_trusted` with loopback-only binding.

To open Paperclip to a private network with login enabled:

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
pnpm paperclipai allowed-hostname dotta-macbook-pro
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
rm -rf ~/.paperclip/instances/default/db
pnpm dev
```

## Data Locations

| Data | Path |
|------|------|
| Config | `~/.paperclip/instances/default/config.json` |
| Instance `.env` | `~/.paperclip/instances/default/.env` |
| Database | `~/.paperclip/instances/default/db` |
| Storage | `~/.paperclip/instances/default/data/storage` |
| Secrets key | `~/.paperclip/instances/default/secrets/master.key` |
| Logs | `~/.paperclip/instances/default/logs` |

Override with environment variables:

```sh
PAPERCLIP_HOME=/custom/path PAPERCLIP_INSTANCE_ID=dev pnpm paperclipai run
```

### Instance-Wide `.env`

The server loads `~/.paperclip/instances/<id>/.env` into `process.env` at startup
(via the standard `dotenv` parser). Every agent run inherits these values, so
treat the instance `.env` as the place for secrets that genuinely apply to every
agent on this instance.

### Per-Agent `.env` Overrides (`claude_local` only)

The `claude_local` adapter additionally loads a per-agent dotenv file when
spawning a run process:

```
~/.paperclip/instances/<id>/companies/<companyId>/agents/<agentId>/.env
```

Drop the file on disk out-of-band — there is no UI or JSON API for it yet. Use
standard dotenv syntax (`KEY=value`, one per line, `#` for comments).

**Precedence (lowest → highest):**

1. Instance `.env` (`process.env`).
2. Per-agent `agents/<agentId>/.env`.
3. `adapterConfig.env` and the Paperclip-managed runtime variables
   (`PAPERCLIP_API_KEY`, `PAPERCLIP_RUN_ID`, etc.).

So per-agent values override instance values on key collision but never
override `adapterConfig.env` or the `PAPERCLIP_*` runtime variables.

**Recommended permissions:** `chmod 600 <file>` so only the user running the
server can read it. The Paperclip CLI does not enforce this; it is your
responsibility as the operator.

**Lifecycle:** Deleting an agent through the board UI removes this file and the
parent `agents/<agentId>/` directory if no other artifacts remain. Recreating
the file after an agent run starts has no effect until the next spawn.

**When to use this:** secrets you want bound to a single agent (for example,
a Supabase service-role key for one agent only) without exposing them to
every other `claude_local` agent on the instance.
