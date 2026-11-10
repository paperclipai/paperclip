# Automatic idle sleep safety

`GET /api/instance/task-drain?idleSleepSafety=1&ownerId=<owner>` adds an
instance-wide `idleSleepSafety` report for instance administrators and signed
Cloud control callers. Ordinary task drains keep their existing behavior.
Company members and agents cannot read this report.

Cloud callers carrying full idle catalogs use `POST /api/instance/task-drain/status`
with the same read query and `{ "idleCapabilities": ... }` JSON body. A short
`task-drain:read-body` control JWT binds the exact raw-body SHA256. The existing
10 MiB JSON limit, fatal UTF8 decoding, strict catalog parsing, stack/action/expiry
checks and exact byte digest all apply before consuming the single-use request ID
or installing any capability. Embedded catalogs and body digests cannot be mixed.
Unsigned bodies and browser authority alone cannot authorize this Cloud-only read.
GET remains compatible; POST drain start and DELETE stop are unchanged.


Instance administrators and signed Cloud control callers may add
`idleSleepDiagnostics=1` to an owned safety request for fixed-key blocker
diagnostics. This explicit one-shot read evaluates all current predicates in
the same bounded snapshot, and can reconnect/wake the database. Do not poll it
during a suspension observation window. The normal report and its early local
and plugin short circuits are unchanged when the option is absent.

The optional `diagnostics` field reports `none`, `present`, `unknown`, or
`not_checked` per reason. `complete` describes applicable read-inspection
coverage, never stop authorization. Diagnostics do not initiate backup dumps
or unsafe plugin RPCs. Skipped checkpoints remain `not_checked`; unknown or
skipped checks never grant a safety `none`. A changed hold or tracked-work
generation invalidates the observation. Only fixed keys and states are
returned, with no tenant records or error details. See the
[complete reason and traffic inventory](plans/2026-11-02-sleep-blocker-inventory.md).

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
signed bootstrap writes. Only the exact GET task-drain read and POST task-drain/status body read skip request tracking.
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

## Retained completion history

The retained chat, tool-review, browser, decision, transfer, public-MCP and
external-agent families use their owning domain's completion receipts. Inspection
does not delete history, expire credentials, cancel work or shorten retention.
A terminal label alone is insufficient. Missing, contradictory, malformed or
foreign company/task/run/binding references keep the instance awake.

Chat input can remain work after processing because its exact wake still owns
the conversation head. Publications retain provider ambiguity, endpoint leases
and file-transfer obligations. Tool reviews retain invocation completion,
interaction projection and continuation delivery. Browser runs require drained
events and settled/released accounting; a stopped browser must belong to the
same closed session. Decision success requires the selected option's full effect
manifest, matching ordinal/type/target receipts and audit records. The owning
dismissal, explicit recovery stop and reviewed archive paths have separate proofs.
Their continuation and archive-notification outboxes remain independent barriers.
Failed company transfers remain resumable. Completed transfers require their
recorded manifest, exact part receipts and matching counts. Completed/cancelled
transfers still block while their registered local spool contains cleanup work.

Chat control tokens can remain issued or become expired after another actor
resolves their canonical interaction. Their exact interaction, publication and
conversation receipts establish completion; a token status alone does not.
Provider submission receipts do not exempt pending source wakes or publications.
Photon attachment provenance remains immutable history after ordinary attachment
removal, but any surviving metadata must agree with its recorded identities and
hashes. This proof establishes completed registration, not storage cleanup.

Public-MCP upload cleanup requires both the existing cleanup stamp and a new
verified-cleanup stamp. Ordinary attachment and issue removal write this proof
only after successful object deletion and an absence readback. Legacy cleanup
stamps are not backfilled: the existing bounded opportunistic sweep can verify
expired or orphaned uploads. Reissuing an uncommitted upload clears both stamps;
a committed/deleted request replay preserves them. An expired or cleaned upload
cannot accept a still-valid old transport ticket.

Voice report refresh remains work for the owner's full 24-hour window after a
provider session ends, even when the report is available. Live session recovery,
unconfirmed inbound cleanup and ambiguous reply submission still block. A
completed provider submission does not prove spoken playback. Speko setup also
requires the existing successful whole-configuration receipt after its individual
tool and webhook writes. Discord command registration retains its own future
check; a completed command invocation does not retire that deadline.

Waiting agent conversations can be passive containers under both ordinary and
scheduled inspection. The same narrow proof requires the exact conversation
agent/company/user, waiting state, no checkout, active run, accounting, monitor
or pending delivery, and a finished wake for every accepted user-comment outbox
entry. An idle presentation state does not exempt an ordinary runnable task.

Sandbox creation records in `pending` or `needs_reconciliation` remain blockers,
including manual uncertainty after company deletion. The pending-only catalog
omission predates the new startup-cleanup recovery path; no complete-instance
unsafe sleep outcome has been demonstrated. A late identified resource transfers
its obligation to the exact cleanup lease, and only the owning successful cleanup
can resolve that creation. Settled startup cancellations without a committed
native result manifest remain conservatively blocked by native finalization;
their cleanup marker alone is not a history exemption.

Workspace runtime inspection also reads the owner's process-local resource
state. Startup reconstruction must succeed before that probe becomes quiet.
Adopted/live services, provisioning/control/replacement work, live allocation
claims and quarantined exposure ports remain barriers alongside durable rows.
Reset, failed reconstruction and unresolved desired-state restart cannot reuse an
earlier quiet proof. The probe performs no SQL, network request or cleanup and
adds no timer. A stopped row cannot hide a surviving registered process.

MCP completion receipts do not exempt their downstream task, subscription or
upload cleanup. Active grants/subscriptions and Dot/Muse bindings/credentials
retain their transport/deadline blockers. Revoked or expired credential history
does not grant authority on the next request. A fenced external assignment is
not worker termination proof, and Muse transport notification is not input
consumption. Released Muse holds require their actual settlement/attestation
path. Dot stop holds remain unsupported because that owner has no completed
worker-stop receipt. Grok Bot shares Dot tables but has independent routine and
dispatch/recovery obligations; even revoked Grok bindings retain their blocker.

Action/provider variants without an established receipt proof remain blocked.
This includes Photon notice lineage and unqualified legacy action results,
adapter-managed runtime resources, and active persistent transports. These
limits are not evidence of deployed wake support. Existing hosting admission,
generation, accounting, finalization and resource-cleanup checks still apply.

## Native reply recovery

Committed native replies use the shared delivery coordinator and its persisted
retry deadlines. One pass checks at most four independent tasks at a time.
Checks for the same company and task run in candidate order within the batch.
Other scoped deadline workers remain serial unless their owner enables concurrency.
Drain retains unstarted checks, and shutdown waits for every admitted check before
releasing tracked work. Completed history creates no recurring discovery reads;
new committed work reactivates the existing notification path. Pending reply
obligations keep their existing sleep blockers.

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

If a failed ephemeral lease has no usable local inspection path, a managed
Daytona instance can ask Cloud for a cleanup-only absence receipt. Cloud checks
the stack's historical credential organization and reads the exact allocation
with its manager credential. Only confirmed absence can produce a signed receipt
bound to the stack, company, environment, lease, provider handle and nullable run.
The separate cleanup type and audience cannot authorize run recovery. Older
Cloud servers, unsupported providers, invalid signatures, changed organizations
and failed reads leave the lease unresolved. Existing bounded cleanup batches
and retry deadlines own these reads; no new idle polling is added. An explicit
local provider observation is retained rather than replaced by this fallback.

Host-owned verification metadata binds the company, environment, resource,
provider handle, optional run, and exact row version. Concurrent resume,
replacement, cleanup, or configuration changes invalidate verification.
Provider-supplied metadata cannot supply this marker. Inspection preserves
failure outcomes and history and does not create a run-continuation receipt.
Normal setup cancellation and timeout preserve the host's recorded config
fingerprint and RPC company scope for later read-only verification.
Retained allocations, unfinished runs/accounting/retries, export intents and
live setup credentials continue to block sleep.

For a reused remote allocation, a completed predecessor can resolve termination
through the final owner's destruction receipt only when the full host-recorded
lease handoff chain matches. Company, agent, task, workspace, environment, provider
and allocation identities must agree. A stopped successor, broken handoff or
unrelated owner grants no cleanup authority. This resolution does not rewrite
historical leases, execute remotely or claim that uncollected files were saved.
The normal agent-file recovery worker retains the no-save outcome and completes
cleanup after confirmed destruction. A completed cleanup receipt with a stale
retry deadline is reconciled once through the existing deadline worker. Clearing
that deadline compares the receipt so a concurrent cleanup obligation is kept.

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

Retained native response presentation also continues after web readiness. Its
fair scheduler and persisted retry deadlines remain in effect; in-flight work
stays counted for idle and is joined at shutdown. Web readiness does not require
the retained reply queue to become idle.

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

#### Repeatable local checkpoint qualification

Run the qualification command only against two dedicated, disposable PostgreSQL
DBs with names that end in `_test`. Provision the source and an empty restore
DB first. Use a migrated source when testing the full sleep-safety scan. The
command does not create, drop, or migrate databases. It creates a small fixture
schema in the source. It refuses an existing fixture and any nonempty restore
target. The restore engine uses `--clean`, so never use a DB that holds work.

Set `PAPERCLIP_BACKUP_CHECKPOINT_SOURCE_TEST_DATABASE_URL` and
`PAPERCLIP_BACKUP_CHECKPOINT_RESTORE_TEST_DATABASE_URL`. The command rejects
partial configuration, unsafe database names, URL database overrides, and the
same actual server/database even through different host names. Set
`PAPERCLIP_PG_DUMP_PATH` and `PAPERCLIP_PSQL_PATH` when the matching PostgreSQL
binaries are outside `PATH`.

```sh
pnpm --filter @paperclipai/server exec tsx scripts/qualify-idle-database-backup.ts /absolute/new/output-directory pg_dump
```

Use a fresh source/restore pair and output directory for a second run with
`javascript` as the last argument. This exercises the supported fallback engine
separately. The command verifies the full archive, syncs its bytes and directory,
restores it, checks relational, Unicode and null values, and verifies binary
scalars and one- and two-dimensional arrays, including empty bytes, empty arrays
and null elements, with array dimensions and bounds preserved. It enforces the
restored foreign key and checks identity sequence progress. It writes a JSON
receipt with binary versions, database names, archive size/hash, and results.
Archive hashing reads a bounded stream rather than loading the archive into memory.
It does not write credentials to the receipt. The fixture rows remain available
for inspection. Dispose of these owned databases through the normal test-owner
workflow after closing their clients.

The integration suite is
`server/src/__tests__/database-backup-checkpoint-qualification.integration.ts`. Local
runs use `pnpm --filter @paperclipai/server exec vitest run --config vitest.backup-qualification.config.ts`, require the same explicit URL pair, and use
bounded clients. The dedicated Backup checkpoint qualification CI job provisions
both fixtures and matching PostgreSQL clients. Missing URLs or clients fail this
required integration invocation; it is separate from the default unit suite. The suite
also tests the production backup owner under slow dumps, changed drain ownership,
lease expiry, changed work generation, interrupted checkpoint creation, failed
wake backup, and successful marker recovery. The filesystem and scheduling
suites separately verify sync ordering, integrity failure, retry, drain/resume,
and the normal interval after wake. Set `PAPERCLIP_BACKUP_QUALIFICATION_RECEIPT`
to retain its JSON evidence and temporary archives.

These results prove a local logical backup and restore. A writable directory and
successful `fsync` do not prove that a provider volume stays attached across a
compute stop. Before enabling checkpoint mode, separately verify the deployed
backup flags, provider volume identity and mount, and archive continuity across
a real stop/restart. A missing mount can appear as a new writable local directory;
local tests must not certify that as persistent storage.

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
Image-setup history requires a known terminal state, finish timestamp, cleared
connection secret and exact host-owned resource cleanup verification. Promotion
can succeed before teardown is confirmed, so a terminal label alone still blocks.

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

The host's agent-runtime lifecycle notification listener has separate ownership
from its SDK worker. A normal owned safety read retires its exclusive listener
client only after admitted delivery and journal work settle. Failed or uncertain
retirement remains a blocker; diagnostics never perform this retirement. Closing
a subscription alone does not prove that its PostgreSQL backend closed. The
client belongs only to lifecycle delivery, so retirement preserves the main
pool and other features' notification channels. Releasing the hold or its existing shared expiry deadline
recreates the listener and reconstructs delivery from the durable journal before
normal dispatch, including events whose notification arrived while it was closed.
This preserves at-least-once delivery and existing company filtering; it does not
promise exactly-once callback invocation or add a wake guarantee for arbitrary
external SQL writers while compute is stopped.

This is a single-process admission protocol. A restart clears the owner. The
host must serialize sleep with deploy/wake operations and bind its final check
to the instance it stops. An unexpected restart after the final check can still
race an external provider stop; a process-local report cannot fence that remote
operation by itself. Multiple replicas require shared fencing. The protocol
does not make existing in-memory-only debt survive an unplanned process crash.

Related public PR #13413 adds runtime-service controller requirements and uses
the same `purpose: "idle"` / `ownerId` vocabulary. Retained stopped local-process
rows use the domain and process-reconstruction proof described above; live,
uncertain and adapter-managed runtime resources remain blockers.

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


## Negotiated incoming work

A signed, stack/owner-scoped Cloud incoming-wake capability can produce a version-3
safety report for saved API keys and exactly bound brokered GitHub bot endpoints.
Tenant authorization still runs after wake. Personal GitHub credential continuity
and unsupported transports retain their blockers. See [authenticated incoming
wake proof](idle-incoming-wake.md) for scope, HTTP versus durable-event guarantees,
rate/availability bounds, compatibility and remaining transport dependencies.

## Registered owner deadline coverage

The negotiated domain deadline catalog also inspects the registered status-card,
external-object, skill-sync, watchdog, retry and quota-monitor owners. `index.ts`
passes the actual services and worker reconciliation callbacks to the report.
A route-created service or an arbitrary in-memory `nextWakeAt` cannot establish
this coverage. Missing owner callbacks preserve the original durable work checks.

Each owner reads the supplied bounded, repeatable-read snapshot. Its normalized
state and future deadlines join the existing generation fingerprint. Startup,
dirty reconstruction, failed reconciliation, concurrent revision changes and
stopped workers cannot relax a blocker. The report checks owner revisions again
after inspection and backup preparation. Owner reads share the catalog's query
and elapsed-time budget; exhaustion refuses sleep.

Scheduled retry coverage is limited to a future legacy assignee-task retry and
its exact same-company, same-agent queued wake pointing back to that run. Other
runs and wakes retain their checks, as do accounting, budget-stop, resources and
cleanup. Native retries, review retries, coalesced wakes, claimed cancellation
and tasks with a separate monitor remain conservative. After wake, ordinary
run-dispatch admission and claims still decide whether execution may start.

The reserved legacy quota monitor validates its saved source run and current
assignee or agent reviewer target separately from ordinary issue monitors.
Claimed, due, blocked, malformed, native-source or mismatched-source monitors
remain work. Watchdog inspection reuses its subtree classifier; stopped or
incomplete subtrees remain work. First-run grace remains exactly 15 seconds
from issue creation. Cloud may refuse sleep when a real deadline is too near;
inspection never extends that deadline to make sleep eligible.

A completed or cancelled legacy quota task can retain its reserved monitor policy
and timestamp as history. The scheduler's terminal-status exclusion disarms that
schedule; inspection does not clear or postpone it. The quota owner additionally
requires a valid settled legacy source, idle execution state, no monitor claim or
execution lock, and no linked unfinished run or wake before treating it as
passive. A live task's due monitor remains work. Source uncertainty and unrelated
accounting/resource obligations retain their independent checks.

Pending `budget_evaluation_work` rows also block sleep. The budget owner removes
only the input IDs it has consumed. The queue has no completed-history rows.
The durable check still applies when a worker is absent or has not reconstructed
its work; a process-local idle count does not replace this check.
