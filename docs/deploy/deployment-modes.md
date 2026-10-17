---
title: Deployment Modes
summary: local_trusted vs authenticated (private/public)
---

Paperclip supports two runtime modes with different security profiles. Reachability is configured separately with `bind`.

## `local_trusted`

The default mode. Optimized for single-operator local use.

- **Host binding**: loopback only (localhost)
- **Bind**: `loopback`
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
- **Bind**: choose `loopback`, `lan`, `tailnet`, or `custom`

```sh
pnpm paperclipai onboard
# Choose "authenticated" -> "private"
```

Allow custom Tailscale hostnames:

```sh
npx paperclipai allowed-hostname my-machine
```

### `authenticated` + `public`

For internet-facing deployment.

- **Authentication**: login required
- **URL**: explicit public URL required
- **Security**: stricter deployment checks in doctor
- **Bind**: usually `loopback` behind a reverse proxy; `lan/custom` is advanced

```sh
pnpm paperclipai onboard
# Choose "authenticated" -> "public"
```

## Sign-up modes

In `authenticated` mode, the sign-up mode controls who can create an account:

| Mode | Effect |
|------|--------|
| `open` (default) | Anyone who can reach the instance can create an account. A new account has no company access until an invite is accepted. |
| `invite` | An account can be created only from a valid invite link. The invite must exist, must not be revoked, accepted, or expired, and must allow human joins. Other sign-ups get `403` with the code `SIGN_UP_REQUIRES_INVITE`. The sign-in page shows that registration is by invitation only. |
| `disabled` | Nobody can create an account, including invited people. |

Set the mode with the `PAPERCLIP_AUTH_SIGN_UP` environment variable or `auth.signUp` in the config file:

```json
{ "auth": { "signUp": "invite" } }
```

The server reads the first value that is set, in this order:

1. `PAPERCLIP_AUTH_SIGN_UP`
2. `auth.signUp`
3. `PAPERCLIP_AUTH_DISABLE_SIGN_UP` (legacy: `true` means `disabled`, other values mean `open`)
4. `auth.disableSignUp` (legacy: `true` means `disabled`)

Existing configurations that set only the legacy flag keep their behavior.

Invite mode also accepts the bootstrap CEO invite from `paperclipai auth bootstrap-ceo`, so a new instance can start in invite mode.

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
PAPERCLIP_DEPLOYMENT_MODE=authenticated PAPERCLIP_BIND=lan pnpm paperclipai run
```
