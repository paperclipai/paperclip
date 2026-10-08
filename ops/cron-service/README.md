# HELA-12871: host cron identity boundary

The separate seven-flow board-key isolation package and cutover checklist for
HELA-13399 live in [board-watchers/README.md](board-watchers/README.md).

This directory stages the watchdog and quota cron changes. `prepare-host.sh --check` checks
the reviewed host source hashes, strips the old DB password literals from the
staged copies, applies the patches, and checks Python and shell syntax. It does
not change the live host. Running without `--check` requires root and an explicit
`HELA12871_FOUNDER_GO=1`; it installs code and units but does not enable them or
touch live credentials.

## Boundary

| Job | Execution | API identity | Secret source |
| --- | --- | --- | --- |
| Agent watchdog | `pc-cron-watchdog`, root-owned script | `cron_service/agent_watchdog`, fixed alarm issue IDs | service home `.secrets`, mode 0400 |
| Quota re-wake | `pc-cron-quota`, root-owned script | `cron_service/quota_rewake`, nudge orders only | service home `.secrets`, mode 0400 |

Frontend deploy is a separate eighth contour under HELA-12871. Its agent-accessible
socket can authorize caller-chosen incidents, so this seven-UID package does not
install a broker or grant `cron_service/deploy_frontend`. Its cutover requires a
separate security fix and review; leave its existing cron entry untouched here.

The watchdog and quota scripts still query the control-plane DB. The staged
copies use the `pc_watchdog` and `pc_quota` libpq service aliases. Their units
point `PGSERVICEFILE` and `PGPASSFILE` at service-private files.
The old DB password literal exists in agent-readable host copies and backups:
**rotate that DB password and verify the old credential is rejected at cutover**.
Use dedicated DB roles with only the needed tables/functions, subject to the
architecture verdict in the linked issue. Moving files alone does not close the
old DB path.

## Cutover after founder go and architecture/security review

1. Create two non-executing Paperclip service agents in the target company.
   Create one API key for each with the matching `cron_service` scope. The
   watchdog scope lists the four current alarm issue UUIDs. Record key IDs,
   not token values. Creation and revocation must be done through the board
   authority; no agent impersonation. The watchdog key's responsible user needs
   `agents:configure` for agent recovery; normal responsible-user authorization
   still applies after the service scope guard.
2. Run `prepare-host.sh --check`. If a source hash changed, refresh the patches
   and review; do not force patching. For root staging, fetch the approved commit
   into a **root-owned, clean** checkout under
   `/opt/paperclip-cron-release/<sha>` and set `HELA12871_APPROVED_SHA` to that
   exact commit. Never execute a root installer from an agent-writable worktree.
   Keep the existing crontab active until each service is configured and its
   smoke passes.
3. Under `/var/lib/pc-cron-watchdog/.secrets/`, install the watchdog token as
   `paperclip-cron-agent-watchdog.token` and a `paperclip-bridge.env` containing
   only `PAPERCLIP_API_URL`. Under `/var/lib/pc-cron-quota/.secrets/`, install
   `paperclip-cron-quota-rewake.token`. Set owner to the respective service UID
   and mode 0400; service home and `.secrets` must deny `paperclip-user` traversal.
4. Create service-private `pg_service.conf` and `pgpass` files for watchdog and
   quota, with their respective aliases and dedicated DB roles. Create a
   root-owned `/etc/paperclip-cron/watchdog.env` (it may be empty),
   and `/etc/paperclip-cron/quota.env` with `QR_AGENT_ID`, `QR_COMPANY`, `QR_API`. Keep
   `WATCHDOG_PG`, `QR_PG`, and broad API tokens out of these env files. Copy
   quota `state.json` and watchdog poke state into the new service homes with
   matching ownership. Do not install a board key or `PAPERCLIP_OPS_TOKEN`.
5. Verify one manual watchdog and quota service tick, without enabling timers.
6. Remove only the two old cron entries (watchdog and quota), then enable the two
   new timers. Keep an exact crontab backup. Do not touch CI workflows or runs.
7. Confirm two normal ticks per job. The new keys' `last_used_at` must increase;
   ordinary logs must have no 401/403. Revoke the two old `standard` keys and
   remove the old token files from agent-readable locations. Rotate the old DB
   password, scan agent worktrees/backups for readable copies, and verify the old
   credential no longer authenticates. Do not log credentials or API responses
   that could contain them.

## Negative and positive smoke

- As `paperclip-user`, `test -r` must fail for both new token sources and
  service-private libpq files. Repeat in ordinary local shell, ACPX shell, sandbox/remote
  execution, and a copied worktree. Record UID, path, and boolean result only.
- Start the watchdog once and verify agent recovery plus alarm re-arm/comment;
  start quota once and verify a scoped nudge order. Confirm their keys cannot
  call a forbidden endpoint or mutate an unrelated issue. Direct agent shell
  calls with its own run JWT must not gain cron-only rights. Capture only status
  codes, issue IDs, and `last_used_at` timestamps.
- Run the existing run-scoped JWT regression suite before and after API rollout.

If a smoke fails before revocation, stop the new service/timer and restore only
the old cron entry for that job within the approved window. After revocation,
repair or reissue the scoped service key; never restore an agent-readable
`standard` key.
