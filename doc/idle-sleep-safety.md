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
   `{ "version": 1, "backgroundWork": "none" }` permits ordinary idle sleep. The
   optional routine protocol below requires a durable host alarm as well. Require the same
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

A matched static UI file served by the admitted, handler-tracked application finishes its request
tracking when its response ends or closes, including a match found after the
client has already disconnected. Unfinished middleware promises remain tracked.
Routers share this application scope. A mounted Express application has hidden
handler promises, so it keeps the existing conservative hold after an aborted
download until the application itself completes the response. An application
without installed handler tracking keeps the same conservative hold. Missing files
continue through the normal fallback and error handlers; they do not exempt
other GET requests or callback-only application work.

## Budget and agent lifecycle work

Budget accounting commits its charge, admission block, and enforcement generation
before returning to its caller. Cancellation delivery runs separately through the
delivery coordinator, using the existing policy version pair and committed run
Stop records. It can finish already-admitted stops during drain, but cannot start
another paid turn. A provider still stopping, an unacknowledged Stop, a pending
policy generation, and unresolved accounting remain sleep blockers.

Agent lifecycle uses the same transaction-aware coordinator. Hire approval,
configuration invalidation, manual commands, and computed agent budget holds
register work before their transaction writes. Company status transitions register
inherited-hold projection; changing a company name, description, or logo does not.
Projection selects only agents whose company pause/archive hold differs from the
committed company state, in pages of 100 under one company accounting transaction
per page. Pause/archive transactions also persist pausing operations for agents
with cancellable runs, reading only those involved agents in batches. Immediate
reactivation can remove an inherited hold but cannot erase an owed Stop; new
provider work waits for lifecycle readiness. Archive activity counts describe
requested pauses and cancellations, not completed provider termination. Agent
and project budget changes never enumerate company peers.

Startup recovers pending lifecycle operations and inherited-hold mismatches.
Thereafter notifications and stored retry/lease deadlines drive work. Stable ready,
paused, rejected, and terminated history does not trigger recurring policy scans.
Pending phases and inherited-hold mismatches block sleep. Lifecycle execution can
verify configurations or resume queued work, so it waits while admission is
draining or the instance is in warm standby; its durable obligation is retained.
A future in-process retry timer does not grant permission to sleep.

These notifications cover the existing single-active-writer ownership model.
Independent SQL writers and additional processes need an explicit wake protocol;
process-local notifications do not provide cross-replica delivery. Worker quiet
alone is not evidence that the host or database actually suspended.

## Scheduled routine wake protocol

Historical failed ephemeral leases and terminal custom-image setup sessions can
become idle only after the host observes deletion of their exact provider
resource. Cloud checks bounded batches on already-awake instances, outside the
readiness path. The optional `environmentInspectLease` plugin RPC is read-only:
it must never reconnect, start, stop, or destroy an allocation. Older workers
without this method remain conservative. Daytona accepts its SDK's typed
not-found response; authentication and transport failures are not deletion
proof. Setup checks require the recorded provider-config fingerprint; lease
checks use the recorded plugin and scoped config, never a replacement binding.
For legacy secret references without a version manifest, only an unrotated
initial version with a matching resolved-value hash establishes credential
identity. Rotated/mutable credentials and ambient Daytona keys defer proof;
not-found under another account cannot establish historical cleanup. Inspection
also rejects an ambient API endpoint override when no endpoint was recorded.
The manager permits at most two outstanding inspection RPCs across workers.
Caller timeouts retain their slots until the actual worker reply or exit;
timeouts cannot accumulate additional provider reads in later sweeps.

Host-owned verification metadata binds the company, environment, resource,
provider handle, optional run, and exact row version. Concurrent resume,
replacement, cleanup, or configuration changes invalidate verification.
Provider-supplied metadata cannot supply this marker. Inspection preserves
failure outcomes and history and does not create a run-continuation receipt.
Normal setup cancellation and timeout preserve the host's recorded config
fingerprint and RPC company scope for later read-only verification.
Retained allocations, unfinished runs/accounting/retries, export intents and
live setup credentials continue to block sleep.

Pending human-only connection setup can wait asleep when no active enabled
connection of the requested purpose exists. Available access reblocks sleep so
the existing reconciliation path can run; answering a setup card continues to
use the normal admission and wake path.
The delivery worker uses the same passive-wait proof to release its local
admission hold. On an already-awake instance it keeps its existing five-second
maintenance cadence, without creating a wake alarm. This catches newly available
access even when its write does not notify the connection queue. Pending real
deliveries and their downstream wake requests still block sleep.
An owned drain pauses passive-only maintenance before it admits tracked work,
so a slow pre-sleep backup can finish with an unchanged generation. New producer
notifications still preempt the maintenance timer and invalidate that backup.

An unconfigured Slack draft can also wait for browser setup when its matching
channel connection is disabled and still a draft. It must have no provider
identity, prior activation/activity, or setup error. Partially configured,
enabled, foreign, and other-provider endpoints remain blockers; accepted chat
deliveries retain their independent checks.
An optional Slack slash-command name is configuration only and does not create
background work. Other setup fields still retain their blockers.

Cloud also reconciles missed routine issue-status hooks in bounded batches on
awake instances. Exact company/routine/issue/run ownership and row locks are
required. The normal routine service records completion or transient failure
from the current issue status; a resumed issue can use its existing continuation
rules. This repairs stale handoff bookkeeping without exempting unprocessed
routine runs or consuming deferred comment requests.
Lock contention and retryable transaction failures defer only that candidate;
other repairs continue, and later sweeps retry the deferred row.

Verified signed Cloud control callers may opt into
`GET /api/instance/task-drain?idleSleepSafety=1&scheduledWake=1&ownerId=<owner>`.
Tenant tokens, browser instance administrators, local implicit actors, and agents
cannot request this extension. Ordinary reports retain their existing behavior.

If all other background-work checks pass, active routines may return
`idleSleepSafety: { version: 2, backgroundWork: "none", scheduledWake }`.
The proof has `version: 1`, `kind: "routines"`, a SHA-256 `generation`, and the
earliest `nextWakeAt` across every company. Only enabled, unarchived schedule
triggers with valid cron, timezone and future `next_run_at` qualify. Unsupported
triggers, setup work, due work, unknown states and more than 10,000 active
triggers keep the instance awake. Inactive triggers do not create obligations.
Active routines without enabled triggers have no timed work. Definitions are
read in the same repeatable-read transaction as the other durable checks.

The host must commit one durable alarm for the exact stack under its live sleep
lease before stopping compute. It must then re-read the same owned report and
require the exact generation and deadline. Generation binds the process, hold
owner and routine/trigger catalog, so restart or schedule edits invalidate it.
No routine definitions or tenant identifiers appear in the proof. Failure to
persist or validate the alarm abandons sleep. Cloud acknowledges persistence
inside its controller; this report alone never authorizes scheduled sleep.

Cloud must start waking early enough for measured startup latency and retry
failed or missed wakes across controller restart. After wake, the existing
routine scheduler owns execution, atomic claims and catch-up rules. Local
scheduling is unchanged for self-hosted instances and whenever Cloud declines
sleep. This first extension covers routines only. Agent timers, plugin jobs,
retries, integrations and unsupported queues retain their existing blockers.
All mutations must enter through the host admission/wake path. Independent
database writers are outside this single-process protocol.

Verify a full scheduled sleep/wake/execution cycle on staging before enabling
this host capability. The [tests](../server/src/__tests__/idle-sleep-safety.test.ts)
cover ownership, future deadlines, changed generations and conservative fallback.

## Passive issues and scheduled monitors

Signed Cloud control callers can request `scheduledWake=2` to include issue
monitoring alongside routines. Earlier hosts requesting `scheduledWake=1`
retain the routine-only rules, including the conservative open-issue check.
Browser administrators and tenant credentials cannot request either extension.

With the second capability, backlog tasks, unassigned todo tasks, explicit
blocked tasks and human-owned tasks may be passive records. Their presence
alone does not require compute. An assigned onboarding first task is also
passive with an idle assignee before its first run, user-authored comment or user-resolved opening
card. This uses the same awaiting-user predicate as recovery; a seeded greeting
does not start work. User input still enters through the host wake path.
Execution locks, automated pending review,
conversation state, unknown state and dependency repair remain blockers. A
blocked task whose blockers have all finished stays awake for reconciliation.
Enabled task watchdogs and unsupported recovery keep their existing checks.
Incoming changes still require the hosting admission and wake path.

An active issue monitor needs a saved future `monitor_next_check_at` matching
its validated execution policy, a company-scoped agent, no outstanding dispatch
claim, and remaining attempts and timeout. Due, malformed, quota-recovery,
unowned and inconsistent monitors keep the workspace awake. Inspection does
not clear schedules, advance attempts or dispatch an agent.

The combined report uses `version: 2` and a scheduled proof with `version: 1`
and `kind: "routines_and_issue_monitors"`. Its deadline is the earliest required
routine or monitor time across all companies. Its generation binds the current
process, idle owner and inspected catalogs. Hosts must acknowledge this known
proof kind, persist the alarm and validate the unchanged owned report before
stopping compute. Existing hosts reject the new kind. Monitor dispatch and
startup catch-up continue through the existing scheduler and atomic claims;
self-hosted scheduling is unchanged. This capability does not cover all future
work in the instance: every other safety check continues to apply.

## Retry history

Retry promotion keeps `scheduled_retry_at` on a run for inspection. That date
is consumed history when the run is terminal, has a finish time at or after the
retry date, and has no accounting work pending. The idle report uses the same
proof for failed ephemeral leases, coalesced wakes, and acknowledged question
responses. A live retry child still blocks through the instance-wide run check.
Unfinished runs, retry dates after the finish time, and pending accounting stay
awake. The inspection does not clear dates or change retry scheduling.

## Retained local workspaces

Local directories for primary projects and Git worktrees do not require an
awake process by themselves. The report permits their retained rows only in
known modes and states, with no runtime configuration, service state, commands,
pending reopen, or cleanup already eligible. Saved environment references alone
are passive. Shared workspaces with a project workspace remain blockers because
they can inherit runtime configuration. Unfamiliar providers, strategies,
configuration and malformed metadata also remain blockers.

This does not delete files, alter retention, or clear workspace records. Future
cleanup eligibility is an earliest allowed time; eligible cleanup can wait for
the next wake. Due cleanup, unfinished operations, runtime leases and runtime
services still keep the instance awake through their separate checks. The host
must keep workspace storage attached across sleep and preserve its backup policy.

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

Terminal workspace recovery also registers a local sleep probe. Incomplete
startup pages and failed recovery remain blockers until a successful pass.
Active cleanup and unresolved producer transactions retain their admission holds.
Cooldown and inspection-backoff timers are maintenance hints over retained domain
rows. They can wait for the next wake and are restored at startup; they do not
create external alarm coverage or exempt other persisted work from this report.

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
cleanup, active routines, integrations, external ingress credentials, and plugin
work block sleep. Completed ordinary run history does not. Less common work
sources conservatively block on any retained records. Active issue watchdogs
block sleep even when their watched issue is complete and no review has started.
Missing migrations, malformed configuration and database errors produce unknown
without exposing SQL or tenant data.

Active `runtime_auth` connections with purpose `ai` are saved credentials, not
independent workers. Their saved configuration does not block sleep. Login
sessions and runs still pass the existing durable checks. Detached subscription
observations and quota reads remain counted through their actual completion,
including token refresh after a quota response times out. Credential-recovery
journals, partial writes and probes block sleep across restart. Empty company
directories left after successful recovery do not; invalid paths and read
failures remain unknown. Credentials and connection records are retained.
Disabled draft connections and saved outbound HTTP MCP connections have no
independent listener. They can permit sleep while accepted calls and credential
work still pass the other fences. MCP connections with a retained GitHub
webhook binding, local stdio processes, channels, and other active transports
remain blockers until their inbound work has a supported wake contract.

With the issue-scheduling capability, pending questions, confirmations,
checkbox confirmations and task suggestions can be passive waits. Their
producer must have finished without retry or accounting debt. The response
audience and continuation policy stay unchanged. Unknown pending siblings,
foreign-company records and unfinished producers block sleep. A resolved card
does not make an otherwise runnable issue passive. The schedule generation
includes response identity and audience, including when only a routine owns
the next alarm.
Merge confirmations remain blockers because GitHub polling can accept them
without a human response and does not yet have a durable wake contract.

Known board escalation actions for stranded work, missing disposition and a
lost review path can also be passive. They require a blocked source in the same
company, board ownership, no automatic wake, no monitor or timeout, and no live
execution binding. The action remains visible and unresolved. Other recovery
causes and autonomous owners remain blockers.

A failed ephemeral lease is history only with successful cleanup, a release
timestamp, and an exact provider termination receipt bound to its company, run,
lease and resource. Its run must be finished without retry or accounting debt.
Pending cleanup claims and export/stop-and-retain intents still block. Failure
labels or cleanup success without that proof do not authorize sleep. Lease
history is retained; this check performs no provider teardown or data updates.
A released local ephemeral bookkeeping lease needs no remote termination
receipt when its exact run has finished and both its provider and environment
are local. It must have no provider resource reference or pending cleanup,
export or retention intent. Unknown drivers and remote resources still block.

Finished login-session history permits sleep only after its promotion claim is
cleared and any retained provider reference has a matching released, expired,
or verified failed ephemeral lease with successful cleanup and a release
timestamp in the same company and environment. The failed lease must satisfy
the same termination and run checks above. Missing cleanup evidence,
`cleanup_pending`, and live login flows
remain blockers. A finished coalesced wake is history only when its exact
company/agent's linked run has finished without retry or accounting debt.
Image-setup history still blocks: promotion can succeed before teardown is
confirmed, so a terminal label does not prove that its provider resource is gone.

Completed question-answer deliveries permit sleep only after acknowledgement
and completion of their exact target run in the same company, without retry or
accounting debt. A fallback without a target run requires its exact question's
finished durable wake receipt in the same company. A coalesced fallback also
requires its exact company/agent's linked run to finish without retry or
accounting debt. The question-history index covers every wake status.
Pending deliveries, missing
completion evidence, and unfinished handoffs still block. Failed deliveries
without a pending target are history; other work checks still apply.

Processed connector-event receipts with a processing timestamp are idempotency
history. Delivered connection-intent outboxes also permit sleep once their
exact accepted wakes finish. A system-retired connection card parked behind a
pending response keeps its undelivered outbox intact; the normal response path
resumes delivery. Pending event application, unfinished wakes and all other
execution checks still block. None of these exceptions fabricates completion
or removes a durable receipt.

Enabled plugins require the current worker's verified idle drain. A version
label does not prove that arbitrary worker code has no background activity.
No plugin approval or configuration bypass is supported. Scheduled and
externally triggered work needs a durable host wake mechanism before it can
permit sleep.

This is a single-process admission protocol. A restart clears the owner. The
host must serialize sleep with deploy/wake operations and bind its final check
to the instance it stops. An unexpected restart after the final check can still
race an external provider stop; a process-local report cannot fence that remote
operation by itself. Multiple replicas require shared fencing. The protocol
does not make existing in-memory-only debt survive an unplanned process crash.

Related public PR #13413 adds runtime-service controller requirements and uses
the same `purpose: "idle"` / `ownerId` vocabulary. This report conservatively
blocks all retained runtime-service state instead of approving such services.

## Muse maintenance

Muse maintenance uses the shared delivery coordinator. Startup reconstructs
existing work and marks incomplete receiver evidence once. Pairing, OAuth grant
attachment/revocation/replay, qualification changes and new assignments notify
the coordinator before their transaction writes. Nested writes wake it only
after the outer transaction settles; uncertain outcomes retain the normal hold.

Unrevoked qualifications schedule their saved expiration time. An instance with
no Muse bindings, or with idle bindings and no qualification deadline, performs
no recurring maintenance SQL after startup. Failed reconciliation retries in
five seconds. Offered, claimed, accepted and not-yet-finalized settled assignments
retain that five-second recovery cadence until settlement; this covers terminal
run writers even when their direct reconciliation path fails. Retained finalized
assignment history does not keep that cadence running. Direct SQL or independent
process writers require explicit integration; startup still reconstructs state.

Warm standby prevents maintenance SQL. An idle drain pauses ordinary dispatch
and passive deadlines through the shared coordinator. Startup and notifications
received during drain retain a memory-only wake until a sweep can run. The wait
does not query the database. Producer uncertainty and
outstanding assignment recovery retain its existing admission rules. Shutdown
awaits the worker before flushing the receiver. The receiver's separate batching
timer remains; an empty buffer performs no database work. Existing Muse durable
sleep blockers, external worker stop evidence, and ingress requirements remain
unchanged. This change establishes database quiet for inactive Muse, not host
sleep eligibility for a configured Muse connection.

## Skill package maintenance

The package delivery worker automatically converts legacy snapshots and versions.
Legacy contents remain authoritative until conversion is verified. Unfinished or
failed conversions, including rows retained while package storage is disabled,
may wait for the next ingress wake and do not block idle sleep. Their persisted
retry dates and package/object/native-asset retention timestamps are earliest
maintenance eligibility, not promised delivery deadlines. Workers reconstruct persisted rows and filesystem
access leases on startup, and use the existing coordinator's drain/standby/shutdown
controls. No external Cloud alarm or provider suspension is established by these tests.
