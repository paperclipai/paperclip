# HELA-13399: staged host package for seven scoped watchers

This integrated tree combines staged HELA-12871 commit
`561c67b8830348feee6e52181ed1b6b7c0e93e79`, the HELA-13399 host package,
and the scoped API routes. The seven-UID/API/test-DB fixture is in
`server/src/__tests__/host-watcher-key-routes.integration.test.ts`. No key, host
schedule, unit, or credential was changed while creating this package.

## Trigger and grant map

The private Paperclip source for the five `host_watcher` rows is
`/var/lib/<UID>/.secrets/paperclip.token`; watchdog uses
`/var/lib/pc-cron-watchdog/.secrets/paperclip-cron-agent-watchdog.token` and
quota uses `/var/lib/pc-cron-quota/.secrets/paperclip-cron-quota-rewake.token`
(service owner, mode `0400`). Each
identity has exactly its own narrow scope: `cron_service` for watchdog/quota
and `host_watcher` for disk, three PR watchers and fleet. No board key or
`PAPERCLIP_OPS_TOKEN` fallback is permitted. GitHub read-only credentials for
the three PR watchers have the same private parent but use `github.token`.

| Old trigger / flow | Service UID and new trigger | Fixed Paperclip grant | Other private source |
| --- | --- | --- | --- |
| crontab 18, watchdog every 2m | `pc-cron-watchdog`, staged timer | recover stuck agents; monitor/comment only four fixed alarm IDs from HELA-12871 | `pc_watchdog` libpq service, `PGSERVICEFILE`/`PGPASSFILE` |
| crontab 48, disk-pressure GC strict branch, and HELA-14308 urgent trigger | GC remains agent UID using root-owned `/opt/paperclip-cron/disk-pressure-gc-agent.sh`; `pc-disk-guard` socket reporter | `host_watcher/disk_guard`: `PATCH todo+comment` only HELA-12595 on escalation; routine note stays in local disk log | no DB credential in agent GC; reporter socket grants a bounded fixed-issue escalation capability |
| former crontab 77, frontend PR #923 | `pc-watch-12320`, **timer remains disabled** | `host_watcher/pr_923`: `GET`, `PATCH blocked→todo`, `POST` bounded comment only HELA-12380 | GitHub repo read token only if explicitly reactivated |
| former crontab 76, backend PR #1198 | `pc-watch-12340`, **timer remains disabled** | `host_watcher/be_1198`: `GET`, `PATCH blocked→in_progress`, `POST` bounded comment only HELA-12343 | GitHub repo read token only if explicitly reactivated |
| former crontab 78, frontend PR #1042 | `pc-watch-12359`, **timer remains disabled** | `host_watcher/fe_1042`: `GET`, `PATCH blocked→in_progress`, `POST` bounded comment only HELA-12359 | GitHub repo read token and root-owned `/etc/paperclip-cron/fe-release-sha` only if explicitly reactivated |
| crontab 54, quota nudge every 10m | `pc-cron-quota`, staged timer | own nudge/create/close only; no direct cross-assignee restore | `pc_quota` libpq service, `PGSERVICEFILE`/`PGPASSFILE` |
| crontab 43, fleet hourly | `pc-fleet-watch`, hourly timer | `host_watcher/fleet_hourly`: comment only HELA-6783; create only its bounded child triage issue assigned to Bravo-2 | `pc_fleet_watch` read-only libpq service |

The disk GC's former direct DB lookup of the owner's quota wall is removed:
until a narrowly scoped status route exists, the reporter writes the fixed
HELA-12595 escalation without an extra fallback mention. Routine notes are
kept in the bounded agent-side `disk-guard.log` and never sent through a wider
API credential. This prevents the agent UID from retaining a broad DB
credential. The agent UID can call the fixed disk socket with only a `critical`
event code. The separate service measures free space on `/` and the mounted
sdb volume itself against fixed alarm thresholds (10/10 GB), and creates the
board comment from its own template. An arbitrary agent message or a critical
event without measured pressure is rejected. The agent cannot read the reporter
key, choose another issue/API path, or place its text in a service-authored wake.
The reporter allows one immediate measured alarm per volume per two hours,
whether the service timer or the GC socket triggers it. A socket request cannot
create another immediate wake after the service timer. If pressure is critical
on every service sample for ten minutes after that first alarm, only the timer
can send one persistent-pressure follow-up, with its own two-hour limit. This
recheck remains available after a failed GC even when the socket is saturated
or a socket request was already suppressed. One healthy sample restarts the
ten-minute observation. The follow-up does not prove a GC sweep completed.
Socket reads have a two-second absolute deadline; four workers handle at most
eight active or queued clients, and concurrent valid signals share one cooldown
decision. An independent service
check starts when the service is enabled at boot and repeats every 30 seconds,
measuring the same fixed volumes and sending the same scoped alarm when pressure
is real. Saturating the agent-accessible socket cannot suppress that service-side alarm.
The sdb alarm threshold matches the farm GC's 10 GB post-sweep threshold;
the separate strict sdb cleanup escalates only below 8 GB.
The wrapper checks the root and sdb strict tiers even when its farm GC roots are
healthy. If a critical farm sweep leaves the volume below its threshold, its
second alarm uses the reporter's fixed escalation action. A successful alarm
sets a two-hour cooldown for the volume measured after the sweep in the
agent-side disk state directory.

On 03.10.2026 the uid-1000 crontab has no active row for any of the three PR
watchers. PR #1198's old source path is absent; PR #1042's source is in
`helloprint/qa-12359/watch-archive/`. The archived #1042 SHA and remaining
#923 source SHA are pinned by `prepare-host.sh`; reappearance of either removed
path fails the check. All three PR timer files lack an `[Install]` section and
must remain disabled. Reactivation needs a fresh owner request, current PR/card
review, a newly approved timer revision, and a dedicated key. #1042 also needs
a root-owned release SHA attestation.

The disk source changed after 30.09 to add the approved closed-card Docker
image lever. The staged copy retains that lever and its apply-time gate, while
keeping helper output restricted to numeric counters. Quota source changed on
01.10 to cover additional failed-run classes; the base installer pins the new
hash and its sanitizing patch is verified against those bytes. Any later drift
halts the relevant installer before staging.
On 04.10 HELA-14308 added own crash-report cleanup, a three-hour build-cache
lever and an urgent five-minute trigger. The sanitized strict-tier copy retains
those levers and the off-schedule marker. The child installer pins both the
current strict-tier source and the urgent helper, so further host changes halt
the staged cutover until reviewed.

Frontend deploy in HELA-12871 is an eighth, separate contour excluded from this
package. Its broker and API capability require their own security fix and review;
no frontend-deploy scope, socket, or unit is included here.

## Review and dry run (no root, no live mutation)

From the HELA-13399 worktree:

```sh
bash ops/cron-service/prepare-host.sh --check
bash ops/cron-service/board-watchers/prepare-host.sh --check
python3 -m unittest discover -s ops/cron-service/board-watchers -p 'test_*.py' -v
bash ops/cron-service/board-watchers/probe_uid_boundary.sh
bash ops/cron-service/board-watchers/probe_disk_wrapper.sh
systemd-analyze verify ops/cron-service/board-watchers/*.service \
  ops/cron-service/board-watchers/*.timer ops/cron-service/board-watchers/*.socket
PAPERCLIP_TEST_POSTGRES_RESERVED_PORTS=5432,54330 \
  PAPERCLIP_HOST_PACKAGE="$PWD/ops/cron-service/board-watchers" \
  PAPERCLIP_HOST_UID_HTTP_PROBE=1 \
  pnpm exec vitest run server/src/__tests__/host-watcher-key-routes.integration.test.ts
```

The opt-in Vitest probe starts its own ephemeral PostgreSQL instance, issues
seven distinct fixture API keys, then runs seven Docker UIDs against real HTTP
routes. Each UID can read only its own private credential and must produce one
allowed and one denied response. UID 1000 reads no private credential and its
unauthenticated API request returns 401. The fixture never uses live keys.

Both installers compare exact reviewed host script SHA-256 before patching or
staging. The HELA-12871 installer also hashes its copied source bytes after
copying, closing a source replacement race. The child installer uses committed
sanitized copies, never executes code from the agent home, and rejects a
silently revived PR #1198/#1042 script. Inspect the integration diff from its
reviewed source base: `git diff 8235674d4c47..HEAD -- ops/cron-service`.

## Root window after separate founder go

1. Confirm code + security approvals, API scope implementation, seven synthetic
   real-route/test-DB grant checks, and run-scoped JWT regression. Record the
   immutable approved SHAs of HELA-12871 and HELA-13399. A root operator
   creates an independent clean checkout under `/opt/paperclip-cron-release/<sha>`.
   Before **executing** either installer, inspect `namei -l`/`realpath` on the
   release path, its `.git`, both installer scripts, `/usr/bin/python3`,
   `/usr/bin/psql`, `/opt`, `/etc/systemd/system`, and every parent: root-owned,
   not writable by uid 1000, no symlink into agent-writable storage.
2. With explicit `HELA12871_FOUNDER_GO=1` and `HELA12871_APPROVED_SHA=<sha>`, run
   the base installer `ops/cron-service/prepare-host.sh`. With
   `HELA13399_FOUNDER_GO=1` and `HELA13399_APPROVED_SHA=<sha>`, run
   `ops/cron-service/board-watchers/prepare-host.sh --install`. These only
   create users/state dirs and stage root-owned code/units. No timer/socket is
   enabled and no crontab is changed by the installers. Recheck `namei -l` on
   each `ExecStart`, `ExecStartPre`, `WorkingDirectory`, Python import, unit,
   env file and all parent directories; reject any writable or redirected
   execution path. `systemctl cat` must match the approved files.
3. Board authority creates independent service agents/keys for the four active
   flows (watchdog, disk, quota, fleet) with exactly the grants above. Reserve
   separate identities for the three retired PR watchers but issue no live key
   and no GitHub token until each is explicitly reactivated. Install each active
   Paperclip token only in its service-private `.secrets` directory, owned by
   that UID with mode `0400`; parent mode `0700`.
   Create root-owned `/etc/paperclip-cron/<service>.env` (mode `0400`) with the
   fixed `PAPERCLIP_API_URL` origin and nonsecret configuration only. Watchdog
   also needs its private `paperclip-bridge.env` containing only the API URL.
   Provision service-private GitHub read tokens only for explicitly reactivated
   PR watchers.
   Define libpq service aliases `pc_watchdog`, `pc_quota`, `pc_fleet_watch` in
   service-private `pg_service.conf` and passwords in service-private `pgpass`.
   DB grants must follow HELA-13316: watchdog narrow read/reap function, quota
   read-only projections, fleet read-only company projections; no shared broad
   DSN, password in argv, SUPERUSER, BYPASSRLS or arbitrary table write.
4. Save an exact uid-1000 crontab backup and diff each old row, including the
   five-minute HELA-14308 urgent trigger. Enable and start both
   `pc-disk-guard.socket` and `pc-disk-guard.service`; verify the service
   remains active without a socket client and its autonomous pressure check runs
   before the agent-side GC. Prove the socket's fixed issue operation, then switch
   the disk row to the root-owned wrapper under uid 1000. Set the urgent row's
   `DPGC=/opt/paperclip-cron/disk-pressure-gc-agent.sh`; verify its dry-run
   target and one off-schedule scoped tick. The urgent helper must never call the
   old broad-key script after cutover. For each other active flow,
   run one manual scoped tick, compare output/status and `last_used_at`, then
   replace exactly its old cron row with the reviewed timer. Keep all three PR
   watchers retired. Do not alter CI or unrelated cron rows. Verify two normal
   ticks per active flow; absent 401/403 and bounded issue writes are PASS.
5. From uid 1000 local shell and copied worktree, `test -r` on **all** new token,
   GitHub and DB files must be false; `test -w` on all new code, units, env and
   every execution parent must be false. Repeat with ACPX and sandbox/remote
   contexts in HELA-13321. For each service identity, require one allowed and
   one forbidden real API operation; direct agent run JWT must not gain a
   `cron_service` or `host_watcher` grant and must still work for its ordinary run-scoped route.
   Keep only UID, read/write booleans, HTTP codes, issue IDs, timestamps and
   test counts in evidence. Inspect logs for token/DSN strings without copying
   the strings into the report.
6. Only after all seven routes and old references are accounted for, revoke the
   common board key, its backup/aliases and old agent-readable cron keys.
   Rotate the exposed DB credential and prove its old form rejects access.
   Search worktrees/backups for stale credential copies by filename/metadata
   and authorized safe scan; do not paste secret values into logs or issues.

## Retire or translate before broad-key revocation

The inventory lists additional agent-writable paths that are not active cron
consumers. Explicitly retire them or give each an approved narrow root-owned
path before any manual restart: `hela-11351-pr913-watch.py`,
`hela-12331-pr924-watch.py`, `hela-12342-merge-watch.py`,
`hela-12350-merge-watch.py`, `hela-12351-pr947-watch.py`,
`hela-12354-pr1229-watch.py`, `hela-2927-pr945-watch.py`,
`hela-3060-docs560-watch.py`, `hela-3060-merge-watch.py`,
`hela-4551-pr-watch.py`, `hela-12332-merge-watch.py`,
`hela-12073-stage2-watch.py`, `hela-12050-integration-watch.py`,
`hela-8726-ci-watch.py`, `hela-8726-postmerge-watch.py`, the historical
`*.selftest.py` fixtures, `helloprint/hela10650-postmerge-handoff.sh`,
`bin/closed-card-gc/apply_pnpm_store_dir.py`, `apply_uv_link_mode.py`, and
the manual `helloprint/qa-11388`, `qa-11425`, `qa-11383`, `qa-11318` helpers.
The archived PR #1042 source is included. None may silently reuse the broad
board credential after cutover. See HELA-13348 inventory for path/operation
details; also check backup files and the bridge alias whose equality to the
board key has not been established.

## Rollback

Before old-key revocation, a failed scoped tick: stop **only that** new
timer/socket/service, restore its exact saved cron row, and inspect its scoped key,
DB/GitHub role, and root-owned path. Do not edit CI. After revocation, never
reintroduce an agent-readable broad key or old DB password: repair/reissue the
narrow identity or keep that watcher disabled with an explicit owner/incident.
For disk GC, retain the agent-side GC under uid 1000 but stop only its new
reporter path if it fails; restore the exact old row only inside the approved
pre-revocation window. Any failed privilege probe, secret in logs, 401/403,
missing tick or unauthorized issue write is FAIL and halts the cutover.
