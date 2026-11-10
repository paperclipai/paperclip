# Database

### Durable native provider backups

`native_harness_backups` journals encrypted provider-session archives in object
storage. One current row per company and session scope selects the published
backup. Pending uploads remain recorded after failure; a controller must still
own the native run when it publishes. Superseded controllers cannot replace the
selected backup. Archive bytes never enter the database.

The dedicated volume migration imports verified surviving backups without
removing their source files or changing task-session pointers. Replacement
readiness rejects retained session pointers whose backups remain local. The
existing bounded startup retention pass retires current backups only after its
task, run, lease and age checks pass. Old superseded objects have a separate
retention path that preserves the current backup and exact backups referenced
by live leases. Abandoned pending uploads also require a settled run without an
owner. Object deletion is acknowledged before removing the ledger row. This
adds no idle polling.

Archives stream up to 4 GiB of file data and 100,000 entries, with a separate
4.75 GiB encoded-object bound. Contained relative symbolic links are preserved
verbatim; absolute or escaping targets, link chains, writes beneath links, and
special files are rejected. Offline verification streams file hashes and honors
cancellation. A changed local manifest cannot be silently skipped just because
a previous migration published an object. Backups whose source run was deleted
remain untouched on the original volume and do not block enrollment.

The same offline maintenance process imports surviving legacy controller state
into `native_runner_checkpoints` and binds its existing session snapshot through
`nativeControllerRecovery` metadata. Runner validates the original protocol
state and recorded artifact; Core requires a finished run with no live owner.
Blocked or pending recovery records remain unchanged while their surviving
state is preserved; migration does not mark their work completed.
The normal bounded continuation selector handles inherited, unstarted follow-ups.
Never-started queued turns keep their task pointers and remain queued. Original
files stay intact, canonical database checkpoints take precedence, and missing
source files are reported separately rather than fabricated. This migration
does not recover provider state that was already lost before enrollment.

For an already-failed run, a valid legacy controller can lack proof of the
original Runner artifact after its old bootstrap tickets were pruned. The
migration preserves those exact controller and supervisor bytes as an encrypted
`paperclip.legacy-controller-archive.v1` object through the same backup ledger.
Its scope is the hash of its manifest and is separate from the provider session
scope. Publication requires a terminal-failure coordinator with no live owner.
The archive does not become an executable Runner checkpoint. Task pointers,
failed results and recovery blockers stay unchanged. A successful retained
session without artifact proof still blocks migration. The migration receipt
reports failed-session archives separately from imported recovery authorities.

An internal maintenance owner can separately record
`runnerProfileJson.nativeHarnessFilesystemIndependence` when an original-volume
inspection finds no uncovered provider or Runner payload. This is not a backup
or a successful recovery. It requires a fresh, independently reviewed provider
attachment witness and a private nonce anchor on that original volume. The
anchor survives normal releases; current deployment and mount identities are
verified afresh. Replacement hosts cannot create the receipt from missing files.

Publication binds the retained session, canonical newest resume source, frozen
inputs and checkpoints, every associated lease and destroyed-provider receipt,
released controller/finalizer ownership, and existing immutable skill references.
Any surviving skill files must match their admitted package bytes and modes.
Surviving controller and supervisor files require separate authenticated raw-byte
archives through the existing encrypted backup ledger. This evidence-only path
also accepts a settled successful source whose controller records match its
durable checkpoint. Its `original_volume_source_evidence` manifest reason does
not grant provider recovery or Runner execution authority. Publication checks
the source bytes again and retains the first authenticated archive during a
concurrent capture. The receipt binds the exact archive row and checkpoint parts.
Retired authority epochs can use the same evidence archive with a closed
inventory of their original controller and suspended Runner files, bytes and
modes. Each epoch must match a retained same-session run and its canonical
checkpoint identity when a header exists. A genuinely absent historical header
instead requires the exact admitted authority binding and remains explicitly
absent. Malformed, retired, or foreign headers cannot use this path. Current
source checkpoint and artifact requirements remain unchanged. Source fences
recheck the complete inventory before archive and receipt publication. Unknown
children and other nonempty history directories remain blockers. The inventory
and historical headers or their explicit absence stay bound in replacement
validation. History-free manifests and receipts keep their exact
existing shape; current-controller-only evidence remains retained when a later
archive adds historical files. These archives do not become executable backups.
This maintenance inventory is limited to 128 entries, 16 MiB per file and 64 MiB
total. These bounds are intentionally smaller than the Runner control-plane
state's 256 MiB maximum. A larger otherwise valid epoch remains on the original
volume and blocks filesystem independence; it is never truncated or waived.
Source locks and a final comparison fence publication; original files, stamps,
warnings, failed statuses and session pointers remain unchanged. Startup can
validate the published receipt using only database bindings, without the old
volume, a fresh source witness, or storage reads. Changed or missing bindings
invalidate it. Existing resume and replacement policies remain authoritative,
including governed-wait failures and warm-session refusals. No provider history
is reconstructed or declared recovered.

The same original-volume maintenance owner has a separate `web_evidence` mode.
It stores a `paperclip.native-harness-web-evidence.v1` receipt. This mode proves
that the web server's retained files have durable byte coverage. It does not
require an external VM's termination receipt and does not settle that VM's
recovery obligation. It requires the same settled web controller, finalizer,
task and physical-writer fences. The encrypted `original_volume_source_evidence`
archive includes a closed inventory of all nonexcluded files under the canonical
session root, the separate warm supervisor, and each admitted skill manifest.
Files retain their bytes and modes, including local edits and a skill whose
version row was deleted. Such a skill remains forensic evidence: the owner does
not recreate its version or make it executable. Canonical credential exclusions
stay excluded. Unknown directories, symlinks, incomplete manifests, active web
writers and changed source facts fail closed. This WEB inventory permits at most
10,000 entries, 4 MiB of manifest metadata, and 4,096 bytes per path. The 16-MiB
per-file and 64-MiB total payload limits remain unchanged. Authority history keeps
its separate 128-entry and 32-epoch bounds.

A genuinely absent raw controller stays absent. A supervisor-only archive still
requires the exact durable controller checkpoint and source identity. Old
terminated-provider receipts and history-free manifests keep their existing
shape. External lease status and cleanup observations can change without
creating a new web filesystem dependency. Allocation, stamp, selected source,
checkpoint and admitted-input changes invalidate coverage. VM references,
recovery actions, warnings and continuation policies stay unchanged. Replacement
validation uses only the published archive and database bindings; it needs no
original-volume anchor or filesystem read. These validations add bounded
per-retained-scope database reads during startup. They do not add a worker or a
poll. Missing or invalid byte evidence remains an enrollment blocker.

The original-volume owner can refresh a WEB or full native receipt whose database
facts digest has become stale only when fresh source inspection, current-key checkpoint
validation and ciphertext hash/size readback prove the preserved bindings unchanged.
It reuses the same archive and takes the existing finalizer, task and run fences before
comparing the prior receipt digest and replacing it. The company activity log
retains the prior database and local facts digests, source witness fingerprint,
observation time and receipt digest. Those four changed fields must reconstruct
the exact prior proof from the unchanged current bindings before publication. No source paths
enter the audit delta; normal activity redaction remains enabled. Changed
evidence, concurrent invalid receipts and active sources remain blocked; remote
recovery obligations are unchanged.
Full native reproof still requires canonical destroyed-provider receipts. A
database-only legacy workspace migration marker can stale the facts digest while
the preserved controller, skill assets and local byte proof remain unchanged;
refresh authenticates that same object and does not upload a replacement archive.

Local inode and timestamp observations may change between preservation attempts
without changing byte coverage. Valid receipts remain idempotent after those
changes; stale database facts can refresh with the same archive and fresh local
observations. During one attempt, the local metadata digest must remain stable
from capture through the locked publication check. Changed bytes, paths or modes
still invalidate preservation evidence.

Receipt validation adds bounded per-scope database reads to startup eligibility.
It does not add a recurring scan or network work. Qualification must measure the
selected cohort's startup latency on the serving revision before enrollment.

### Workspace cohort admission proofs

A saved cohort keeps its exact members, operations and snapshots on resume.
Independent companion imports can change the current source-scope proof without
changing those members. When every member has a running journal and its current
fingerprint matches both saved fingerprints, the importer can reprove the current
scope under fresh source, lifecycle and finalizer locks. After current source and
recovery checks, one transaction compares every journal and refreshes only the
cohort proof for all members. Cancellation or a changed journal rolls back the
whole refresh. Partial reservations still require the original aggregate proof.
Archives, recovery obligations and publication checks retain their existing owners.

Git cache expiration treats a saved migration marker or unfinished migration
journal as a durable consumer. It checks this under the lifecycle lock. A failed
migration with `lastFailure` and no `retiredSave` also keeps its source and
snapshot retention hold after process loss.

If an older server already expired members of an unpublished cohort,
`supersedeExpiredRemoteWorkspaceMigrationCohort` accepts the exact saved cohort
and the exact expired member IDs. This is an internal service API for a privileged
operator with a real database handle and reviewed company/cohort inputs. It does
not add a CLI mode or an HTTP route. An operator calls the exported owner directly;
its test and the reviewed one-time administrative qualification use that path.
It requires completed Git expiration and an
unexpired restore-point recipe for each missing member. Other members must retain
their saved source fingerprints. Fresh source, lifecycle, finalizer and row locks
protect one transaction that fails every old journal and removes only its matched
active marker. It does not report migration success or change task state. The
old cohort proof, operations, snapshots and object references remain unchanged.
The failure receipt retains those objects through the existing failed-save hold.
The optional `sourceLockWaitMs` uses the existing bounded source-lock queue.
The default still refuses a busy source immediately. Cancellation targets this
waiter only. All source and recovery checks run again after lock admission.

New canonical imports use the current archived recipe or current online source.
They record the old operation and supersession IDs and reserve a snapshot
generation above the existing ledger maximum. A successful new import does not
retire the old hold. Release of those historical objects requires separate review.

### Original local Git sources for archived workspaces

When an archived runtime branch has an exact successful deletion receipt, its
saved commit can be imported from the recorded original file-URL repository if
the canonical private/project cache is definitively absent. A present, corrupt,
foreign or unreadable primary source never falls through to this path.

This fallback requires the matching company/project source record, a real bare
repository under the same instance root, and the exact full saved base SHA matching
the deleted tip (`baseRefSnapshot.resolvedSha`, with the legacy `baseRefSha` form
accepted when no canonical snapshot exists). Conflicting records fail closed. It accepts self-contained SHA-1 storage with a bounded standard
configuration and at most 10,000 metadata entries. Aliases, special files,
alternates, replacement/graft/shallow state and execution hooks fail closed.
Every retained branch or lightweight tag must still name that full base commit.
Saved retries and final publication recheck that all recorded private and generated
primary sources remain absent. Returned or unreadable primary files block the
original-source path. Git reads use a restricted environment and local-file transport only.

Materialization uses private migration scratch. Existing encrypted snapshot
readback, journal identity, source reinspection and publication fences still
apply. Original repository bytes and cleanup history remain unchanged. This
imports the retained workspace tree; it does not turn a configured local file
URL into a portable source for future fresh project work.

### Proactive agent chat messages

Migration `0419_slippery_impossible_man.sql` adds an agent-scoped unique constraint
on `issue_comments(issue_id, author_agent_id, client_request_id)` alongside the
existing human request constraint. Proactive delivery stores a source-task-scoped
retry key and server-authored `metadata.chatMessage` provenance/content fingerprint.
The comment and audit record commit together; a retry returns the original receipt.
Conversation creation reuses the unique company/agent/human identity and existing
advisory-lock order. No message outbox is added.

Chat list/detail unread projections reuse `issue_read_states`, including chats
with no human participation. Read cutoffs use the exact PostgreSQL comment
timestamp; upserts take the greatest previous/new cutoff so delayed requests
cannot move a read receipt backward or clear a later unseen arrival.

Paperclip uses PostgreSQL via [Drizzle ORM](https://orm.drizzle.team/). There are three ways to run the database, from simplest to most production-ready.

### Persistent case handoffs

Standalone `cases` add a nullable unique `work_issue_id`, a descriptive `phase`,
and an integer `handoff_version`. Historical passive records have no primary task;
native `create_case` requires kickoff plus explicit workflow text and creates its primary task atomically. This is
separate from `pipeline_cases`.

First-task `initialDocuments` use ordinary `documents`, `document_revisions`
and `issue_documents` in the case kickoff transaction. No case document copies,
pending seeds or new tables are introduced. Case read surfaces join accessible
linked task documents; historical `case_documents` records remain unchanged.
Required `workflow_document_text` uses the same tables, under ordinary task key
`workflow`. It is committed before delivery and contributes to the idempotency
fingerprint. Existing cases and tasks receive no inferred workflow or backfill.
Authoring guidance recommends both a Mermaid `stateDiagram-v2` map and prose
defining each transition. Neither representation is parsed into database states.

`case_handoffs` retains the task/agent identities, principal-scoped idempotency
key and request fingerprint, observed/applied bigint task status revisions,
instructions/comment, source run, and stable wakeup receipt. Partial unique
indexes permit only one pending handoff per task and case. The pending-attempt
index and expiring lease support bounded delivery across controller restarts.
The ledger states distinguish release waiting, assignment applied but admission
pending, queue acceptance, and cancellation. Provider execution remains in the
ordinary heartbeat tables.

`actor_context` retains a versioned, server-derived authorization context for
delayed assignment. It contains no credentials and is omitted from public
handoff responses. Applying a delayed transfer rechecks the original caller's
current assignment permissions. Historical pending transfers without this
context fail closed; an operator can cancel them and request a new handoff.

Terminal handoffs have `destination_kind = 'done'`, a null destination agent,
and states `awaiting_completion` / `completed` with `completed_at`. They share
pending task/case uniqueness with agent transfers but do not enter the delivery
lease index or wake queue. Accepted ordinary task completion and terminal case
closure commit together. No terminal intent is inferred from a case's status.

`case_access_sources` stores retained logical issue/project identities without
deletion cascades from those sources. A missing source denies access. The case
is readable only when every source's existing permissions allow it; unlinking a
task or changing presentation metadata cannot widen that set. The case handoff
migration backfills historical project and linked-task sources conservatively
and leaves all existing cases passive. Source identities are not grants.

### Task query performance

The cancelled workspace-preservation partial index and bounded run/activity
projections share the restore-failure allowlist. Changing those failure codes
also changes the index predicate; use the normal migration-generation workflow.
A required metadata repair is excluded from ordinary cancelled preservation work.

Native session resume selects its newest progress barrier within the existing
32-run task/session window in one SQL snapshot. Only the chosen checkpoint source
returns its saved native input, checkpoint, tool fingerprint, wake envelope, and
canonical task brief. Unused bootstrap candidates do not return full context or
profiles. Wrong runtime, nonterminal status, process identity, provider events,
invalid but non-null checkpoints, and future checkpoint barriers retain their
existing selection rules. Stored run payloads and history reads stay complete.
Run the synthetic PostgreSQL comparison with a pinned pre-change revision:
`pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-native-session-resume-reads.ts --baseline-ref=<commit>`.
An optional `PAPERCLIP_SESSION_RESUME_BENCHMARK_DATABASE_URL` must name a dedicated
test database ending in `_test`; otherwise the harness starts disposable PostgreSQL.

Agent request authentication uses a compact run-identity read. It omits saved
execution payloads, results, and log excerpts from the query response. The read
still locks the task before the run and reconciles pending steering from durable
acknowledgements on every request. Default identity reads retain the full run.
Stored payloads and separate native tool authorization checks remain unchanged.

Native event acknowledgements read a count and maximum through the existing
source-sequence index. A stream with gaps uses indexed lookups for its first
missing successor. The acknowledgement keeps its contiguous-prefix rule without
returning every historical sequence number. All events stay stored. Counting the
index entries still grows with the stream length.

Conversation recovery reads only the saved run fields used to settle a turn.
Settlement locks and reads current conversation state without loading the task
description or comment bodies. It still checks the durable reply or pending
interaction, session generation, owning run, and newer user messages. Saved
execution payloads, task text, and comments remain stored in full.

The attention feed checks for newer runs with company-scoped existence probes.
The probes match the failed run's agent and issue or task context. They preserve
the existing millisecond comparison and empty-context rules. Each batch holds
at most 1,000 failed runs. Retained run history stays in the database; this check
returns only the identifiers of failures that have a newer matching run.
For failures without a task key, it reads the latest keyless timestamp once per
agent. Unique agents are batched separately, so repeated failures do not repeat
the same history scan. Both paths retain the current millisecond comparison.

The issue-lock adapter's release read omits `result_json.stdout` and
`result_json.stderr` before transferring a run to the controller. Native context
also omits saved launch text, execution-continuation bodies, workspace and
environment payloads, and the launch wake envelope. Task identity, retry and
continuation controls, interaction and comment references, execution policy, unknown context fields, and every other
result key stay intact. Legacy reads retain full context. Stop, retry, lease,
and workspace-recovery checks do not change. Full inputs and output remain stored
for execution history and detail reads. Terminal telemetry loads only its run
identity, timestamps, usage, and typed task identifier.

Recovery's latest-run queries return the context fields used by recovery
decisions. Prompts, execution continuation bodies, and workspace setup payloads
remain in the stored run and its full detail reads. These queries also return
the PostgreSQL row version. Native blocked-wait repair compares that version
against a fresh full source read before applying changes. Any intervening row
update, including an edit outside the projection, defers repair to a fresh sweep.

The two preliminary reconciliation reads omit named launch renderings and
preparation payloads. Native profiles omit unused native execution input.
They retain all other context, full results, legacy profiles, task identity,
retry accounting, and unknown controls. Native runs still reach their native
recovery guard. Terminalization locks its current control state and returns
full rows from its writes. Stored input remains intact.

Execution-blocker reads select process, lifecycle, and task-binding fields rather
than full execution rows. Context retains typed task and pre-dispatch evidence;
Runner profiles retain the adapter type, native input schema, binding, provider,
workspace-access evidence, and complete workspace-sync receipts. Native task and
runtime prompt payloads are not needed for these checks. Missing fields and
malformed input values retain their original shape. Full result evidence stays
available to the existing retry and workspace checks. Stored context, profiles,
and output are unchanged.

Committed native finalization reads run identity and ownership state before it
claims the coordinator. It loads complete saved input only when finalization
still needs to process an accepted result. Review presentation retains the full
result. Muse settlement reads its exact provider binding. Cleanup reads fresh
status and ownership metadata; cancelled native workspace retention and legacy
Stop settlement still load complete run evidence. Workspace settlement reads the
saved sync descriptor, export retry, and first-heartbeat flag. These projections
leave stored prompts, logs, results, and recovery state unchanged.

Settled native process release locks run identity, terminal state, process
identity, and checkpoint presence without loading the checkpoint or execution
payloads. It retains current coordinator checks, provider evidence, local-host
identity checks, and every lease's termination receipt. The stop receipt and
process-field update remain in the same transaction.

Legacy terminalization locks runtime mode, status, full result evidence, and the
status-delivery token without loading unused input, profile, or log bodies.
It keeps the existing lock, full returned run, workspace-retention
receipts, and source-bound recovery holds. Stored payloads remain unchanged.

Conversation ownership checks select process identity and full recovery result
evidence without execution prompts or profiles. Committed native reply repair
selects its persisted result and identity bindings plus typed presentation flags.
It keeps its existing row locks, accepted-result digest checks, publication
authorization, and selected-answer protections. Full execution history stays in
storage.

Run-context lookups use expression indexes for both `context_snapshot.issueId`
and `context_snapshot.paperclipIssue.id`. Task creation provenance has its own
company-scoped expression index that follows the query's native issue ID and
legacy `issueId`/`taskId`/`taskKey` precedence. Migration 0345 builds the two new
indexes concurrently and can resume an interrupted build without blocking run
writes for the full build. The indexes add storage and run-write overhead; they
do not change task visibility or secret redaction.

The task Context row reads the agent's latest context-window reading through
two small partial indexes on `heartbeat_run_events`. One index covers only usage
items, by run and time. The other index covers only `context.compacted` events,
by company and normalized session. Migration 0432 builds both indexes
concurrently. A poll therefore reads a few index entries, not a run's full event
history.

The attention feed finds retry-exhausted runs through the partial index
`heartbeat_run_events_retry_exhausted_idx`. The index covers only `lifecycle`
events whose message starts with `Bounded retry exhausted`, keyed by company,
run, and newest event first. The query predicate must stay textually equal to
the index predicate, or the scan reads every company event again. Migration
0454 builds the index concurrently.

A subtree pause release finds the runs that a dispatch gate refused for that pause
through the partial index `heartbeat_runs_tree_hold_suppression_idx`. The index
covers only cancelled runs with a `treeHoldSuppression` marker, keyed by company and
hold. Migration 0436 builds it concurrently.

The budget worker finds committed budget Stops that are not delivered yet
through the partial index `heartbeat_runs_pending_budget_cancellation_idx`. The
index covers only runs whose `result_json.startupCancellation.budgetEnforcement`
is an object without `deliveredAt`, keyed by company. Its predicate must stay
identical to `pendingBudgetRunCancellationPredicate` in
`server/src/services/heartbeat/budget-cancellation.ts`; a regression test checks
that the planner uses it. The worker check, run control, and the idle-sleep
check therefore read a few index entries, not every run's result JSON. The
migration builds the index concurrently. To compare both plans on a disposable
local fixture:

```sh
pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-budget-cancellation-scan.ts --runs=20000 --payload-kib=16
```

GitHub review lookups use four indexes from migration 0456, which builds them
concurrently. `chat_message_links_company_comment_idx` finds a source comment's
link for inherited review waits and run-origin checks.
`chat_message_links_delivery_idx` finds a delivery's links.
`chat_deliveries_github_automatic_delivery_idx` finds a delivery by its GitHub
webhook delivery ID on one endpoint. These three are partial.
`heartbeat_runs_company_wake_comment_idx` keys runs by company and
`context_snapshot.wakeCommentId`. It is not partial, because the planner does not
use expression statistics from a partial index; without them it estimates many
matches and walks the run history by creation time instead. The review check
reads the delivery's comment IDs first and then the newest same-agent run woken
by one of them, so it no longer walks the agent's run history. The two link
indexes also serve the comment and delivery `on delete set null` actions. Issue
lists share one external review-wait read per issue between the review and
blocked-inbox attention maps.

The chat wake-notice sweep compares UUID columns directly against guarded,
canonical lowercase UUID payload values. Malformed and noncanonical payloads
still match nothing. The query can use existing primary keys without adding a
wakeup-history index.

To compare all three queries on the same disposable local PostgreSQL fixture:

```sh
pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-slow-queries.ts --baseline-ref=origin/master
```

Use a revision before these fixes for `--baseline-ref` after they merge. The
benchmark loads that revision's chat query, uses synthetic data only, compares
complete returned rows, and prints timings and `EXPLAIN (ANALYZE, BUFFERS)` plans.
Local results measure query execution, not staging request latency.

Run history defaults to 200 rows and permits at most 1,000 rows, including
direct service calls. The UI client requests 200 rows when its caller omits a
limit. Context summaries expand the stored JSON once per returned row, retaining
legacy text conversion and the first-class issue binding. Authorization and
secret redaction still run on the bounded result set.
Agent detail links fetch an older selected run by ID when it is outside the
history page, and verify that it belongs to the current company and agent.

Saved-run policy and parent-report lookups read only the `executionPolicy`
value or the legacy `issueId` and `taskId` values from a run context. PostgreSQL projects
those JSON values before it sends the row to the controller. Unused prompt and
launch context does not travel with each policy or parent-report check. JSON
types, task-key precedence, and company and agent identity checks are preserved.
Each decision still reads current data; this is not an authorization cache.

Restoring a saved monitor's receipt or completion proof creates a new native
assessment identity even when its scheduled deadline is unchanged. The saved
proof is part of the assessment input. Prior decisions and accepted results stay
intact, and an unchanged replay reuses the same assessment and decision.

Native tool authority lookups select current run identity, status, invocation,
responsible user, context, and receipt data. Saved profiles and output excerpts
stay in storage and are omitted from that read. Task and agent binding, current
status, budget, and task privacy checks retain their existing predicates.
Mutation transactions still lock and read complete run records. The unlocked
authority read also omits named launch renderings and preparation data that its
tools do not consume. Ordinary tool checks also omit the wake payload. Mail
checks load the current full wake to enforce external-chat restrictions. Other
context and result receipts remain available. The complete saved context stays
in storage for execution.

WebSocket delivery uses one fresh authorization batch for an event's task and
run bindings. When both bindings name the same task, the batch reads its current
authority once. Different task bindings must both pass. The batch is discarded
after that delivery; later events still recheck grants, membership, task
existence, and company boundaries.

Browser progress events update cached live run status directly. A successful
patch does not refetch task details, activity, or run history. Unknown runs
retain the existing refresh fallback. Run transitions, activity events, and
reconnect recovery still refresh their affected data.

Task run queries stop interval polling only after a successful empty response
and an open shared live connection for the current company and session. Initial
reads, active work, errors, connection setup, and disconnections retain their
existing polling cadence. Company or session changes require a new connection.
Views without an assigned agent retain polling. Matching run lifecycle events
refresh the displayed task's run queries independently of route and window
focus. Events that omit task identity conservatively refresh these queries,
including reviewer runs from another agent. One parent view owns both query
observers and reuses refreshes already covered by the focused-route handler. A
matching event that overlaps an older request queues a fresh read after that
request settles. Connection readiness also reconciles the displayed run
queries after any older request. Follow-up reads belong to the current mounted
scope and stop when it changes or unmounts. The first open and reconnect still
reconcile missed events.

Bundled skill release checks read the current stored version ID and a SHA-256
fingerprint of its file inventory. A per-database memo keeps at most 64 verified
snapshots. It reuses a verification only when the current database fingerprint
and current on-disk inventory hash both match. A changed or missing snapshot
still follows full validation or seeding. Company access and local source
reconciliation still run for each request; authorization is not cached.

Connection-assignment checks select profile bindings for the current company or
agent and read rules that can match the selected connection's catalog rows.
All five selector kinds, null application matching, exclusions, and profile
precedence retain their existing evaluator. Rule filtering uses the catalog
values already read by that check, so a later catalog change cannot drop an
exclusion from the decision being evaluated. There is no cross-call cache.

Filesystem preparation uses current task/run and selected-configuration checks.
Historical root-reader authorization has been retired; no retained-reader batch is
loaded at admission or publication. Workspace-record disclosure still uses task
privacy checks, independently of filesystem access.

Saved-message execution-wait scans read current run state, process ownership,
startup and cancellation receipts, task binding, and the recorded adapter kind.
Saved profiles, output excerpts, and unrelated launch context stay in storage.
Continuation admission and its locked mutation reads retain their existing gates.

Task creation provenance reads current run identity, scope, and task binding.
Legacy task references retain their typed values and existing precedence. Saved
profiles, output, and unrelated context stay in storage. Viewer access to the
source task and run is still checked before provenance is returned.

The initial agent JWT run lookup reads only the cancellation state and
conversation flag from saved run JSON. It does not transfer the full context or
result. Run status, responsible-user identity, company and agent boundaries,
and the cancellation response remain unchanged. Later identity refreshes keep
their current authorization and transaction boundaries.

Chat recovery ancestry selects task identifiers and source-run links instead
of full execution payloads. Instruction authorization selects current identity
fields and still rechecks accepted identity, key revocation, and membership.
Identity task locks and activation receipts project typed legacy task keys with
the native and first-class issue IDs. These projections preserve task binding
precedence and validation without transferring prompts or output.

Recovery's latest-run and legacy-continuation eligibility reads select structured
result fields for error families,
workspace/configuration receipts, cancellation attribution, retry deadlines, and
conversation finalization. The `adapter_failed`, `provider_quota`, and
`configuration_incomplete` classifiers retain full results because they inspect
arbitrary provider error text. Stored results and execution/detail reads remain
complete; no recovery decision is cached.

To measure authentication query responses on disposable synthetic data:

```sh
pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-agent-authentication.ts --baseline-ref=06689c1b3410000bcd65ff40cb469e600209c4db
```

This compares the current query with the original query in that revision. It
checks the complete authentication decision and reports returned JSON bytes,
local query timings, and execution plans. It does not measure request latency
or fleet-wide savings.

To compare the real summary and full history queries with an earlier revision:

```sh
pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-run-history.ts --baseline-ref=1e731520bb
```

The fixture has 1,400 synthetic runs with 192 KiB contexts. Both queries return
the same 200 complete rows. This benchmark excludes HTTP and redaction latency.

Workspace reads also compare retained task IDs as guarded, canonical UUIDs.
This lets PostgreSQL check each source task by primary key before it evaluates
task privacy. Casting the indexed task ID to text can instead evaluate privacy
across company history for each workspace. These predicates protect workspace-record disclosure and operation metadata;
repository admission does not use them to authorize filesystem contents. Missing, malformed, noncanonical, and foreign-company source
IDs still deny access.

The subsequent source-task enumeration also keeps `issues.id` as a UUID. Its
OR predicate combines the workspace binding index with the task primary key.
Casting that ID to text forces another scan of company history even after the
workspace privacy query has passed. The workspace authorization regression
suite checks both plans and verifies the attached and retained source results.

To compare this query on a disposable fixture with 13,429 tasks:

```sh
pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-workspace-authorization.ts --baseline-ref=5c7a025032
```

The benchmark loads the baseline authorization module with current dependencies,
compares complete workspace rows, and prints five warm samples and query plans.
It measures SQL execution, not the full repository admission or agent startup.

Native finalization retries preserve a run's terminal completion time when its
status is unchanged. A retry mints another status delivery only when the current
run's status, finalization metadata, phase, error fields, or missing completion
time changes. An unchanged projection retains its existing pending delivery ID,
including after a publish failure. Status delivery stays at least once; retry
deadlines, recovery, accepted results, and workspace cleanup still run normally.
Legacy recovery also retains the pending delivery when status is unchanged and
no patch was supplied. Explicit patches, new terminal statuses, and newly
retained workspace evidence still create a delivery. File retention, ownership
checks, failed write conditions, lock cleanup, and recovery holds still apply.
The retention-evidence write returns another full run only when that evidence
changes. An unchanged retry keeps the full run returned by the first write and
still processes retained leases and recovery holds.

Agent lists read the complete company roster once and use that same snapshot for
termination filtering and organization-chain normalization. Detail and plugin runtime reads
load only identity, company, name, status, and manager from other company agents
for chain checks. The selected agent's full configuration, current monthly spend,
and existing response redaction remain available. Every call reads current data;
these lookups do not cache authorization or agent configuration.

Queued-comment display filters wake requests by the current company, assigned
agent, status, and exact JSON string task identity in SQL. Other tasks' comment
identifiers stay in the database. The display projection, ordering, current run
ownership checks, and persisted wake payloads retain their existing contract.

## 1. Embedded PostgreSQL — zero config

If you don't set `DATABASE_URL`, the server automatically starts an embedded PostgreSQL instance and manages a local data directory.

```sh
pnpm dev
```

That's it. On first start the server:

1. Creates a `~/.paperclip/instances/default/db/` directory for storage
2. Ensures the `paperclip` database exists
3. Runs migrations automatically for empty databases
4. Starts serving requests

Data persists across restarts in `~/.paperclip/instances/default/db/`. To reset local dev data, delete that directory.

Subscription reporting adds `ai_subscriptions` (company-scoped account identity),
`ai_subscription_prices` (immutable price revisions), and
`ai_subscription_connections` (selected grant-to-account bindings). New managed
subscription receipts also have a nullable `cost_events.subscription_id`.
Migration `0322_reflective_kree.sql` is replay-safe and leaves existing cost
amounts and receipts untouched. No historical account attribution is inferred.
Deleting a connection removes its binding but retains subscription price history;
disconnecting is not proof that provider billing ended. See
[subscription cost reporting](connections/AI-CONNECTIONS.md#subscription-cost-reporting)
for the reporting and ownership rules.

If you need to apply pending migrations manually, run:

```sh
pnpm db:migrate
```

When `DATABASE_URL` is unset, this command targets the current embedded PostgreSQL instance for your active Paperclip config/instance.

Issue reference mentions follow the normal migration path: the schema migration creates the tracking table, but it does not backfill historical issue titles, descriptions, comments, or documents automatically.

To backfill existing content manually after migrating, run:

```sh
pnpm issue-references:backfill
# optional: limit to one company
pnpm issue-references:backfill -- --company <company-id>
```

Future issue, comment, and document writes sync references automatically without running the backfill command.

This mode is ideal for local development and one-command installs.

Docker note: the Docker quickstart image also uses embedded PostgreSQL by default. Persist `/paperclip` to keep DB state across container restarts (see `doc/DOCKER.md`).

## 2. Local PostgreSQL (Docker)

For a full PostgreSQL server locally, use the included Docker Compose setup:

```sh
docker compose up -d
```

This starts PostgreSQL 17 on `localhost:5432`. Then set the connection string:

```sh
cp .env.example .env
# .env already contains:
# DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip
```

Run migrations:

```sh
DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip \
  pnpm db:migrate
```

Start the server:

```sh
pnpm dev
```

## 3. Hosted PostgreSQL (Supabase)

For production, use a hosted PostgreSQL provider. [Supabase](https://supabase.com/) is a good option with a free tier.

### Setup

1. Create a project at [database.new](https://database.new)
2. Go to **Project Settings > Database > Connection string**
3. Copy the URI and replace the password placeholder with your database password

### Connection string

Supabase offers two connection modes:

**Direct connection** (port 5432) — use for migrations and one-off scripts:

```
postgres://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:5432/postgres
```

**Connection pooling via Supavisor** (port 6543) — use for the application:

```
postgres://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres
```

### Configure

For the application runtime, use a direct PostgreSQL connection unless the database client has explicit prepared-statement configuration for your pooling mode:

```sh
DATABASE_URL=postgres://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:5432/postgres
```

If you later run the app with a pooled runtime URL, set `DATABASE_MIGRATION_URL` to the direct connection URL. Paperclip uses it for startup schema checks/migrations and plugin namespace migrations, while the app continues to use `DATABASE_URL` for runtime queries:

```sh
DATABASE_URL=postgres://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres
DATABASE_MIGRATION_URL=postgres://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:5432/postgres
```

If your transaction-mode pooler does not support protocol-level named prepared statements, set `DATABASE_PREPARED_STATEMENTS=false`. If your pooler supports them, you can opt in with `DATABASE_PREPARED_STATEMENTS=true`. Check your provider's pooler configuration before you enable this setting. Keep `DATABASE_MIGRATION_URL` on a direct connection. Do not edit database client source files as part of deployment setup.

### Client tuning (optional)

All of these are optional; when unset, the driver defaults apply and behavior is unchanged — typical self-hosted setups need none of them:

```sh
DATABASE_PREPARED_STATEMENTS=false   # use false when the pooler does not support named prepared statements
DATABASE_POOL_MAX=25                 # connection pool size; default: 10
DATABASE_IDLE_TIMEOUT_SECONDS=60     # close idle pooled connections; default: 60 (0 = keep open)
DATABASE_CONNECT_TIMEOUT_SECONDS=10  # default: 30
DATABASE_MAX_LIFETIME_SECONDS=1800   # recycle a pooled connection after this long; default: 30-60 min (random)
DATABASE_APPLICATION_NAME=paperclip  # application_name in pg_stat_activity; default: paperclip
```

An explicit `DATABASE_PREPARED_STATEMENTS=true` enables named prepared statements
for parameterized ORM queries, transactions, reserved connections, and dedicated
clients. Postgres.js manages the statement cache. This does not cache query
results. Bound values and returned data stay fresh. Explicit per-query options
still apply, including `prepare: false` and simple-protocol execution. With the
setting unset, ORM queries keep their existing unprepared behavior and tagged
SQL uses the driver default. With `false`, preparation stays disabled.

### Bounded response diagnostics

`PAPERCLIP_DB_RESPONSE_CAPTURE_WINDOW=<start>/<end>` enables one explicit UTC
window. Both timestamps use ISO format ending in `Z`. The window lasts at most
60 seconds and starts within 30 minutes. Unset, invalid, and expired windows
leave database construction unchanged. An expired window stays inactive after a
restart; remove the setting after the investigation.

The diagnostic measures awaited Postgres.js `unsafe` responses before Drizzle
column decoding. It issues no queries. Configuration is read when each database
client is created; setting the environment on an already-running process does
not install the capture on existing clients. Prepare the deployment artifact
before choosing the UTC window, then start the window after rollout and warm-up.

Server entry points use `withDatabaseOperation(owner, action)` to name the work
that executes queries. Owners are fixed semantic labels, never request paths,
company or run IDs, user input, or SQL. The execution owner is captured for each
query and retained through completion, including transactions and dedicated
pools. A prepared query reused by different operations keeps the owner of each
execution. The builder caller is separate from that execution owner.
Owner context is active while a valid future window is armed, up to 30 minutes
before its start, so work that crosses the start boundary keeps its owner. Query
accounting starts only at the window start. With no armed window, or after
expiry, the owner helper calls the action directly without a context scope.

The capture aggregates owner, static schema table, operation, calls, returned
rows, query errors, and total/maximum completion wall time. `totalWallMs` and
`maxWallMs` include pool, database, network, and event-loop waits; they are not
CPU measurements, and concurrent query durations overlap. Timing excludes the
capture's response sizing. Rank calls and returned rows both per second and per
completed service operation; a busy owner is not necessarily wasteful.

Response sizing samples successful results 1, 17, 33, and so on per aggregate
group (`sampleEvery: 16`). It examines at most
256 cells, 65,536 string code units, and 65,536 value bytes per sampled result;
an individual string over 16,384 code units is not measured. Parsed objects and
other complex values are not serialized. Oversized, complex, or unexamined
values leave an incomplete sample. `sampledValueBytes` is a lower bound over
sampled primitive values, not a total response-size estimate or network bytes.
Do not extrapolate it as the total bytes returned by the database. Inspect
`sampledResults`, `sampledRows`, `measuredValues`, `unmeasuredValues`, and
`incompleteSamples` alongside it. `sizingWallMs` records the diagnostic's sizing
work separately. Use a separate capture-disabled CPU profile to measure normal
processing cost.

The diagnostic emits at most 2,048 aggregate groups and a summary. Measurement
stops at the deadline. Environment-enabled
captures emit at most 64 records per second and can take another 33 seconds to
finish writing the bounded output. Wait for the summary before collecting it.
It never logs SQL, parameters, result
values, connection strings, or query errors. In-flight queries continue normally.

Semantic owners work in a bundled server without source maps. Specific owners
avoid stack capture. The generic `http.request` owner keeps its exact name but,
like an unowned query, also captures a bounded caller location during the window.
For wrapped query builders, a map-free hosted bundle retains one static generated
construction-site anchor (`dist-runtime/server.mjs`, `index.mjs`, or
`chunk-<build hash>.mjs`, with line and column). Correlate it with the exact serving
revision and bundle; it is not a TypeScript location or an execution-time CPU
owner. Capture wrapper frames are excluded before reading the stack, and deeper
frames in the same bundle are omitted.

Unscoped driver calls, including relational queries, do not accept generated
anchors: a bundled ORM helper could otherwise be mistaken for an application
caller. They can still retain existing public source/dist locations; linked
source maps and Node's `--enable-source-maps` may help resolve those locations.
Restore prior Node options after capture. Missing callers remain unknown and
still contribute to totals. Disabled, future and expired windows do not capture
stacks; wrappers installed for an armed window remain after expiry. Active census
stack capture, grouping and bounded sizing add measurement overhead. More caller
groups still share the existing group, page and output-rate caps. This diagnostic
is not a production performance improvement.

Look for `paperclip.db_response_capture.entry.v2` and
`paperclip.db_response_capture.summary.v2` in the process logs. Version 2 uses
sampled, bounded primitive-value sizing; do not interpret it as the version 1
all-result byte estimate. A log provider
can store `event` as a structured field instead of message text. Filter by that
field or read the bounded window from the exact deployment. Check the summary
and group totals, including the unattributed overflow group.

Fetch a complete capture as follows:

1. Read the summary events from the exact deployment and window. Keep each
   distinct `captureId` separately.
2. Each entry has a unique `groupIndex` within that capture and a `groupPage`.
   The summary gives `groupPageSize` (128) and `groupPages`. Fetch every page
   from zero through `groupPages - 1`, filtering on the entry event, `captureId`,
   and `groupPage`. Request at least `groupPageSize` matching records per page.
   A structured query can use
   `@event:paperclip.db_response_capture.entry.v2 AND @captureId:<id> AND @groupPage:0`.
3. If the provider's record limit is smaller than a page, fetch each
   `groupIndex` separately with the same capture ID. Each index matches one
   entry. Do not split by timestamp: entries can share a timestamp.
4. Deduplicate by `(captureId, groupIndex)`. Require every index from zero
   through `groups - 1`, with no gaps. Entry count must equal `groups`, summed
   `calls` must equal `completedQueries`, and summed `rows`, `sampledResults`,
   and `sampledValueBytes` must equal their summary totals. A missing page is an
   incomplete measurement. Keep overflow and unattributed groups visible.

Tagged raw-driver calls, streams, unawaited raw-driver
dispatch, and protocol overhead are not measured. Relational queries use a driver-level caller fallback.
Queries still in flight at the deadline are reported separately. The census does
not include every PostgreSQL statement or internal transaction command, so its
calls are not interchangeable with database-wide commit counters. It does not
measure SQL compilation, driver parsing CPU, or Drizzle row-mapping CPU. Use the
ranked owners to choose a narrow follow-up profile or synchronous-stage
measurement; do not attribute CPU by subtracting process CPU usage across an
asynchronous query. Remove the capture setting after collecting its final
summary; the absolute deadline already prevents further measurement.

### Push the schema

```sh
# Use the direct connection (port 5432) for schema changes
DATABASE_URL=postgres://postgres.[PROJECT-REF]:[PASSWORD]@...5432/postgres \
  pnpm db:migrate
```

### Free tier limits

- 500 MB database storage
- 200 concurrent connections
- Projects pause after 1 week of inactivity

See [Supabase pricing](https://supabase.com/pricing) for current details.

## Connection loss and retries

HTTP access logs distinguish a completed response from a connection that closes
before or during the response. An aborted request has no success status in the
log message. The structured response status is null when headers were not sent;
after headers, it retains the status sent before the abort. These logs describe
HTTP delivery, not database settlement. A disconnected issue PATCH may continue
running, so an aborted response does not prove that its writes rolled back.

The database client does not replay arbitrary statements after a disconnect.
PostgreSQL may have committed a statement before the connection loses its
response. The postgres.js message `write CONNECTION_CLOSED` does not prove
that the statement was never sent: the driver also uses it when an in-flight
query loses its connection. SQL text cannot establish replay safety either;
a `SELECT` can call a function with side effects.

The affected operation fails and a new operation can reconnect through the
pool. Callers may retry only when the complete operation is idempotent or has
a durable receipt that prevents duplicate effects. Some transient statement
failures therefore reach the caller instead of being retried automatically.

When a database connection closes, its transaction fails. Paperclip does not
replay that transaction. New requests can use a fresh connection from the pool.
Queries from the failed transaction must keep failing, even after the pool
reconnects.

Source builds carry `patches/postgres@3.4.9.patch` for this behavior. It rejects
queued and later queries from a disconnected transaction or reserved connection,
and prevents a released, closed connection from returning to the open pool.
The patch covers both ESM and CommonJS. The regression suite terminates real
PostgreSQL backends and checks rejection, pool recovery, and transaction isolation.
Remove the patch when an upstream release passes these tests. Installs of the
unmodified `postgres` package outside this workspace do not include the patch.

The patch also preserves transaction connection reservation when pipelining is
disabled with `PGMAX_PIPELINE=0`. Without this fix, the driver's pipeline capacity
check skips the transaction reservation callback and `BEGIN` fails with
`UNSAFE_TRANSACTION`. Disabling pipelining makes a queued query wait for the next
available pool connection instead of sending it behind unrelated work on a busy
connection. This can help interactive requests that share a prepared-query pool
with slow background work. It does not make the SQL itself faster. The default
pipeline limit remains unchanged. Test transaction behavior before using this
setting with a driver build that does not include the patch.

Trusted-header actor synchronization retries transient connection failures,
including `CONNECT_TIMEOUT`, at most twice. This retry applies only to the
idempotent actor synchronization operations, not arbitrary transactions. A
persistent outage still fails the request after the bounded retries; each
connection attempt remains subject to the configured database connect timeout.

The dashboard's company lookup, agent and task counts, pending approval count,
monthly spend, and run activity aggregate each retry these connection errors
at most twice. The heartbeat run list and base issue lookup by UUID or identifier
use the same bounded retries. Each callback is read-only and rebuilds its query
for each attempt. A failed read does not replay completed reads, the budget
workflow, or issue label and watchdog enrichment. Missing resources,
authentication errors, and other database errors retain their usual behavior.
This does not enable general SQL replay or retry a full request.

The task run list also opts its execution-status projection into these bounded
retries. Each of its four read-only lookups rebuilds only the failed query;
completed lookups and the separate liveness backfill are not replayed. Projection
callers that use a transaction retain single-attempt reads. The opt-in is only
for a pooled database handle outside a transaction.

The heartbeat run read check uses the same bounded retries. Routes call it with
the pooled database handle. Its issue existence lookup and its `issue:read`
authorization decision retry separately, so a disconnect in the decision does not
replay the completed lookup. Both steps only read. Missing issues, denied
decisions, and other errors keep their usual behavior.

## Tool profile reads

Tool profile list, detail, and new-tool review queries select only the catalog
identity, selector, and review fields that they use. They do not load tool input
or output schemas, annotations, or provider metadata. Application and connection
lookups for these paths read only IDs and display names. Profile entries,
bindings, counts, review descriptions, and company filters retain their existing
behavior. The full catalog and tool execution paths still read their schemas.
Attention counts use the same catalog projection and read only invocation IDs
and connection IDs to associate pending requests. Summary queries also omit
review titles and descriptions; the separate review query still returns them.

Internal effective-tool assignment lookups use the same catalog projection.
Run preparation, native runtime setup, and connection policy checks need tool
IDs and names, not complete tool definitions. They still resolve current profile
bindings, selectors, exclusions, and installed connections on every call. The
public effective-profile response continues to include complete tool schemas
and annotations.

Connection readiness checks use a scoped assignment reader. It applies the same
current profile precedence, selectors, and exclusions to the candidate connection
IDs. The reader selects rule match fields and catalog identities. It does not
load rule conditions, catalog schemas, profile summaries, or the company-agent
list. Installed connections and later identity and gateway checks remain fresh.
Full effective-profile and effective-tool responses keep their complete shape.

## Execution identity row locks

Identity initialization, credential acquisition, and steering reconciliation lock
the task before its run. These operations use `FOR NO KEY UPDATE`: they change
identity state, not parent keys. The lock still serializes identity writers and
blocks concurrent task or run updates. It allows audit inserts to retain their
foreign-key `KEY SHARE` locks without waiting on identity acquisition. The audit
foreign keys and their deletion behavior remain enforced.

## Remote workspace row locks

The runtime workspace service takes company `KEY SHARE`, current task `UPDATE`,
run `UPDATE`, then workspace `UPDATE` locks. It rechecks the run's task binding
under the run lock. A shared workspace can retain a different original source
task; new provisioning and snapshot operations belong to the current run's task.
Existing operation receipts keep their recorded attribution.

| Owning transaction | Locks after company, current task and run |
| --- | --- |
| Workspace reservation | Shared-selection advisory lock when needed, workspace |
| Preparation publication | Workspace, source lease, existing restore receipt |
| Snapshot reservation and publication | Workspace, operation and snapshot rows |
| Provisioning reservation | Workspace, existing operation or new receipt |

`workspace_operations` has ordinary company, task, run and workspace foreign
keys. An insert takes `KEY SHARE` locks on those parents even when the service
does not explicitly select them. Locking the parents first prevents their
foreign-key checks, or a later run-reference write, from reversing the order.
File preservation already takes task, run, workspace and lease locks in that
order. Confirmed lease destruction locks matching workspaces before the lease;
its workspace-location update takes no task or run lock afterward.

Provisioning settlement and save-invocation settlement lock the workspace and
update existing receipt metadata. They neither add a parent foreign-key
reference nor lock a task or run afterward. Snapshot upload and retention own
snapshot rows; the snapshot ledger has no parent foreign keys. These paths do
not need an otherwise unused parent lock.

Administrative import reservation takes company `KEY SHARE`, original source
task `UPDATE`, then workspace `UPDATE`, and rechecks that source binding. This
also applies to an already-imported no-op, which can overlap runtime saves.
Import publication takes the same company and recorded source-task locks before
its legacy coordinator and run locks, then the workspace and saved allocation
leases. Native claim, status and cancellation owners do not share one row-lock
order. Import therefore requests those legacy coordinator, run and lease locks
with `NOWAIT`. A real `55P03` aborts the publication transaction and reports
`remote_workspace_migration_blocked:execution_rows_busy`. The journal, uploaded
archive and local files remain available for a later administrative retry. Other
database errors propagate. No automatic retry or lock-strength reduction occurs.

Offline import can preserve an active task recovery hold after its exact native
workspace reference is finalized. It checks the terminal run, released controller
and coordinator ownership, task relationship, and any recorded file allocations.
An accepted result with a retrying coordinator also needs the successful
company/run/task `workspace_finalize` receipt consumed by the normal finalizer.
Historical receipts can have no workspace foreign key. Import retains recovery
rows, task pointers, results and coordinator phases. It does not establish provider
termination or resolve the hold. It locks and rechecks the saved evidence before
publication. An unrelated historical folder keeps the obligation on its real
source workspace.

Finalized file sources receive a separate `finalizedWorkspaceRecoveryMigration`
run marker and an exact migration-operation receipt. They do not receive the
legacy execution-replay suppression marker. Future recovery exports an immutable
snapshot of the recorded allocation instead of merging into the retired local
folder. The existing source, provider-stop and archive checks still apply.
Completed copyback recovery receipts remain valid. Unknown or unverified recovery
sources continue to block import.

Online import can preserve an established provider session's prepared source
after a terminal provider-artifact failure. It requires the exact board-owned
native failure block and the task's current blocked status version, released
controller and coordinator ownership, and all declared allocation bindings.
Source locks and the finalizer lock protect the full action, task and source
fingerprints through publication. Import saves only the current local files. It
retains the prepared reference, provider checkpoint, remote allocations and
recovery hold. The existing migration recipe routes later file recovery away
from the retired local destination. This neither declares preexecution nor
proves remote export, provider termination or permission to resume execution.

An exhausted prepared-export hold can also retain the canonical historical-source
marker added by recovery backfill. Its schema and run must match, and every unique
recorded lease must already belong to the proven prepared source or its declared
recovery allocations. The existing historical-source inspector verifies those
same allocation bindings. Unknown fields, malformed markers and foreign, duplicate
or uncovered lease references still block import.

The full historical marker stays in the action fingerprint. Existing source,
task, lifecycle and finalizer locks and publication reinspection remain required.
This permits preservation of the current local files only. It neither clears the
hold nor claims that remote files were copied or a provider stopped. Marked holds
add bounded database reads during maintenance inspection; they add no provider
calls or recurring background work.

The workspace fingerprint pins the recorded source. An arriving reservation can
reach a legacy workspace before refusing it, so publication must follow this
order too. The lifecycle advisory lock alone does not fence runtime operations.
Publication still rechecks current writers and unresolved work. Offline imports
also require the deployment-stopped maintenance fence. Ordinary save requires an
existing prepared remote location and refuses the unpublished legacy authority.

The workspace lock still serializes generations and publication. Foreign keys,
ownership and epoch checks, and transaction-aware work notifications remain in
place. Remote preparation, command execution, archive capture and object upload
run outside these transactions. No workspace or parent row lock spans that I/O.

## Execution admission accounting

The execution-admission module (`server/src/modules/execution-admission/`) owns
three tables. Nothing writes admissions or caps in production yet, and no claim
path enforces a project maximum.

- `project_task_execution_policies` stores a project's maximum concurrent tasks
  apart from `projects`, so project readers never return an unenforced cap. No
  row means never configured. A row with a null maximum means an explicit "no
  limit", which a later legacy migration must not overwrite. Maximums are
  positive. The row is deleted with its project.
- `execution_admissions` stores one admission attempt of a run. A run can be
  released before dispatch and admitted again, so `(run_id, attempt)` is unique
  and a partial unique index allows one unsettled attempt per run. The row keeps
  the context revision, the nullable primary project as provenance (no foreign
  key) and the settlement identity, which is set together with `settled_at`.
  `admitted_project_ids` is the complete admitted project set, sorted, kept
  after settlement and immutable (a trigger rejects any change). It has no
  project foreign key, so settled history never blocks project deletion and
  keeps the deleted project's ID. `{}` is a known empty set. Null means
  unknown and is allowed only on settled rows: migration `0428` filled it from
  the charges of unsettled rows, but settled `0426` rows had already lost
  their set. A retained provider session resumes with the previous set ∪ the
  current references; an unknown previous set requires a fresh context, never
  an empty or primary-only guess.
- `execution_admission_project_charges` stores one row per distinct admitted
  project, including unlimited projects. An admission without projects has no
  rows. Composite `(company_id, …)` foreign keys keep admissions and projects in
  one company. Rows are the only active capacity and exist only while the
  admission is unsettled: settlement deletes the whole set in one transaction,
  and `(company_id, project_id)` is indexed for active counts, so lookups
  scale with active work, not history.

Archiving a project changes no charge. Deleting a project with a charge returns
`409 project_execution_admission_pending`; the foreign key is the backstop.
Deleting an agent refuses unsettled admissions on its runs and removes settled
ones, with their sets, together with the runs. Company deletion removes the company's admissions before its runs and
projects.

The proposed global lock order for the admission transaction is: company row
(`FOR NO KEY UPDATE`), native finalization recovery owner, the whole project set
in ascending ID order (`FOR NO KEY UPDATE`, one statement), issues, wake
requests, the run, the external-admission advisory lock, the admission row and
its charges, then budget reservations. Policy updates take the same project
lock. Settlement takes no project lock. Only the project-set step is implemented
so far; claim paths keep their current locks until they are integrated.

## Switching between modes

The database mode is controlled by `DATABASE_URL`:

| `DATABASE_URL` | Mode |
|---|---|
| Not set | Embedded PostgreSQL (`~/.paperclip/instances/default/db/`) |
| `postgres://...localhost...` | Local Docker PostgreSQL |
| `postgres://...supabase.com...` | Hosted Supabase |

Your Drizzle schema (`packages/db/src/schema/`) stays the same regardless of mode.

## Migration authoring checklist

Older embedded databases can use `SQL_ASCII`. Test encoding-sensitive SQL on
both `SQL_ASCII` and UTF-8 databases. Migration `0355` constructs its whitespace
pattern from UTF-8 bytes so legacy databases can compile it, and matches whole
characters instead of trimming individual bytes. Its shipped hash remains a
valid migration receipt; otherwise an upgrade could replay its older connector
triggers over the replacements from `0356`. The encoding migration regression
checks both selector behavior and preservation of that later trigger definition.

The 0126 issue comment attribution backfill showed the failure mode this checklist is meant to prevent: each batch looked for the next rows with an unindexed predicate, so PostgreSQL repeatedly scanned the same table and the migration became O(n²) as the table grew.

When authoring migrations or one-time backfills:

- Create the supporting index for the batch predicate before the backfill loop runs.
- Bound batches by an indexed key, such as an id range or keyset pagination cursor. Do not use `OFFSET` pagination or a query shape that re-scans already-visited rows each batch.
- Avoid unbounded full-table `UPDATE` or `DELETE` statements. Add a selective predicate and process rows in bounded batches when table size can be large.
- Use `CREATE INDEX CONCURRENTLY` for large existing tables when the migration can run outside a transaction and must avoid long write locks.
- Split schema changes, index creation, and data backfill into separate phases so each step has clear locking and rollback behavior.
- Treat the `check:migrations` CI gate as the enforcement backstop for these rules. If it flags a migration, rewrite the migration or add a suppression comment with the indexed predicate, batch bound, and reason the remaining scan is safe.

Private-task migrations `0313` and `0314` are explicitly allowlisted in the
Paperclip executor to run outside a file-wide transaction. Their idempotent
keyset batches commit every 1,000 rows, and migration history is recorded only
when all batches finish. The executor repairs invalid concurrent indexes on
retry. A reserved connection holds a session advisory lock across all batch
commits, so concurrent migrators recheck history only after the preceding runner
finishes. Privacy triggers are replaced atomically. Bootstrap uses the same
executor; other migrations remain transactional
per file. Apply these migrations through `pnpm db:migrate` using a direct
connection, before enabling the new server and UI.

## Migration snapshots

`drizzle-kit generate` diffs `packages/db/src/schema/` against the newest snapshot in `packages/db/src/migrations/meta/`. That snapshot must describe the schema that every migration produces when they run in order. A snapshot that drifts from the schema makes the *next* migration wrong, because `generate` folds the drift into it. The drift can add a column that an earlier migration already created, which makes that migration fail on a fresh database. It can also drop a column that the schema still uses.

- Create every migration with `pnpm --filter @paperclipai/db generate`. Do not hand-write a snapshot.
- Do not hand-edit a snapshot to resolve a merge conflict. Renumber your migration and run `generate` again, as `packages/db/.gitattributes` describes.
- The repo keeps only the newest 5 snapshots. `generate` runs `prune:snapshots` afterwards to delete older ones. Drizzle only reads the newest snapshot, and each snapshot is a full copy of the schema (over 1 MB each). Older snapshots are still in git history.
- `packages/db/src/migration-snapshot-drift.test.ts` is the enforcement backstop. It repeats the diff that `generate` performs and fails when the newest snapshot no longer matches `packages/db/src/schema/`.

## Managed adapter settings

Cloud-managed instances keep adapter selection preferences in the private
`instance_settings` singleton `adapter-settings:v1`. Its `general` JSON contains
`version: 1`, a monotonic `revision`, and `disabledTypes`. It is separate from
the public `default` settings row and never appears in the instance settings API.
Each update locks this row in a transaction. The update and company activity
records commit together. Discovery and new-agent admission read the database
at their asynchronous operation boundaries; no polling or mutable settings cache
is used. Disabled adapters remain available to existing agents.

`PAPERCLIP_ADAPTERS` and `PAPERCLIP_ADAPTERS_FILE` declare the effective operator
adapter list. The declaration is parsed once for a process configuration and
validated at startup. It does not rewrite stored preferences. A conflicting
adapter toggle returns 403. Removing the declaration restores saved choices.
Operator file edits require a restart. Self-hosted instances continue to use
`adapter-settings.json` for saved preferences.

The server-only adapter settings service exposes `inspectStored()` and
`seedIfAbsent({ disabledTypes }, transaction?)` for migration tooling. Seeding
uses the unique singleton key, returns `{ seeded, current }`, and never replaces
an existing record. The caller can use the same transaction for its import
receipt. Before admission, `initializeAdapterSettings` checks the durable row.
When absent, it imports a valid legacy settings file once, retaining unknown
adapter types, or seeds empty preferences if no file exists. It rejects files
larger than 64 KiB, malformed input, and read failures. An existing durable row
wins over every stale file. Ordinary Cloud reads do not read a legacy file.

The focused PostgreSQL suite can use an owned disposable PostgreSQL database via
`PAPERCLIP_ADAPTER_SETTINGS_TEST_DATABASE_URL` when embedded PostgreSQL is
unavailable. It applies migrations and inserts test data, so never point this
variable at an existing application database.

## Cloud configuration migration receipt

The private `instance_settings` singleton `cloud-configuration-migration:v1`
records atomic import completion, semantic source digests, imported revisions,
and metadata-only external adapter blockers. It composes the adapter and
startup-config owners without replacing an existing authoritative row. Receipt
locking and the import transaction handle concurrent attempts and retries; no
local completion marker participates in conflict resolution.

Qualification records current configuration revisions and selected image package
evidence before normal plugin reconciliation. Image inspection does not hold
admin write locks; configuration and registration snapshots are rechecked in a
short transaction before the report is saved. A historical successful report
never grants current eligibility. External metadata blockers survive loss of the
legacy home and require a deliberate revision-checked recheck of a present valid
original source file. Package mismatches remain recorded after maintenance
reconciliation. See the [bounded migration and qualification procedure](cloud-configuration-migration.md)
for the stopped-writer prerequisite, commands, retry semantics, integrity limits,
and the explicit exclusion of secret bytes, whole-server zero downtime, and
volume removal.

## Cloud runtime identity singleton

The private `instance_settings` row whose singleton key is
`cloud-runtime-identity/v1` records the immutable Cloud stack id, warm-pool
claim id, previous pool origin, canonical origin, and stack slug accepted from
Cloud's signed pre-activation assertion. It is separate from the normal
`default` settings row and never appears in the settings API. This is
intentionally instance-scoped rather than company-scoped: an instance has one
public identity, and the existing unique singleton-key index makes concurrent
or later attempts to replace it fail closed. The server loads the row before
constructing URL-dependent runtime services on every boot.

### Unclaimed Cloud warm standby

`PAPERCLIP_CLOUD_WARM_STANDBY=1` is an opt-in control-plane marker for an
unclaimed warm application. It requires Cloud configuration, a stack identity,
and runtime identity verification keys. After restoring the durable identity,
startup checks once for company data. Existing companies or a persisted claim
keep the application fully active. A failed database check fails startup.

An empty unclaimed application keeps its HTTP server and sandbox plugins ready,
but skips recurring database work: chat/email delivery, plugin jobs, browser
cleanup, feedback export, import cleanup, execution reconciliation, Muse maintenance, heartbeat
schedules, and automatic backups. Startup migrations, plugin installation, and
other one-time preparation still run. Normal anonymous health probes return
`warmStandby: true` without SQL or session lookups. This is application liveness,
not a current database connectivity check. Other API requests and WebSocket upgrades return 503 until
the signed claim succeeds. Page and asset requests serve only the static UI
router, bypassing session, bearer-key, tenant, and other dynamic handlers.

Muse defers its startup qualification-evidence update and recurring database
sweeps until standby ends. The first enabled sweep marks interrupted evidence
before it reconciles qualification deadlines or terminal assignments. Claimed
workspaces retain ordinary Muse maintenance even when idle task drain is active.

The existing signed claim on `GET /api/health` writes the identity durably before
normal requests and polling resume. No polling discovers claims and no process
restart is required. Timers resume on their next normal tick; request-driven
work can proceed immediately. Claim failure leaves standby intact. A restart
restores the claim even if provider environment alignment has not completed.
Deleting a claimed workspace's last company never puts it back into standby.

Deploy support before enabling the marker. Validate idle database transactions
and health probes, claim/bootstrap latency, recurring work after claim, and a
restart with stale provider variables on an isolated warm application first.
Rollback by setting the marker to `0` and restarting. No schema changes are
required. This mechanism does not sleep claimed workspaces or replace a durable
scheduler for their background work.

## Native finalization history and idle sleep

Idle sleep retains committed native finalization records as audit history.
A record permits sleep only after its owned run, accepted result, assessment,
applied status decision, and effect deliveries agree on completion. Leases,
retries, recovery requests, unfinished accounting, and incomplete run projections
keep the instance awake. Historical controller identity alone does not block sleep.
The exact run also needs its successful workspace-finalization receipt. Pending
final-reply recovery shares its discovery predicate with the recovery worker, and
live warm sessions remain local work through close/checkpoint completion.

## Feedback history and idle sleep

Automatic idle checks treat private, unshared feedback as saved data. A sent
feedback export is history only when its completion timestamp exists and its
failure reason is clear. Pending, failed, unknown, and inconsistent exports
still keep the instance awake. These checks do not delete history or change
feedback sharing and retry behavior.

## Resource membership tables

Paperclip stores current-user sidebar membership state in:

- `project_memberships`
- `agent_memberships`

These rows are company-scoped and user-scoped. A missing row means the user is joined, so existing users keep seeing projects and agents in the sidebar until they explicitly leave them. Rows only control sidebar visibility; they do not affect project/agent detail access, all-pages, selectors, assignment flows, or existing company permissions.

Both tables use a unique key on `(company_id, user_id, resource_id)` and keep `state` as `joined` or `left`. Join/leave mutations are idempotent board-user `/me` operations and write activity entries when the effective state changes.

Private-project authorization uses the separate `project_access_members` table. Its user/agent rows are security grants, not sidebar preferences, and are evaluated by the same issue-read predicate as issue-level grants. Do not merge or overload these two concepts.

## Decision training snapshot retention

`decision_training_examples` stores a point-in-time copy of an issue, its comments, relevant runs, and the selected decision. Each row carries the `scrub_deleted_comments_v1` retention policy marker, and JSONL exports include that marker alongside the snapshot.

- Deleting a captured source comment transactionally replaces that comment in every affected snapshot with a content-free redaction tombstone. The original body, presentation, and metadata are not retained in the training record.
- Deleting an issue deletes its decision-training examples through the `issue_id` foreign-key cascade.
- Deleting a training example deletes only that example and does not mutate the source issue.

This policy makes training exports self-describing while keeping the decision record usable after a comment deletion without retaining content the author removed.

## Decision queues and triage provenance

The decisions desk stores queue membership, decide-by/snooze state, and retention state in `decision_queues`, `decision_queue_items`, `decision_triage`, and `decision_retention`. These sidecars use the stable attention identity `(source_kind, source_id)` so all attention source kinds can participate without copying source titles, bodies, projects, or other visibility-sensitive data.

`decision_triage_events` is append-only history for queue and triage changes. Current rows and history both carry server-derived user/agent, heartbeat run, API-key, and responsible-user attribution where applicable. Queue reads must resolve and authorize their source rows at read time; a sidecar row is never a visibility grant.

Triage writes serialize on the company and attention-source identity so concurrent partial updates preserve both fields and produce monotonic history versions.

`decision_retention` tracks the last observed source `activityAt`, Keep, reversible archive provenance, and monotonic source/archive versions. `decision_archive_notification_outbox` has a unique key over company, source identity, archive version, and immutable origin agent so repeated sweeps cannot enqueue duplicate notifications; delivery claims are retryable and coalesced per agent.

## Native runner persistence

Native runner state is additive to the existing heartbeat tables. Every existing
`heartbeat_runs` row defaults to `runtime_mode = 'legacy'`; adding these columns
does not select the native runtime or start a runner process. Native execution can
record its resolved runtime profile, provider session, driver, completion
contract, durable event cursor, and finalization phase on the run when a later
rollout explicitly selects it.

`completion_contracts`, `native_run_results`, `native_run_finalizations`,
`work_assessments`, `status_decisions`, and `status_decision_effects` form the
append-oriented evidence and status-decision chain. Unique fingerprints,
versions, ordinals, and idempotency keys make retries deterministic. Composite
foreign keys bind every contract, result, assessment, decision, effect, and
finalization to one company, issue, and run. The database rejects mixed-owner
evidence even when every referenced ID exists. Native source identities on
`heartbeat_run_events` are nullable so legacy events remain readable without
rewriting historical rows. Per-run native source identifiers are unique, while
the existing legacy sequence behavior remains unchanged. The hidden native
coordinator serializes on its bound `heartbeat_runs` row, allocates
`next_event_seq`, and commits a validated PRP event before the transport sends
its cumulative ACK. Byte-equivalent source retries return the existing cursor;
gaps and conflicting replays fail closed. Accepted structured results enter the
finalization ledger, whose retry time and owner lease are checked under a row
lock. None of these writes selects a runtime or changes a legacy run's execution
path.

Durable agent session goals are an additive projection on
`agent_task_sessions`, distinct from the business-goal hierarchy. The row stores
the negotiated goal capability, normalized snapshot and status, desired state,
provider source cursor, monotonic projection revision, and observation time.
`agent_session_goal_actions` is the control outbox: `(session_id, request_id)`
is unique, so retries return the original accepted action. Provider source
ordering fences duplicate and stale updates, and a cleared projection retains
its revision/cursor tombstone so an older provider event cannot resurrect it.

Issue `status_version` advances when `status`, `assignee_agent_id`, or
`assignee_user_id` changes. A combined status and assignment write advances it
once. Writing the same assignee alone does not advance it. A new blocking
decision can also advance the revision. The assignment trigger has its own name so replay of the historical status migration cannot remove it. The
JavaScript backup path includes user-defined functions and triggers so a restored
database keeps that invariant. Removing or disabling a future native rollout
flag must not delete these records; persisted experimental runs remain available for recovery
and inspection.

`native_run_finalizations` also stores restart ownership and recovery state.
The controller owner is a server boot id, PID, operating-system process-start
timestamp, and monotonically increasing controller generation. Recovery writes
its correlated request id, current state, and a bounded JSON history. A
successor can take the lease immediately only when coordinated handoff or PID
and process-start evidence proves the prior controller is gone, or when the
lease expires. Recovery generation changes do not increment the independent
provider-attempt counter.

## Experimental remote workspace snapshots

Migration [0421_bright_skaar.sql](../packages/db/src/migrations/0421_bright_skaar.sql)
adds the company-scoped `execution_workspace_snapshots` ledger. It records the
workspace, source operation/run, parent, generation, writer epoch, encrypted
object receipt, hashes, manifest digest, and retention state. Integrity and key
fields remain nullable while an upload is pending. Upload attempts record their
candidate object keys before I/O so a lost reply can be reconciled and abandoned
objects can be reclaimed. Object existence alone is not a committed save.

`execution_workspaces.metadata.remoteWorkspace`, schema
`paperclip.remote-workspace.v1`, holds the source, epoch, committed snapshot ID,
remote allocation/path, writer run, and dirty flag. Paths in this record belong
to the remote allocation. Save publication checks the current writer/epoch and
atomically commits the ledger row, authority pointer, and operation receipt.
`execution_workspaces.metadata.remoteWorkspaceSnapshotRepositories` records the
committed snapshot ID and the repository descriptors covered by that archive.
Reservation retains this coverage when it adds requested repositories to the
current source. Successful save publication advances coverage and the snapshot
pointer together. Older saved workspaces capture their previous source inventory
at the next reservation. Newly attached repositories use normal acquisition;
they cannot claim coverage from an older archive. No schema migration is needed.
`workspace_operations` journals preparation, save, restore, and local import;
large file bodies stay outside the database. Ledger identities deliberately
survive source-record deletion so object cleanup can finish.

Snapshots stream through authenticated encryption into S3. Portable archives
preserve supported files, modes, empty directories, confined symlinks, and Git
checkout/index/object state, including unpushed history. Linked worktrees and
object alternates are normalized into standalone Git storage. The versioned
exclusion policy omits runtime transport material and proven rebuildable
dependencies; unsupported entries fail the save.

The current snapshot and active run/restore/recovery/unfinished-operation
references pin saved data. Unreferenced superseded versions receive a seven-day
grace. Retention uses committed producer notifications and actual deadlines;
pinned history and an empty queue do not cause recurring scans. Deletion fences
new adoption, rechecks references, and removes every recorded upload candidate
and winning object within the company/workspace prefix.

Database backups contain snapshot receipts, not S3 payloads or encryption keys.
Disaster recovery requires the database, object store, and original master key.
Unsaved live sandbox edits remain outside that saved-version guarantee. See
[setup and explicit local import](DEVELOPING.md#experimental-native-remote-workspace-storage).

## Chat communication snapshots

Chat communication guidance uses two additive columns: endpoint
`communication_instructions` defaults to empty, and conversation
`communication_guidance` holds the immutable initial task snapshot. Existing
conversations retain a null snapshot; there is no backfill that changes an
ongoing conversation. New Slack tasks receive built-in guidance even when the
endpoint has no additional instructions.

## Telegram private draft identities

`chat_telegram_draft_ids` is a content-free, instance-wide PostgreSQL sequence,
not a company-owned record. Telegram's native Stop callback carries a draft ID
but no actor or Paperclip generation. IDs therefore must not be recycled when
a transaction rolls back or an endpoint/company is deleted and its bot is
connected again. The sequence allocates positive 31-bit IDs without cycling;
exhaustion refuses new draft allocation rather than wrapping or falling back to
random IDs. Never reset it as part of chat cleanup.

The matching `chat_actions` entry remains company/endpoint-scoped and binds the
draft to its exact conversation, publication attempt, runtime, credential and
approved text. Stop can suppress that private draft's final publication; it
cannot cancel a task or model run. Logical backups preserve the sequence, but
restoring an older database may roll back its high-water mark: disaster recovery
must not assume stale provider Stop events are safe to reuse. That restore
boundary is not qualified by the rollback/concurrency regression.

## Attachment upload provenance

`issue_attachments.originating_run_id` records server-derived run attribution at
upload time. It is not writable through attachment or work-product update APIs.
Legacy attachments and uploads without a registered run keep a null value; the
migration deliberately does not infer attribution from mutable work products.
Deleting the originating run clears the reference and fails closed for automatic
chat handoff. An agent's external file selection must match the attachment's
company, task, agent, and originating run. Editing or recreating a work-product
record cannot reassign that authority to a later run.

## Question-response delivery receipts

`issue_question_response_deliveries` is the retry-safe, content-free outbox for
answered `ask_user_questions` interactions. Its unique interaction and correlation
indexes enforce one causal delivery per response. It records source and target
run/turn ids, payload digest, attempt/acknowledgement state, and one of `steered`,
`coalesced`, or `wake_fallback`; answer content remains only in
`issue_thread_interactions.result`. Deleting the interaction cascades its receipt,
while deleting a referenced run clears that run pointer without deleting history.

The question-history index covers `(company_id, idempotency_key)` for every
`question-response:` wake state, including failed, cancelled, and skipped
receipts excluded from the delivery-idempotency fence. Migration `0332` creates
this nonunique index concurrently through the standard migration executor.
Apply it with `pnpm db:migrate` on a direct connection before enabling the new
sleep guard. The executor retries interrupted invalid builds and records history
only after the index is valid. It does not delete delivery or wake records.

## Plugin database namespaces

The plugin runtime tracks plugin-owned database namespaces and migrations in `plugin_database_namespaces` and `plugin_migrations`. Hosted deployments that separate runtime and migration connections should set `DATABASE_MIGRATION_URL`; plugin namespace migration work uses the migration connection when present.

## Backups

Paperclip supports automatic and manual logical database backups. These dumps include
non-system database schemas such as `public`, the Drizzle migration journal, and
plugin-owned database schemas. See `doc/DEVELOPING.md` for the current
`paperclipai db:backup` / `pnpm db:backup` commands and backup retention
configuration.

Database backups do not include non-database instance files such as local-disk
uploads, workspace files, or the local encrypted secrets master key. Back those paths
up separately when you need full instance disaster recovery.

## Secret storage

Paperclip stores secret metadata and versions in:

- `user_secret_definitions`
- `user_secret_declarations`
- `company_secrets`
- `company_secret_versions`
- `company_secret_bindings`
- `secret_access_events`

Company secrets use `company_secrets.scope = 'company'` and are bound directly
through `company_secret_bindings`. User-specific secrets reuse the same provider
and version storage, but each value is a `company_secrets.scope = 'user'` row
with `owner_user_id` and `user_secret_definition_id` set. Definitions describe
the reusable company-level slot, declarations record where `user_secret_ref`
bindings are required, and the concrete value is selected later for the
responsible user.

Secret-aware env bindings are supported by agents, projects, and routines. Routine env lives in `routines.env`, is captured in `routine_revisions.snapshot`, and routine dispatches store `routine_runs.routine_revision_id` so runtime secret resolution uses the env snapshot that existed when the run was created. Routine secret refs bind with `target_type = 'routine'`, `target_id = routines.id`, and `config_path` values under `env.*`.

For local/default installs, the active provider is `local_encrypted`:

- Secret material is encrypted at rest with a local master key.
- Default key file: `~/.paperclip/instances/default/secrets/master.key` (auto-created if missing).
- CLI config location: `~/.paperclip/instances/default/config.json` under `secrets.localEncrypted.keyFilePath`.
- Backup/restore requires both the database metadata and the local master key file; either artifact alone is insufficient.
- The server best-effort enforces `0600` key file permissions and provider health reports permission warnings.
- User-scoped values use the same local encrypted provider path. Database
  backups preserve definitions, declarations, owner metadata, version metadata,
  and access events, but restored user-scoped values are decryptable only when
  the matching local master key is restored with the database.

Optional overrides:

- `PAPERCLIP_SECRETS_MASTER_KEY` (32-byte key as base64, hex, or raw 32-char string)
- `PAPERCLIP_SECRETS_MASTER_KEY_FILE` (custom key file path)

Strict mode to block new inline sensitive env values:

```sh
PAPERCLIP_SECRETS_STRICT_MODE=true
```

You can set strict mode and provider defaults via:

```sh
pnpm paperclipai configure --section secrets
```

Inline secret migration command:

```sh
npx paperclipai secrets migrate-inline-env --company-id <company-id> --apply

# direct database maintenance fallback
pnpm secrets:migrate-inline-env --apply
```

Hosted AWS provider notes live in [SECRETS-AWS-PROVIDER.md](./SECRETS-AWS-PROVIDER.md).

Sandbox runtime configuration resolves a provider's secret-reference fields
through its schema-only lookup. Each lookup reads the selected plugin ID
and a SHA-256 hash of its current schema in one database statement. A matching
retained schema is omitted from the query result. Selection order, schema
changes, and deletion remain visible on the next lookup, without a time-based
cache. A database error still fails the lookup.

The retained schemas are private to one `Db` object, with at most 32 entries of
64 KiB each in serialized form. Larger schemas still work and are read in full.
Callers receive independent schema objects. This reuse stores neither resolved
secrets nor authorization decisions. Default driver lookups still read complete
current plugin records and enforce their existing readiness and worker checks.

### Persistent agent conversations

Migration `0274_agent_chat.sql` adds conversation identity/state and session generation/boundary columns to `issues`, plus idempotent client request IDs and processed session-boundary generations to `issue_comments`. The company/agent/user unique index resolves concurrent first writes to one issue. A check constraint preserves the assigned-agent identity and prevents terminal conversation status. Comment request IDs are unique per issue and user. There is no separate chat/message store. Provider sessions continue to use `agent_task_sessions`; `/new` removes only the matching conversation session, and session writers fence stale generations against the issue row.

## Resource lifecycle events

`resource_lifecycle_events` records content-free lifecycle hooks in the same
transaction as the resource change. Hired agents and new projects emit `create`.
Pending hires emit creation only when `activatePendingApproval` succeeds.
Rejected hires emit termination without creation. Agents created as terminated
emit no creation event. Capture is generic and works on self-hosted and managed
instances; recording an event does not authorize a provider operation.

A partial unique `(company_id, resource_type, resource_id)` index deduplicates
creation. Each actual agent pause, resume, or termination appends another event,
including budget actions and generic status updates. The agent row stays locked
until status and event commit, so concurrent repeat requests emit one hook.
Project edits and workspace additions, updates, and removals append `update`.
Repository replacement emits one aggregate update; project creation with repositories
emits only creation. Project mutations hold the project row lock until their record
commits. An active-to-archived transition emits `archive`; restoring an archived
project emits `update`. Repeat archive or restore requests emit no new status
record. An edit combined with archive emits `update` followed by `archive` in
the same transaction. Archiving preserves workspace records and authorizes no
provider cleanup.
Termination commits API-key revocation in that same transaction.
Hire approval and rejection commit with agent activation or termination, so a
failed event write leaves the decision pending and retryable.

Creation is delivered first for each resource, including a backfilled creation
whose ID is newer than earlier captured transitions. The remaining events follow
numeric ID order. Plugin delivery
must enforce company scope, preserve resource order, and track acknowledgments
per plugin. A global high-water mark can skip transactions that have not yet
committed; it is not a safe delivery cursor. The journal stores only identity,
action, and timestamps, not repository snapshots, credentials, provider config,
or resource health. Company deletion cascades to its events. Resource deletion
retains events, so consumers must revalidate existence and eligibility and load
current authorized repository data. A termination hook does not authorize
provider cleanup without the plugin's own authorization and retention policy.

Migration `0309_loving_the_hood.sql` seeds a one-time current-state baseline before
plugin delivery is available. It records creation for existing hired agents and
all projects, including archived projects. Pending hires stay behind approval.
Paused and terminated agents receive missing final status intents. A partial
journal ending at pause receives resume when the current agent is running.
Archived projects receive missing archive intents. A partial journal ending at
archive receives update when the current project is active.
Existing records remain intact, and rerunning the baseline does not duplicate it.
The migration also repairs the journal ID generator in older JavaScript restores
that lost identity metadata, starting above existing IDs. New JavaScript backups
preserve identity generation, sequence options, and sequence progress.
Resource writes wait for the migration transaction to commit. These records
represent current desired state, not reconstructed historical transitions.
There is no later or runtime journal backfill. Plugins use `ctx.events.listLifecycle(companyId, limit?, afterId?)` and
`ctx.events.acknowledgeLifecycle(companyId, eventId)` with `events.subscribe`.
The host requires a matching company invocation (or configured-company proactive
access) and a ready plugin enabled for that company.
`plugin_lifecycle_acknowledgments` stores progress independently
for each plugin and event; plugin and event deletion cascade acknowledgments.
Reads return creation first, then the earliest unacknowledged transition for each resource, up to 100
resources. Acknowledging a later event is rejected. Reads never consume work, so
crashes, retries, and restarts cannot lose a hook; concurrent reads can repeat an
event. There is no global cursor or runtime backfill scan. Consumers must serialize their
processing and make provider operations idempotent before acknowledging success.
Retention and provider integration remain separate work.

Lifecycle polls can page past failed resources using the last returned event id as
`afterId`. Reset `afterId` at the start of every polling sweep: it is a page
cursor, never a persisted high-water mark. This retries failures and includes
transactions that commit later with lower ids.

A lifecycle page reads the company's unacknowledged events for the requested
types once. It keeps one head for each resource: the unacknowledged creation,
else the oldest unacknowledged event. Then it applies `afterId`, id order and
the limit. Cost grows with the company's journal size, not with pending events
times acknowledged history. The idle-sleep check only asks whether any
unacknowledged event exists, because each such resource has a head. No index
or migration is needed.

```sh
pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-plugin-lifecycle-inbox.ts --baseline-ref=02bfe71a6b
```

## Legacy controller ownership

Legacy run claims atomically record `controller_boot_id`, a database-clock
`controller_lease_expires_at`, and `execution_stage` before workspace provisioning.
The lease renews independently of output. A different container must not infer
controller death from its own process map or numeric PIDs. Expiration grants
cleanup authority; it does not prove that remote inference has stopped. Recovery
revokes the previous boot identity with a conditional update. Its own claim also
expires so another sweep can finish cleanup after a restart. Historical rows keep
null ownership fields and follow the previous recovery path.

## Agent file persistence and legacy revisions

Managed agent files are current filesystem contents, using the same persistent
instance storage as other workspaces. `agent_instruction_revisions` and
`agent_instruction_heads` are retained as read-only upgrade input. Their heads
are adopted once into the managed directory; new saves never append revisions.
`agent_instruction_working_copies` holds per-run baseline hashes, state, and
capture receipts. New receipts identify `paperclip.agent-files.v1`; historical
rows retain the instruction-only format. Completed directory runs discard their
baseline and private copies. See [Persistent agent files](agent-files.md).

## Large API response snapshots

`assets.byte_size` uses PostgreSQL `bigint` so saved responses and byte ranges can
exceed 2 GiB. The API and Drizzle mapping continue to expose a JavaScript number;
response readers validate safe integer offsets. The type-widening migration
rewrites the asset metadata table and needs an exclusive table lock. File bytes
remain in local or object storage.

### Runner API response reservations

`runner_api_response_reservations` holds company-scoped API snapshot reservations.
Before a capture spills, the server locks company admission and counts stored
`runner-api` assets plus unattached reservations against a 20 GiB default quota.
A committed asset replaces its reservation in that total. The asset foreign key
cascades on deletion, while deleting a run sets `run_id` to null so an orphan
reservation cannot silently disappear. Failed cleanup or an ambiguous storage
write requires operator reconciliation before an unattached reservation is
removed. The table stores no response bodies. See `doc/runner-api-tools.md` for
limits and the operator override.

Project `privacy_owner_user_id` records who may manage its audience independently of project read membership. Creation assigns the authenticated user or run responsible user; migration recovers legacy ownership from creation audit evidence. Missing evidence leaves management with administrators.
## Internal agent commentary

The Audit viewer uses the existing company/kind/created index.
List reads select bounded previews; details load a single full body. Both reads
and list counts apply company and source-task visibility. The viewer requires
no experimental toggle. A permission-only migration grants `commentary:view` to
existing active human company members, including viewers, without changing
existing grants or the commentary schema.

`agent_commentary` stores company-scoped, attributed complaints and suggestions
as free-form text in the instance database. Legacy agents use the default
`complain` and `suggestion-box` runtime skills; native runs use dedicated tools
in standard, ask, and planning modes. Submission never changes task disposition
or routes feedback externally. See [Agent commentary](agent-commentary.md) for
authentication, replay, document-sized limits, inspection, and deletion semantics.

## Agent identity keys and backups

`agent_identity_keys` stores one encrypted Ed25519 identity per agent. Its migration
creates schema only: existing agents provision on their next managed run. Public
reads and server startup do not provision them. Normal backups preserve identity
rows and need the matching secrets master key for recovery. Both development seed
modes omit identity rows, including with live-work preservation, so copied agents
get fresh identities. See [Agent cryptographic identity](AGENT-IDENTITY.md).

### Slack app registration

`chat_slack_registrations` stores one company-scoped app registration per chat
endpoint. A composite foreign key binds `(company_id, endpoint_id)` to the
endpoint's company. It contains the creation request ID, immutable manifest
snapshot/hash, OAuth callback URI, app/client IDs, vault references, installation
identity, status, safe failure code, creator, and timestamps. It contains no
plaintext configuration token, OAuth code, signing/client secret, or bot token.

Creation records `creating` before dispatch. An interrupted attempt becomes
`uncertain`; a new request needs explicit confirmation that no app exists.
`install` means the app exists. `credentials_saved` means the OAuth bot token is
vaulted and connection checks can resume. `configured` means runtime credentials
are durably bound; staged duplicates are cleaned and the client secret remains
available for reauthorization. `removed` invalidates registration and keeps the
safe app management link for provider-side cleanup.

`chat_endpoints.setup.slackAvatar` records optional avatar provisioning as
`pending`, `uploaded` with its confirmation timestamp, or `failed` with a fixed
safe error code. It survives reloads and restarts. App credentials are durably
bound before icon upload; an interrupted upload never triggers another app
creation. This JSON state stores no token, image URL, or provider error payload.

`chat_endpoints.setup.slackAccount` stores the OAuth installer’s Slack ID, the
initiating Paperclip user ID, pending/linked status, durable welcome-DM and
optional verification-DM status, and the returned DM channel ID. It stores no
user OAuth token or provider payload.
The account uses the existing company-scoped `chat_identity_links` table; it
preserves conflicting/revoked links and does not change on reauthorization.
Both message dispatches move pending → sending before network I/O, then sent/failed;
a restart or ambiguous response moves sending → uncertain without replay.
Signed Request URL verification can precede installation. Internal setup state
retains a signing-secret fingerprint and observed URL so configuration preserves
that evidence only for the same secret and callback. No plaintext secret is stored
in setup state, and the fingerprint is excluded from endpoint responses.
For automatically registered apps, `webhookVerifiedAt` also records successful
delivery of an authenticated message/app-mention event to the current callback
URL. The current signing secret, saved app/workspace/bot binding, active connection,
and runtime generation are checked before recording it. This is Paperclip's
connection evidence, not Slack's settings-page URL-verification flag. Activity
identifies this evidence as `authenticated_event`; no message body is recorded.

Slack install attempts use `tool_oauth_states` with the `slack-install.` namespace.
They expire after ten minutes, bind the company/connection/endpoint, registration
request ID, app ID, initiating actor/session, callback URI, and requested scopes,
and are atomically deleted before code exchange. The `code_verifier` column holds
this non-secret binding for this namespace; Slack bot installation does not use
PKCE. Removal and manual recovery invalidate outstanding attempts under the same
credential-mutation lease used by configuration.

### Slack manager workspace grants

`chat_slack_manager_grants` stores a personal workspace authorization, scoped by
company, Paperclip user, Slack user, workspace and manager app. Access/refresh
credentials are references to user-scoped vault entries, never plaintext columns.
Revision fencing protects reauthorization from concurrent revocation. Per-method
rate-limit deadlines retain Slack's Retry-After across setup retries.

`chat_slack_registrations.manager_grant_id` is optional, with a composite company
foreign key. Existing registrations remain customer owned with a null reference.
Deleting one endpoint removes its registration credentials and attempts, but does
not revoke grants used by other bots. See [Slack setup](connections/slack-setup.md).

## Transaction-aware delivery work signals

Durable delivery queues, including plugin resource lifecycle events, use process-local work signals to avoid empty
polling. Register work **before** writing a queue row, on that row's transaction:

```ts
await db.transaction(async tx => {
  await signalDatabaseWork(tx, "queue-topic");
  await tx.insert(existingQueueTable).values(row);
});
```

`createDb` instruments transaction callbacks and nested savepoints. Subscribers
receive intent immediately and settlement only after the outer transaction
finishes. Caller-owned transactions therefore need no extra post-commit wrapper.
Dedicated clients from `withDedicatedDbConnection` share the owner's signal
scope. No schema changes, triggers, dedicated listener connection, or periodic
queries are installed by this API.

The first registered write in a transaction fetches `pg_current_xact_id()`.
Awaiting registration is required: a failure at that point must prevent the
queue write. Unrelated transactions add no queries. If the transaction rejects,
the coordinator probes `pg_xact_status(xid)` through the root pool before scanning
the queue. An in-progress transaction remains unresolved even when the queue
currently looks empty. Committed/aborted results permit reconciliation; NULL
means PostgreSQL has discarded an old, no-longer-active transaction's outcome.
The existing durable queue supplies the work in either case. Probe failures
retain the idle hold and schedule another attempt. Work signals never replay
queries or convert a failed database operation into success.

This uses PostgreSQL's transaction-information functions (this path requires
PostgreSQL 14+; embedded PostgreSQL uses 18). See the
[PostgreSQL transaction information documentation](https://www.postgresql.org/docs/18/functions-info.html#FUNCTIONS-PG-SNAPSHOT).
The process-local intent survives coordinator replacement, but not process exit.
Startup scans recover committed queue rows. Independent DB clients, other
processes, late transactions from an old process, and database failover need an
explicit ownership/wake protocol; these signals are not cross-process messaging.
Use the same root client for in-process writers. New queue insertion paths must
register before writing, or they can remain unseen until the next startup or
another notification. Tests should verify both the producer and its outer
transaction boundary.

### Installed skill packages

`company_skill_repository_snapshots` retains its identity and company/content-hash
uniqueness. Despite its historical name, it can also hold editable skill packages.
Migration 0414 (`0414_sleepy_payback.sql`) adds `storage` (archive/manifest receipts) and `upload` (a bounded
pending attempt). `file_inventory` remains the legacy payload, defaulting to `[]`.
`company_skill_versions.package_snapshot_id` and `package_file_map` preserve the
public version file inventory without storing its contents again. Existing repository
snapshot/entrypoint references and version IDs remain unchanged. Reference indexes
support bounded orphan checks; restrictive FKs protect retained version packages.
Version mappings preserve kinds and encodings when identical bytes share a package.
Authored saves mark the storage receipt `durable`; retirement atomically respects that
marker even when the save joins a concurrent Git upload.

`skill_package_deletions` is a durable object-deletion outbox populated by snapshot
update/delete triggers. Its company ID deliberately has no cascading company FK:
cleanup must retain exact object keys after company deletion. Upload promotion skips
retirement; replacing a pending token retires only the old attempt's unique keys.
The same migration adds exact-commit restore recipes and indexed conversion/maintenance
deadlines. A bounded coordinator worker automatically converts and clears verified
legacy payloads; no migration command is required. Warm reads exclude recipe manifests.
See [package storage](skill-package-storage.md) for acquisition, retention, compatibility
overrides, independent restore verification and coordinated backup policy.

### Project repository skill synchronization

`project_skill_sources` stores durable workspace import jobs and originating project
access provenance. Active bindings track their repository/ref; inactive bindings retain
access to installed versions. Project deletion removes bindings, but retained skills
with `access_source_id` stay restricted when no originating project remains.
Removing a project source hides tracking using `company_skill_sources.removed_at`
while retaining its access identity for editable copies and forks. Bindings become
inactive and refresh leases are invalidated transactionally. Reattachment preserves
removal; explicit adoption creates or joins an active source with a separate identity.
Migration 0341 limits repository/ref uniqueness to active sources. Removed sources
retain their original project audience; editable forks capture independent retained
provenance so later attachments cannot expose their local edits. Membership and
project visibility are still evaluated dynamically.

`company_skill_sources` stores automatic-update and future-import preferences, setup
user/agent and connection/grant IDs, next-check time, failure count and existing refresh
leases. Existing sources default to automatic updates with their selection preserved.
Credential values remain in the connection secret system. No project membership lists
are copied into skills. Background publication uses normal immutable versions and
transactional activity attribution. Setup agent and connection identifiers remain after
those identities are deleted. Refresh then requires explicit repair; deletion cannot
silently substitute board authority or another connection. Execution snapshots keep
only the delivered skill keys and their immutable version IDs. New executions resolve
the latest installed versions without an upstream fetch.

Project-derived sources retain `HEAD` for an unspecified repository ref. It follows
GitHub's current default branch. An explicitly configured branch has a separate
source identity even if it currently resolves to that default branch. API-key
agents without an authenticated run may attach repositories; their durable import
jobs have no setup person and require adoption by an authorized person.

Independent sources can change their tracked branch or revision through source
settings, including `HEAD` to follow the default branch. Validate the repository
identity and the requested commit read
before changing the ref; preserve installed skill IDs, versions and selection. Active
project bindings must change their ref through the project configuration. `HEAD`
remains the default-branch alias after refresh, including for independent sources.
Branch changes use the source revision and lease fence, reject duplicate repository/ref
sources, keep installed version rows unchanged, and enqueue the normal refresh path.
Branch listing uses the caller's authorized connection, not the stored setup identity.

### Task workspace records (2026-10-09)

Migration [0336_big_crystal.sql](../packages/db/src/migrations/0336_big_crystal.sql) makes `execution_workspaces.project_id` nullable and changes its project reference to `ON DELETE RESTRICT`: source-project policy cannot disappear while a workspace still depends on it. `issues.execution_workspace_id` remains the sole active task binding. Versioned selection/pending-selection JSON and a binding revision record intent and protect transitions; they are not additional active bindings. Accepting a new pending choice advances the revision without changing the active folder. Its receipt retains the original request revision, so current-choice retries are idempotent and superseded retries fail the revision check.

`execution_workspace_repositories` is company-scoped inventory beneath an execution workspace. It records repository identity, contained relative path, requested ref, pinned commit, preparation state and idempotency receipts. Credentials are resolved at use and are never stored in this inventory. Connection/destination `execution_defaults` JSON contains optional typed project/workspace choices, never arbitrary host paths or commands.

The physical-root tables introduced by migrations
[0337_exotic_proemial_gods.sql](../packages/db/src/migrations/0337_exotic_proemial_gods.sql)
and [0338_absurd_vengeance.sql](../packages/db/src/migrations/0338_absurd_vengeance.sql)
are legacy: `execution_workspace_repository_roots` and
`execution_workspace_repository_access` remain in the schema with their existing
data, but runtime services neither read nor write them. There is no backfill,
cleanup job, startup DDL, or schema migration for this retirement. Historical
`anonymous_only` / `managed` classifications and source/reader identities have no
effect on new operations.

`execution_workspace_repositories` remains active and records actual repository
requests, pins, preparation state, and idempotency. Shared publication recovery
uses the current receipt and the exact receipt named by the checkout's bounded
ownership marker, with company, origin, ref, path, and pin integrity checks.

The disposable preparation benchmark compares a pinned pre-removal commit with
the checked-out implementation using 8,500 workspaces, 4,800 shared-root records,
5,300 retained sources, and 50 readers. It reports two warmups and five measured
samples, phase medians/ranges, SQL fingerprints, and canonicalization counts.
Both retired-table query counts must remain zero, and increasing peer history
must not increase preparation authorization or path checks. Record the exact
treatment commit and measured improvement in the change's verification report.
These service measurements exclude network acquisition, copying, environment
acquisition, and provider startup. Reproduce with:

```sh
pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-workspace-preparation-history.ts --baseline-ref=df80616d98119cbf5abd40549794d9980a5fabf6
```

Workspace-record and workspace-operation `_issuePrivacySources` /
`_runPrivacySources` metadata and their migration 0313 triggers remain app-data
privacy controls. They do not authorize filesystem access. Current run identity,
selected project policy, acquisition/credential authority, concrete copy identity,
path containment, and lifecycle serialization remain enforced. Low-trust execution
still suppresses controller provisioning according to the selected environment.

No migration scans or copies existing agent home directories. Keep admitted native descriptors and recovery references until compatible controllers finish their persistence obligations. See [the architecture rollout contract](plans/2026-10-09-task-workspaces.md).

Migration 0341 stores the last scanned Git tree and a durable automatic-refresh
work allowance. The allowance starts at 512 MiB, refills at 512 MiB/hour, and
reserves the existing 128 MiB upper bound before automatic downloads. Completed
small scans refund unused capacity; interrupted/failed work keeps its bounded
reservation. These internal fields do not appear in source responses.

Automatic initial repository imports reserve durable company work credits before
provider reads: 512 MiB capacity, refilling 512 MiB per hour, with a 128 MiB
reservation per attempt. Failed downloads and package fallback keep the full
reservation. Successfully linked small imports refund unused measured work.
Completed bindings do not reset company credits; waiting jobs retry on refill.
The company_skill_import_budgets table stores no credentials or source contents.

### Execution recovery query performance

Conversation recovery keeps indexed run and task UUID columns as UUIDs. Saved
JSON identifiers pass a canonical lowercase UUID guard before conversion.
Malformed, uppercase, numeric and cross-company values retain their old behavior.
Ownership candidate reads split native and legacy issue bindings so existing
indexes can filter candidates before reading large contexts. Native bindings
continue to override legacy context IDs. No new index or migration is needed.

```sh
pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-recovery-queries.ts --baseline-ref=1e731520bb
```

This disposable fixture compares the real ownership, recovery-action and status
delivery queries, including complete positional results and database plans.
All data is synthetic. Query timings exclude process liveness probes, HTTP and
provider work.

The reconciler's lost-wake check for user comments reads in three stages.
The first stage keeps recent user comments that no wake request carries. The
second stage removes comments with a live or later run, and it requires an
earlier run. Each stage probes native and legacy run bindings separately with
existing indexes. Only the remaining comments reach the steer check, which
reads run event payloads. An OR across both bindings let PostgreSQL hash the
runs by company only and test each comment against every run of its company.
No new index or migration is needed.

```sh
pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-comment-wake-check.ts --baseline-ref=02bfe71a6b
```

This disposable fixture compares the complete check result, the complete
positional SQL rows, plans, and timings with and without nested-loop joins.

### Agent runtime synchronization journal

Migration 0347 adds the opt-in `agent_runtime` resource stream. Database triggers
record content-free configuration invalidations and managed file audit events in
`resource_lifecycle_events`. They share the mutation transaction and fail the
mutation if journal insertion fails. An INSERT trigger sends an empty PostgreSQL
notification on `paperclip_plugin_lifecycle` after commit. The host subscribes
only when a ready runtime subscriber is installed. This feature requires a
session-compatible database connection; do not enable it through a transaction
pooler. Reconnection scans the durable journal. Existing process-local work
signals continue to serve other delivery queues. See
[the plugin contract](plugins/AGENT_RUNTIME_SYNC.md).

Migration 0354 extends this stream to standing connection assignments. Statement
triggers compare the fields returned by the assignment snapshot and coalesce
company invalidation within the mutation transaction. Agent runtime journaling
uses ordered `FOR NO KEY UPDATE` locks, which remain compatible with foreign-key
references while excluding runtime readers' `FOR SHARE` locks. Connector feature
switches use the same journal; process-start overlays receive a delivery baseline.

Migration 0355 extends connector invalidation to tool definitions and
configuration. Statement triggers cover applications, connections, catalogs,
profiles and entries, bindings, policies, and MCP gateways. They ignore health
bookkeeping and trust-rule usage counters. Profile creation alone does not change
an agent's runtime; its assignment does. Entry changes resolve standing profile
bindings; policies resolve old and new agent selectors. Both retain scoped
recipients. Credential-only fields remain outside this migration's coverage.

Migration 0356 adds access, referenced credentials and vaults, and chat/email
endpoint configuration to connector runtime invalidation. Grant and membership
changes retain company scope. Agent secret bindings and new personal delegations
use agent scope. Credential values remain outside the journal. Endpoint activity,
vault health, and other bookkeeping fields remain excluded.

## Retired Pipelines storage

The Pipelines experiment has been removed from the application, API, CLI, and
experimental settings. Its `pipelines` and `pipeline_*` tables, schema definitions,
and migration history remain so existing records, documents, and links are preserved
and future schema generation does not drop them. No removal migration or data
cleanup runs. These tables remain part of normal database backups; the separate
Cases feature is unaffected.

### Prompt injection classification

`company_prompt_injection_prevention` stores optional shared connection/model
preferences without backfilling existing companies. `prompt_injection_invocations`
stores content-free classification verdicts, provider receipts and archival
identity references. Budget reservations have a distinct classifier invocation
source, and cost events accept `prompt_injection`. Unknown charges retain their
holds through agent deletion attempts and settle through billing correction.
See [service behavior](prompt-injection-prevention.md).

### Deferred conversation requests

`issue_thread_interactions.dismissed_at` and `dismissed_by_user_id` record a
human's decision to leave a pending request in history. They are independent of
`status`, `result`, and `resolved_at`: dismissal is neither an answer nor approval.
The board-only dismissal path locks the task then interaction, checks audience,
and never enqueues a continuation. Ordinary deferred requests are excluded from
completion arbitration; protected authorization gates remain active.

### GitHub inherited review-wait reads

Passive GitHub review waits select only the assessment's `reviewedCommit` JSON
value. The read preserves its JSON type for strict comparison with the review
head. It still checks current requester provenance, company and agent bindings,
connection state, repository identity, latest review, and processed publication.
The complete assessment remains stored for review and publication.

The synthetic PostgreSQL benchmark captures the service-generated baseline and
treatment queries, compares complete outputs, and measures raw DataRow bytes:

```sh
pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-github-review-wait.ts --baseline-ref=663fe667d66d3863d0919a8724f1d99500feef0b
```

It uses disposable embedded PostgreSQL by default. A disposable local database
named `review_wait_benchmark...` can be supplied through
`PAPERCLIP_TEST_DATABASE_URL` to compare another PostgreSQL major version.
DataRow bytes exclude response metadata and transport overhead.


### Sandbox creation ownership

Migration 0418 adds `sandbox_creation_operations`. Admission commits company,
original environment, run, request key and provider identity before external
creation. Configuration contains nonsecret values and existing secret references.
The original identity survives environment, run, task and company deletion; only
the optional live environment FK uses SET NULL. Company/run deletion must not
erase an outstanding remote-resource obligation.

The unique company/environment/run/request index fences duplicate creation and
ambiguous successful lease commits. Normal lease attachment and operation transfer
share a transaction. Recovery transfers one claimed cleanup lease after provider
ownership lookup. The pending deadline index drives the existing cleanup worker.
`needs_reconciliation` is a durable manual outcome, not an automatic retry or an
idle blocker. See [cleanup ownership](idle-environment-cleanup.md).

## Object-backed run evidence

Optional segmented run logs and raw provider traces store their payloads and
range indexes directly in S3-compatible storage. Existing `heartbeat_runs` and
`provider_trace_records` contain backend/reference and lifecycle metadata;
there is no new payload table or per-segment SQL publication. Object manifests
use conditional writes to fence publication. Existing structured events retain
their database append contract. See [run evidence storage](run-evidence-storage.md).

## Cloud runtime configuration singleton

The private `instance_settings` key `cloud-runtime-config:v1` holds a strictly
validated, versioned nonsecret configuration and revision. It is separate from
the ordinary instance settings API. Seed inserts preserve an existing winner;
replacements lock the row and reject stale revisions. Database/transaction
handles permit atomic migration receipts. Connection URLs, API keys and unknown
fields are excluded. See [field ownership and startup order](cloud-runtime-configuration.md).

## Independent accounting and budget evaluation

`budget_evaluation_work` holds independent pending inputs for committed exposure
changes, with company and captured agent/project attribution. Producers append
in their financial transaction after registering transaction-aware notification.
The worker evaluates a consistent snapshot, fences policy publication through
`budget_policies.evaluation_version`, and deletes only its selected committed
input IDs in the publication transaction. A later commit with an older allocated
ID remains pending. Policy creation/edits also append inputs, so a previously
consumed no-policy batch cannot hide a newly applicable threshold.

No financial commit increments a company/agent spend counter or company dirty
version. Monthly API totals aggregate `cost_events`; runtime totals use existing
`accounting_runtime_baselines` plus acknowledged v2 run ledger. Retained counter
columns are non-authoritative. Invoice and verified late-receipt corrections
retain append-only `cost_adjustments` evidence and immutable reported amounts.
`cost_events.reported_usage_json` retains original placeholder usage before a
verified late receipt updates effective token/request fields; each adjustment
retains its previous usage in `previous_usage_json`.
Unknown late run receipts remain durable per-receipt debt; resolving one receipt
cannot clear another unresolved receipt.

Live usage receipt writes use READ COMMITTED and the existing run-row lock. All
mutable receipt and accounting reads occur under that lock. A streamed run-log
append between company validation and lock acquisition therefore cannot exhaust
serialization retries. A concurrent finalization is read under the lock and
keeps the normal late-receipt reconciliation path. Other independent accounting
operations retain their repeatable-read snapshot. Receipt identity, replay
conflicts, company scoping and budget-work publication remain transactional.

Upgrade all controllers/workers to this accounting contract and drain incompatible
pre-upgrade database transactions before enabling independent writers. Do not run
pre-upgrade synchronous counter/evaluation writers beside unlocked writers.
Rollback must use a compatible version that reads the ledger and retains the
durable evaluation feed; a pre-contract binary is not a safe rollback target.

## Standard workspace and Classic opt-in

Migration `0433_workspace_defaults.sql` adds `classic_workspace_enabled`, default
false, to personal workspace preferences and sets the legacy Coordinator column's
default to true. Existing rows retain their old Coordinator experiment values,
but those values no longer select the active workspace. API reads derive
`coordinatorWorkspaceEnabled` from the inverse of the Classic choice. Saves
retain the existing account and company-audit checks. Replaying the migration
preserves explicit Classic choices. Agent Chat ignores its retired stored flag
without rewriting instance settings. No task, agent, or execution state changes.
