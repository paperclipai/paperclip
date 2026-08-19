---
title: Automatic Tailscale HTTPS for branch runtimes
summary: Install, operate, and roll back the least-privilege HTTPS broker that exposes managed branch runtimes on trusted Tailscale HTTPS URLs
---

Managed branch runtimes can be exposed automatically on the node's trusted
Tailscale hostname at their allocated port:

```text
https://paperclip-dev.<tailnet>.ts.net:<runtime-port>/...
```

TLS is terminated by the node certificate via `tailscale serve`. The primary app
route `https://paperclip-dev.<tailnet>.ts.net:443 -> 127.0.0.1:3100` is never
touched. This is opt-in per runtime service via the `tailscale_https` exposure
mode (see below).

## Security model (why a broker)

The Paperclip server/agent account must **not** be a Tailscale operator — that
would grant it general `serve`/`cert`/`funnel` authority. Instead a small,
dedicated **broker** account is the operator, and Paperclip talks to it over a
Unix socket. The broker only ever performs same-number HTTPS-to-loopback
mappings on a dedicated port range and rejects everything else (Funnel, certs,
Services, `reset`, path handlers, arbitrary targets, `:443`, privileged/reserved
ports, non-loopback/wildcard backends, and any listener it did not create). It
serializes mutations, verifies the protected `:443` mapping before and after
every change, and keeps an atomic ownership registry so a crash or a race can
never clobber unknown or manually managed Serve state. See the threat model on
PAP-17050 for the full rationale and the invariants encoded in the broker.

## Preflight (read-only, run any time)

```sh
node scripts/tailscale-broker-preflight.mjs
```

Checks the Tailscale CLI/version, MagicDNS node name and HTTPS enablement, the
intact `:443` primary handler, existing mappings in the dedicated range, and (if
configured) the broker socket parent-directory permissions. It never mutates
state.

## One-time install

1. **Create the dedicated broker account** and make it the Tailscale operator
   (this is the *only* account with operator authority):

   ```sh
   sudo useradd --system --home /var/lib/paperclip-tailscale-broker --shell /usr/sbin/nologin pcts-broker
   sudo tailscale set --operator=pcts-broker
   ```

2. **Create state directories** with least privilege. systemd creates the socket
   directory as `pcts-broker:paperclip` with mode `0750`. The broker can create
   the socket as the directory owner. Paperclip group members can traverse the
   directory but cannot replace the socket. The socket file is `0660`.

   ```sh
   sudo install -d -o pcts-broker -g pcts-broker -m 0700 /var/lib/paperclip-tailscale-broker
   sudo install -d -o pcts-broker -g pcts-broker -m 0750 /var/log/paperclip-tailscale-broker
   ```

3. **Build the broker entry** and install the unit. On Linux, this build needs a
   C compiler and the Node.js headers. It compiles the small SO_PEERCRED bridge
   that identifies each socket client. The broker refuses to start without it.

   ```sh
   pnpm --filter @paperclipai/server build   # produces server/dist/tailscale-broker/main.js
   sudo cp docs/deploy/paperclip-tailscale-broker.service /etc/systemd/system/
   # edit ALLOWED_UIDS / RUNTIME_UID / paths to match the deployment
   sudo systemctl daemon-reload
   sudo systemctl enable --now paperclip-tailscale-broker
   ```

4. **Verify** the socket appears with the expected ownership and mode:

   ```sh
   sudo ls -ld /run/paperclip-tailscale-broker              # drwxr-x--- pcts-broker paperclip
   sudo ls -l /run/paperclip-tailscale-broker/broker.sock   # srw-rw---- pcts-broker paperclip
   node scripts/tailscale-broker-preflight.mjs
   ```

5. **Enable the exposure mode** for a canary runtime service (see "Opt-in" below)
   and confirm one branch gets a working `https://…:<port>/` URL before enabling
   it broadly.

## Opt-in: runtime service exposure config

Add an `expose` block to the managed runtime service configuration
(`workspaceRuntime.services[]`):

```json
{
  "name": "paperclip-dev",
  "command": "pnpm dev --bind custom --bind-host 127.0.0.1",
  "port": { "type": "auto", "envKey": "PORT" },
  "expose": {
    "type": "tailscale_https",
    "hostname": "auto",
    "publicPort": "same",
    "includePaperclipViteHmr": true,
    "failurePolicy": "fail_closed"
  }
}
```

- `hostname: "auto"` is resolved from the local node; no tailnet suffix is
  hard-coded.
- `failurePolicy: "fail_closed"` means the runtime is not reported healthy if the
  broker, TLS listener, or the external HTTPS probe fails — it never silently
  falls back to plain HTTP.
- The backend binds loopback-only; the app port and the Paperclip Vite HMR
  companion port are allocated and exposed as a pair.

## Upgrade

```sh
pnpm --filter @paperclipai/server build
sudo systemctl restart paperclip-tailscale-broker
```

The broker reconciles its registry against live Serve state on start: it adopts
only exact lease matches, removes only orphaned Paperclip-owned mappings, and
quarantines anything ambiguous for operator review. Manual and unknown mappings
are never modified.

## Uninstall / rollback / opt-out

Rollback disables new exposure requests and removes only broker-owned listeners;
it never runs `tailscale serve reset` and never changes the primary `:443` route.

- **Opt out a single runtime service:** remove the `expose` block (or set
  `type` to something other than `tailscale_https`) and restart the runtime. Its
  broker-owned listeners are removed on stop.
- **Disable the feature host-wide:**

  ```sh
  sudo systemctl disable --now paperclip-tailscale-broker
  ```

  Existing broker-owned mappings can be cleared explicitly before stopping by
  removing each runtime service (which calls `remove`), or manually with
  `sudo tailscale serve --https=<port> off` for a specific broker-owned port.
  **Do not** run `tailscale serve reset` — that would also remove the primary
  `:443` route.
- **Remove operator authority entirely:**

  ```sh
  sudo tailscale set --operator=
  sudo userdel pcts-broker
  ```

## Recovery

If the preflight or the broker reports `cleanup_pending` / quarantined ports:

1. Inspect the audit log at `/var/log/paperclip-tailscale-broker/audit.jsonl`.
2. Confirm `:443` is intact (`node scripts/tailscale-broker-preflight.mjs`).
3. For a specific quarantined Paperclip-owned port `<P>`, verify with
   `sudo tailscale serve status --json` that `<P>` is the expected loopback
   mapping, then clear it with `sudo tailscale serve --https=<P> off`.
4. Never `reset`; never touch mappings the broker does not own.
