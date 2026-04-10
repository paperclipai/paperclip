---
title: Deployment Modes
summary: local_trusted vs authenticated (private/public)
---

Paperclip supports two runtime modes with different security profiles.

## `local_trusted`

The default mode. Optimized for single-operator local use.

- **Host binding**: loopback only (localhost)
- **Authentication**: no login required
- **Use case**: local development, solo experimentation
- **Board identity**: auto-created local board user

```sh
# Set during onboard
pnpm paperclipai onboard
# Choose "local_trusted"
```

## `authenticated`

Login required. Supports two exposure policies.

### `authenticated` + `private`

For private network access (Tailscale, VPN, LAN).

- **Authentication**: login required via Better Auth
- **URL handling**: auto base URL mode (lower friction)
- **Host trust**: private-host trust policy required

```sh
pnpm paperclipai onboard
# Choose "authenticated" -> "private"
```

Allow custom Tailscale hostnames:

```sh
pnpm paperclipai allowed-hostname my-machine
```

### `authenticated` + `public`

For internet-facing deployment.

- **Authentication**: login required
- **URL**: explicit public URL required
- **Security**: stricter deployment checks in doctor

```sh
pnpm paperclipai onboard
# Choose "authenticated" -> "public"
```

## Board Claim Flow

When migrating from `local_trusted` to `authenticated`, Paperclip emits a one-time claim URL at startup:

```
/board-claim/<token>?code=<code>
```

A signed-in user visits this URL to claim board ownership. This:

- Promotes the current user to instance admin
- Demotes the auto-created local board admin
- Ensures active company membership for the claiming user

## Changing Modes

Update the deployment mode:

```sh
pnpm paperclipai configure --section server
```

Runtime override via environment variable:

```sh
PAPERCLIP_DEPLOYMENT_MODE=authenticated pnpm paperclipai run
```

## Process user: root vs non-root

Paperclip is normally run as an unprivileged user (including in containers). Some bare-metal or systemd installs run the server as **root** for simplicity.

| Aspect | Non-root (recommended) | Root (`uid=0`) |
| --- | --- | --- |
| Embedded PostgreSQL | Standard startup | `createPostgresUser` is enabled so the embedded cluster can initialize |
| `claude_local` | `--dangerously-skip-permissions` works as configured (default on) | Claude rejects that flag; Paperclip injects a **default** `--allowed-tools` list so `--print` probes and runs can proceed without interactive approval |
| Security | Least privilege | Broader process privileges; review deployment exposure (`local_trusted` vs `authenticated`) and firewalling |

At startup, when `uid=0`, the server logs a warning summarizing embedded Postgres and the Claude allowlist behavior. Prefer Docker or a dedicated service user when you can; use root only when you accept the trade-offs and have reviewed tool allowlists and network exposure.
