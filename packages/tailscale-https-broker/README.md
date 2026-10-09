# Paperclip Tailscale HTTPS broker

Least-privilege host broker that manages **only** Paperclip-owned, tailnet-only,
same-number HTTPS-to-loopback listeners for managed branch runtimes.

It exists so the Paperclip app/agent account never gains Tailscale operator
authority (see [PAP-16989](../../)) while still getting automatic trusted HTTPS
previews per branch runtime. Design: [PAP-17049](../../) plan; security contract:
[PAP-17050](../../) threat-model verdict.

Runtime services opt in explicitly; existing services and the primary `:443`
route are unchanged:

```json
{
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

## What it can and cannot do

Supported operations (over a Unix socket, one runtime-service at a time):

- `list` — the caller's own exposures (never returns lease handles).
- `reserve` — atomically reserve an app/HMR pair before either backend binds,
  returning an unguessable, short-lived lease handle bound to the caller,
  runtime ID, ports, purposes, and generation.
- `expose` — redeem that reservation only after `/proc` proves both listeners
  are loopback-only and owned by the configured managed-runtime UID.
- `remove` — remove the caller's own listeners, proven by exact lease handle.

Hard-denied, deny-by-default: Funnel, certificates, Tailscale Services,
`serve reset` / `set-config`, path handlers, arbitrary targets, non-loopback or
wildcard/dual-stack backends, port `443`, privileged/reserved ports, ports
outside the dedicated runtime range, unknown fields, and removal of any mapping
not matching an exact registry + lease + live Serve entry. The primary
`:443 → 127.0.0.1:3100` route is verified structurally **before and after every
mutation** and is never modified.

The socket transport reads Linux `SO_PEERCRED` before admission, admits at most
8 concurrent sockets per resolved UID, and reserves 4 of its 32 global slots
for the configured Paperclip service UID. Connection deadlines destroy the
socket so timed-out peers cannot retain kernel-level connection slots. Missing
or invalid native credentials fail closed; socket permissions are not used as
a substitute identity.

## One-time host installation (`paperclip-dev`)

These steps require **root** and must be run by CloudOps/host owner, not the
Paperclip agent account. They install the broker as a dedicated
Tailscale-operator service account distinct from the Paperclip app account.

1. **Preconditions.** Tailscale is installed and up on the node, the node has an
   HTTPS-capable trusted cert (MagicDNS + HTTPS enabled), and the existing
   `:443 → 127.0.0.1:3100` Serve mapping is present.

2. **Create the dedicated operator account and socket group.**

   ```sh
   sudo useradd --system --home /var/lib/paperclip-tailscale-broker \
     --shell /usr/sbin/nologin paperclip-tsbroker
   sudo groupadd --system paperclip-tsbroker-sock
   # The Paperclip *app* service account must have this as its PRIMARY group so
   # its SO_PEERCRED gid matches the socket group (supplemental membership is
   # intentionally NOT accepted).
   sudo usermod -g paperclip-tsbroker-sock <paperclip-app-account>
   ```

3. **Grant Tailscale operator authority to the broker account only.**

   ```sh
   sudo tailscale set --operator=paperclip-tsbroker
   ```

   Do **not** grant `--operator` to the Paperclip app/agent account (that grant
   was explicitly rejected in PAP-16989).

4. **Create state directories (not writable by the Paperclip app).** The
   packaged unit creates these automatically; for a manual install use:

   ```sh
   sudo install -d -o paperclip-tsbroker -g paperclip-tsbroker-sock -m 0750 /run/paperclip-tailscale-broker
   sudo install -d -o paperclip-tsbroker -g paperclip-tsbroker-sock -m 0700 /var/lib/paperclip-tailscale-broker
   sudo install -d -o paperclip-tsbroker -g paperclip-tsbroker-sock -m 0700 /var/log/paperclip-tailscale-broker
   ```

   The broker refuses to start if the registry path's parent is group/other
   writable.

5. **Build, install the package under `/opt/paperclip`, and install the
   packaged systemd unit.** The unit's `ExecStart` (and the doctor command
   below) run the build output from
   `/opt/paperclip/packages/tailscale-https-broker/dist`, so copy it there
   explicitly. The Linux build requires a C compiler and Node.js headers to
   compile the dependency-free N-API `SO_PEERCRED` addon. The output is
   self-contained (Node builtins plus the compiled addon; no `node_modules`
   needed).

   ```sh
   pnpm --filter @paperclipai/tailscale-https-broker build
   sudo install -d -m 0755 /opt/paperclip/packages/tailscale-https-broker
   sudo cp -r packages/tailscale-https-broker/dist \
     /opt/paperclip/packages/tailscale-https-broker/
   sudo install -D -m 0644 \
     packages/tailscale-https-broker/deploy/paperclip-tailscale-https-broker.service \
     /etc/systemd/system/paperclip-tailscale-https-broker.service
   sudo install -d -m 0750 /etc/paperclip
   sudoedit /etc/paperclip/tailscale-https-broker.env
   ```

   The packaged unit is equivalent to:

   ```ini
   [Unit]
   Description=Paperclip Tailscale HTTPS broker
   After=tailscaled.service
   Requires=tailscaled.service

   [Service]
   Type=simple
   User=paperclip-tsbroker
   # Socket must end up 0660 paperclip-tsbroker:paperclip-tsbroker-sock. Set the group here and
   # the broker chmods the socket to 0660 on bind.
   Group=paperclip-tsbroker-sock
   EnvironmentFile=/etc/paperclip/tailscale-https-broker.env
   ExecStart=/usr/bin/node /opt/paperclip/packages/tailscale-https-broker/dist/main.js
   Restart=on-failure
   NoNewPrivileges=true
   ProtectSystem=strict
   ReadWritePaths=/run/paperclip-tailscale-broker /var/lib/paperclip-tailscale-broker /var/log/paperclip-tailscale-broker

   [Install]
   WantedBy=multi-user.target
   ```

   Put the `BROKER_*` values from the table below in the environment file. Set
   `PAPERCLIP_TAILSCALE_BROKER_SOCKET=/run/paperclip-tailscale-broker/broker.sock`
   on the Paperclip service only if overriding its default.

   Environment variables (defaults in `src/config.ts`):

   | Var | Required | Default | Meaning |
   |-----|----------|---------|---------|
   | `BROKER_NODE_IDENTITY` | yes | — | hostname + boot id; a change forces quarantine + operator reconciliation |
   | `BROKER_SERVICE_UID` | yes | — | UID of the Paperclip **app** account allowed to connect |
   | `BROKER_SERVICE_GID` | yes | — | GID of the dedicated socket group (caller's primary GID) |
   | `BROKER_RUNTIME_UID` | yes | — | UID that owns Paperclip-managed runtime processes (normally the Paperclip app service account); only its loopback listeners are eligible |
   | `BROKER_TAILSCALE_BIN` | no | `/usr/bin/tailscale` | absolute path to the Tailscale CLI |
   | `BROKER_SOCKET_PATH` | no | `/run/paperclip-tailscale-broker/broker.sock` | Unix socket path |
   | `BROKER_REGISTRY_PATH` | no | `/var/lib/paperclip-tailscale-broker/registry.json` | root-owned `0600` ownership registry |
   | `BROKER_AUDIT_PATH` | no | `/var/log/paperclip-tailscale-broker/audit.log` | append-only security audit log |
   | `BROKER_PROTECTED_PORTS` | no | *(empty)* | comma/space separated ports the broker must **never** create, remove, or reclaim — even when its own registry holds a valid lease for them (see below) |

   ### `BROKER_PROTECTED_PORTS` — operator-declared preservation (PAP-17285)

   The long-standing "unknown/manual entries are never modified" invariant is
   *provenance-blind*: it protects only entries the broker has no lease for. It
   therefore could not protect the `42000/52000` mappings, because the broker had
   itself created them for a canary lane that was later retired — so its registry
   still called them owned, while operators had reclassified them as
   must-preserve after failing to attribute them to any live lane. Both views were
   internally consistent, they disagreed, and a fully authorized, shape-valid,
   `:443`-preserving removal destroyed them with no guard able to object.

   A protected port is an **operator assertion that outranks the broker's own
   ownership record**. Enforcement is fail-closed and layered: refused during argv
   construction, denied in `reserve`/`expose`/`remove` with `protected_port`,
   excluded from the allocatable allowlist so no lane can acquire one, and
   asserted byte-unchanged across every before/after snapshot
   (`protected_entry_violation`). A malformed list makes the broker refuse to
   start rather than silently protect nothing; `443` is rejected because the
   primary route already has a stronger, non-optional invariant.

   ```
   BROKER_PROTECTED_PORTS=42000,52000
   ```

   Confirm it took effect before trusting it — `--doctor` echoes the parsed set:

   ```sh
   sudo -u paperclip-tsbroker \
     env $(cat /etc/paperclip/tailscale-https-broker.env | xargs) \
     node /opt/paperclip/packages/tailscale-https-broker/dist/main.js --doctor
   ```

6. **Preflight (read-only, no mutation).**

   ```sh
   sudo -u paperclip-tsbroker \
     BROKER_NODE_IDENTITY=$(hostname) BROKER_SERVICE_UID=... BROKER_SERVICE_GID=... BROKER_RUNTIME_UID=... \
     node /opt/paperclip/packages/tailscale-https-broker/dist/main.js --doctor
   ```

   Verifies: supported Tailscale CLI version, Serve status is readable, the
   primary `:443` route is intact, the registry path is safe, and prints the
   node identity. Exit 0 = ready. It never mutates Serve state.

7. **Enable.** `sudo systemctl daemon-reload && sudo systemctl enable --now
   paperclip-tailscale-https-broker`. Confirm the socket is `0660
   paperclip-tsbroker:paperclip-tsbroker-sock`.

## Upgrade

Deploy new package output to
`/opt/paperclip/packages/tailscale-https-broker/dist`, then
`sudo systemctl restart paperclip-tailscale-https-broker`. On
restart the broker re-reads its root-owned registry and adopts only exact-lease
matches; a changed `BROKER_NODE_IDENTITY` (host reimage / boot-id change) forces
quarantine and operator reconciliation rather than silently re-adopting.

## Uninstall / rollback / opt-out

Rollback disables new exposure and removes only broker-owned listeners; it never
resets Serve or changes the primary route.

1. Disable the exposure flag on the project runtime (Paperclip stops requesting
   `expose`). Existing previews drain on runtime stop.
2. Drain owned listeners: stop each managed runtime so Paperclip issues `remove`
   for its own leases (proven by handle).
3. `sudo systemctl disable --now paperclip-tailscale-https-broker`.
4. Optional cleanup: remove the state dirs and `sudo tailscale set --operator=`
   to drop the operator grant. Do **not** run `tailscale serve reset` — remove
   only the specific per-port Serve entries if any remain.

## Recovery

If a mutation fails partway, the broker removes only the exact listeners it
applied; if exact cleanup cannot be proven it quarantines the affected ports and
reports `cleanup_pending` (partial app+HMR exposure is never reported healthy).
Quarantined ports are not reused until an operator clears them. The append-only
audit log at `BROKER_AUDIT_PATH` records every allow/deny and mutation outcome
(peer UID/GID/PID, operation, runtime UUID, ports, decision reason, before/after
state digests, quarantine/recovery) with lease handles and raw CLI output
redacted.

## Tests

```sh
pnpm --filter @paperclipai/tailscale-https-broker test        # 72 tests
pnpm --filter @paperclipai/tailscale-https-broker typecheck
pnpm --filter @paperclipai/tailscale-https-broker build
```
