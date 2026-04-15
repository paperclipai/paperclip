---
title: Deployment Modes
summary: local_trusted vs authenticated (private/public)
---

Orchestrero supports two runtime modes with different security profiles.

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
- **Bootstrap**: if no instance admin exists yet, the app stays in `bootstrap_pending` until you create and accept the first admin invite

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
- **Bootstrap**: first-admin setup still uses the bootstrap invite flow before normal board access works

```sh
pnpm paperclipai onboard
# Choose "authenticated" -> "public"
```

## First Admin Bootstrap

When an `authenticated` deployment has no instance admin yet, health reports `bootstrap_pending` and the UI shows a blocking setup page.

Generate the first admin invite from the Orchestrero shell environment:

```sh
pnpm paperclipai auth bootstrap-ceo
```

Accepting that invite creates the first instance admin and unlocks normal board access.

## Board Claim Flow

When migrating an existing `local_trusted` instance to `authenticated`, Orchestrero can also emit a one-time board-claim URL at startup:

```
/board-claim/<token>?code=<code>
```

A signed-in user visits this URL to claim board ownership. This:

- Promotes the current user to instance admin
- Demotes the auto-created local board admin (`local-board`)
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
