# Database

Paperclip uses PostgreSQL via [Drizzle ORM](https://orm.drizzle.team/). There are three ways to run the database, from simplest to most production-ready.

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

If your hosted database requires transaction-pooling-only connections (pgbouncer transaction mode, Supavisor port 6543, Neon `-pooler` endpoints), set `DATABASE_PREPARED_STATEMENTS=false` so the client does not rely on session-scoped prepared statements, and keep `DATABASE_MIGRATION_URL` on a direct connection. Do not edit database client source files as part of deployment setup.

### Client tuning (optional)

All of these are optional; when unset, the driver defaults apply and behavior is unchanged — typical self-hosted setups need none of them:

```sh
DATABASE_PREPARED_STATEMENTS=false   # required for transaction-mode poolers; default: enabled
DATABASE_POOL_MAX=25                 # connection pool size; default: 10
DATABASE_IDLE_TIMEOUT_SECONDS=60     # close idle pooled connections; default: 60 (0 = keep open)
DATABASE_CONNECT_TIMEOUT_SECONDS=10  # default: 30
DATABASE_MAX_LIFETIME_SECONDS=1800   # recycle a pooled connection after this long; default: 30-60 min (random)
DATABASE_APPLICATION_NAME=paperclip  # application_name in pg_stat_activity; default: paperclip
```

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
cleanup, feedback export, import cleanup, execution reconciliation, heartbeat
schedules, and automatic backups. Startup migrations, plugin installation, and
other one-time preparation still run. Normal anonymous health probes return
`warmStandby: true` without SQL or session lookups. This is application liveness,
not a current database connectivity check. Other API requests and WebSocket upgrades return 503 until
the signed claim succeeds. Page and asset requests serve only the static UI
router, bypassing session, bearer-key, tenant, and other dynamic handlers.

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

Issue `status_version` advances only when `status` changes. The JavaScript backup
path includes user-defined functions and triggers so a restored database keeps
that invariant. Removing or disabling a future native rollout flag must not
delete these records; persisted experimental runs remain available for recovery
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


## Transaction-aware delivery work signals

Five existing delivery queues use process-local work signals to avoid empty
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
