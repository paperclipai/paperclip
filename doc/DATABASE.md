# Database

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
column decoding. It retains the Drizzle builder caller for normal, prepared,
transaction, and dedicated-pool execution. It issues no queries.
It logs the public server caller locations, static schema table, operation,
query/row counts, and response value sizes. It emits at most 2,048 aggregate
groups and a summary. Measurement stops at the deadline. Environment-enabled
captures emit at most 64 records per second and can take another 33 seconds to
finish writing the bounded output. Wait for the summary before collecting it.
It never logs SQL, parameters, result
values, connection strings, or query errors. In-flight queries continue normally.

For a bundled server, keep the linked source maps and enable Node's
`--enable-source-maps` option so the diagnostic can resolve public caller
locations. Restore the prior Node options after capture. Sizes still count when
caller locations are unavailable.

Look for `paperclip.db_response_capture.entry.v1` and
`paperclip.db_response_capture.summary.v1` in the process logs. A log provider
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
   `@event:paperclip.db_response_capture.entry.v1 AND @captureId:<id> AND @groupPage:0`.
3. If the provider's record limit is smaller than a page, fetch each
   `groupIndex` separately with the same capture ID. Each index matches one
   entry. Do not split by timestamp: entries can share a timestamp.
4. Deduplicate by `(captureId, groupIndex)`. Require every index from zero
   through `groups - 1`, with no gaps. Entry count must equal `groups`, summed
   `calls` must equal `completedQueries`, and summed `responseValueBytes` must
   equal the summary total. A missing page is an incomplete measurement.

Tagged raw-driver calls, streams, unawaited raw-driver
dispatch, and protocol overhead are not measured. Relational queries use a driver-level caller fallback.
Queries still in flight at the deadline are reported separately. Sizes describe
driver values before column decoding, not billed network bytes. Complex parsed
values use JSON size estimates, counted in `estimatedValues`. Reconcile them with
provider metering and socket measurements. Serialization adds temporary CPU and memory work;
measure the final transfer rate after the window expires.

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
