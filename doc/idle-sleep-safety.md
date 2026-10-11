# Automatic idle sleep safety

`GET /api/instance/task-drain?idleSleepSafety=1&ownerId=<owner>` adds an
instance-wide `idleSleepSafety` report for instance administrators and signed
Cloud control callers. Ordinary task drains keep their existing behavior.
Company members and agents cannot read this report.

## Hosting protocol

1. Hold external admission at the hosting layer. Queue user requests for wake or
   abort sleep when activity arrives. Do not send traffic into an instance that
   is being stopped.
2. Send `POST /api/instance/task-drain` with
   `{ "purpose": "idle", "ttlMs": 120000 }`. Idle holds require a TTL from 5 to
   300 seconds. Save the returned `ownerId` and `expiresAt`. An existing drain
   returns 409. An unsupported purpose must leave automatic sleep disabled.
3. Poll the report with that exact owner. Only
   `{ "version": 1, "backgroundWork": "none" }` permits sleep. Require the same
   `ownerId`, `draining: true`, zero run/wake counters, and enough remaining TTL
   for the provider stop. `present`, `unknown`, missing fields, or errors must
   keep the instance awake. Do not interpret `quiescent` alone as authorization.
4. Revalidate the same hold immediately before stopping the instance. Keep
   external admission closed through the provider stop. Never use an old report
   after a restart, expired hold, changed owner, or failed validation.
5. If sleep is abandoned, send `DELETE /api/instance/task-drain?ownerId=<owner>`.
   A missing or stale owner cannot release another controller's idle hold. The
   TTL clears an abandoned hold if the controller loses its response.

An idle hold rejects new tenant HTTP requests and WebSocket upgrades with 503
and `Retry-After: 1`. Health checks and authenticated task-drain control remain
available. Ordinary deploy drains do not enable this HTTP gate. The host must
handle retry/wake at its ingress before enabling automatic sleep.
Health and control mutations remain tracked through completion, including
signed bootstrap writes. Only the task-drain read skips request tracking.
Its authentication finishes under a separate work token before entering the
report, so it counts concurrent writes without blocking on its own scan.

## Accepted work and cleanup

HTTP admission is installed before body parsing, authentication, webhooks and
MCP ingress. The Express adapter tracks handler promises in nested routers and
error middleware. Sending a response or losing the client does not complete an
async handler. A callback-only handler that abandons its response without ending it remains a
sleep blocker. An async route that settles after a disconnect releases its
request token; normal cancellation does not permanently block sleep. New routes must be registered before this adapter is installed.
Fire-and-forget work must have durable queue state or use `trackIdleWork`; a
response is never a substitute for tracking that work.
Accepted live-event WebSocket authentication remains counted until its promise
settles, including after the raw socket closes. Detached startup reconciliation
for built-in agents, managed homes and persisted runtime services also remains
counted after readiness until its writes settle.

Scheduler work already in flight remains counted until its promise settles.
Idle holds pause new scheduler admissions. Database backup promises remain
counted through success or failure. Configured periodic backups block sleep by
default. The opt-in checkpoint mode below preserves a final backup instead of
running the timer while asleep. A generation counter invalidates a
scan if tracked work both starts and finishes during inspection. Reports remain
unknown until startup recovery and HTTP tracking are installed.

### Backup checkpoints for idle instances

`PAPERCLIP_DB_BACKUP_IDLE_CHECKPOINT_ENABLED=1` opts an instance with automatic
backups enabled into this mode. Keep its database and persistent backup volume
attached across sleep. All writers must use the instance's admission protocol;
this mode cannot cover independent writers to the same database.
On managed instances, checkpoint-enabled safety reads require a verified signed
Cloud control actor. Tenant instance-admin elevation does not grant platform
backup authority. Self-hosted instance administrators retain operator access.

Each owned safety read first checks local work, plugin drains and durable work.
Known local blockers return before opening a database transaction. If every
other check passes, the server takes a fresh backup with the existing backup
engine and the retention policy from Instance Settings. It reads the full gzip
archive, checks its trailer and nonempty content, and syncs the archive and
directory before returning `none`. The final pre-stop revalidation takes another
fresh backup. Reads can therefore take longer; the host must bound its request
and still leave enough lease time for a confirmed provider stop.

There is no cached backup exemption. Failed, concurrent or untracked backups,
other work during the scan, changed owners and expired holds cannot authorize
sleep. Client timeouts do not clear the backup's in-flight token. Slow backups
may retain an awake instance until a later sleep attempt.

A durable `.idle-backup-wake-required` marker is written before the dump.
No recurring duplicate archives are produced while the instance is asleep.
The last pre-sleep archive and existing history stay on persistent storage;
no retention pruning runs during sleep. On restart, the server attempts a fresh
backup before enabling idle eligibility, then resumes the normal interval.
Only a verified new backup clears the marker. Failure keeps it for the next
scheduled retry. Disabling automatic backups explicitly still disables this
startup backup. Disabling only checkpoint mode restores the sleep blocker and
continues to honor an existing restart marker.

This does not replace filesystem backups, encryption-key recovery or off-provider
disaster recovery. Validate restoration of a staging checkpoint before enabling
the flag on customer instances.

The report inspects accounting and sandbox-cleanup spools directly. Any entry,
including malformed JSON, temporary files and failed write probes, blocks sleep.
Read errors and invalid spool paths return unknown. Recovery readers that skip
bad records cannot certify an empty spool.

An orphan cleanup token starts before its spool write and remains held through
buffering, queue splices, flush retries and buffer overflow. It ends only after
the database owns cleanup. Queued usage receipts stay counted until capture
settles. If receipt capture and the database failure fence both fail, a token
continues to block sleep until the failure fence is durably written. A query
that updates zero rows does not clear that debt. Unrecoverable cleanup requires
operator reconciliation; this API does not discard it to save compute.

## Persisted work and limits

The report checks all companies in one bounded read-only database transaction.
Queued and orphaned runs, timers, retries, accounting debt, unfinished issues,
cleanup, active routines, integrations, external API credentials, and plugin
work block sleep. Completed ordinary run history does not. Less common work
sources conservatively block on any retained records. Active issue watchdogs
block sleep even when their watched issue is complete and no review has started.
Missing migrations, malformed configuration and database errors produce unknown
without exposing SQL or tenant data.

Finished login-session history permits sleep only after its promotion claim is
cleared and any retained provider reference has a matching released or expired
lease with successful cleanup and a release timestamp in the same company and
environment. Missing cleanup evidence, `cleanup_pending`, and live login flows
remain blockers. A finished coalesced wake is history only when its exact
company/agent's linked run has finished without retry or accounting debt.
Image-setup history still blocks: promotion can succeed before teardown is
confirmed, so a terminal label does not prove that its provider resource is gone.

Completed question-answer deliveries permit sleep only after acknowledgement
and completion of their exact target run in the same company, without retry or
accounting debt. A fallback without a target run requires its exact question's
finished durable wake receipt in the same company. Pending deliveries, missing
completion evidence, and unfinished handoffs still block. Failed deliveries
without a pending target are history; other work checks still apply.

Every enabled plugin blocks sleep. A version label does not prove that arbitrary
worker code has no background activity. No plugin approval or configuration
bypass is supported. Scheduled and externally triggered work needs a durable
host wake mechanism before this restriction can be relaxed.

This is a single-process admission protocol. A restart clears the owner. The
host must serialize sleep with deploy/wake operations and bind its final check
to the instance it stops. An unexpected restart after the final check can still
race an external provider stop; a process-local report cannot fence that remote
operation by itself. Multiple replicas require shared fencing. The protocol
does not make existing in-memory-only debt survive an unplanned process crash.

Related public PR #13413 adds runtime-service controller requirements and uses
the same `purpose: "idle"` / `ownerId` vocabulary. This report conservatively
blocks all retained runtime-service state instead of approving such services.
