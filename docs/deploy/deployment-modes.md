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

### Two-factor authentication and passkeys

In `authenticated` mode, each user can add a second sign-in step and passkeys
under **Settings → Profile → Sign-in security**.

- **Authenticator app (TOTP)**: always available. The user confirms the
  password, scans a QR code, and enters one code to turn it on. Paperclip
  shows 10 one-time backup codes at setup. After that, password sign-in asks
  for a code from the app or a backup code. The user can trust a device for
  30 days.
  Accounts without a password (for example, ones created through workspace
  handoff) cannot turn it on, because every change asks for the password.
- **Passkeys**: available only when the instance has a stable public URL that
  a browser accepts as a WebAuthn relying party. Paperclip uses the
  authentication public URL (the first set of `PAPERCLIP_AUTH_PUBLIC_BASE_URL`,
  `BETTER_AUTH_URL`, `BETTER_AUTH_BASE_URL`, `PAPERCLIP_PUBLIC_URL`, or
  `auth.publicBaseUrl` in the config file), and only when sign-in trusts its
  origin. Set it to an `https://` URL with a
  hostname, or to `http://localhost` for local development. IP-address URLs
  and plain `http://` hostnames do not support passkeys. Passkeys work only on
  pages served from that exact origin: on any other allowed hostname (a LAN
  name, loopback) Paperclip hides passkey sign-in and links to the public URL.
  Changing the public hostname invalidates passkeys registered for the old
  hostname. A passkey must unlock with a PIN or biometric. Security keys that
  only take a touch are rejected, because a passkey sign-in skips both the
  password and the authenticator code.

Both options are per user and off by default.

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
