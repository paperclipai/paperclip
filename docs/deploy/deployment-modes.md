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
- **Relay tunnel**: blocked (server refuses to start)

```sh
# Set during onboard
pnpm paperclipai onboard
# Choose "local_trusted"
```

## `authenticated`

Login required. Supports two exposure policies.

### `authenticated` + `private`

For private network access (Tailscale, VPN, LAN) and relay tunnel.

- **Authentication**: login required via Better Auth
- **URL handling**: auto base URL mode (lower friction)
- **Host trust**: private-host trust policy required
- **Relay tunnel**: supported (see [Relay Tunnel](/deploy/relay-tunnel))

```sh
pnpm paperclipai onboard
# Choose "authenticated" -> "private"
```

Allow custom Tailscale or relay hostnames:

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

## Remote Access

Two options for accessing Paperclip from outside your local machine (both require `authenticated` mode):

- **Tailscale**: binds to `0.0.0.0` on a private network. See [Tailscale Private Access](/deploy/tailscale-private-access).
- **Relay tunnel**: connects to a relay server for a public subdomain URL (e.g. `https://d4lsc.relay.com`). No port forwarding required. See [Relay Tunnel](/deploy/relay-tunnel).

## Changing Modes

Update the deployment mode:

```sh
pnpm paperclipai configure --section server
```

Runtime override via environment variable:

```sh
PAPERCLIP_DEPLOYMENT_MODE=authenticated pnpm paperclipai run
```
