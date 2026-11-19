# Heartbeat and background work internals

Module map and behavior notes for the heartbeat service and the server's background workers. The rules are in [Heartbeat execution boundaries](../rules/heartbeat-execution-boundaries.mdc).

## Agent status recovery

Lifecycle verification stops automatic attempts after missing authentication,
an unavailable model or command, an invalid working directory, unexpected
probe output, or an owned AI account selection refusal. Account selection guidance
names missing defaults, unavailable accounts, incompatible bindings, missing
responsible users, or credential sharing requirements without provider error text. A generic failed test gets up to three failures before automatic
checks stop. The saved `verificationFailures` count only advances when the host
verification test fails; claims deferred before the test do not spend that budget.
An explicit retry or execution configuration change resets that count.
The agent stays in `verifying`
with execution paused and a safe error message. Its saved lifecycle operation
records `retryRequired`; process restarts and queue scans retain that wait.
Changing execution configuration or using **Retry now** clears it and runs the
normal verification again. Name and title edits do not restart verification.
Timeouts, unavailable test environments, plugin outages and unclassified runtime
failures retain automatic retry. Pause, termination, resource cleanup and idle
sleep checks keep their existing safety gates.

Remote directory and command checks preserve timeout, interruption and transport
failures as typed execution-target failures. Adapters carry that signal in the
optional `AdapterEnvironmentCheck.retryable` field. A retryable error becomes
`test_environment_unavailable` before configuration classification, so it neither
parks verification nor consumes the generic failed-test budget. A completed check
that confirms a missing directory or command still waits for configuration repair.

The retry persistence tests can use a dedicated local PostgreSQL database ending
in `_test` through `PAPERCLIP_LIFECYCLE_VERIFICATION_RETRY_TEST_DATABASE_URL` when
embedded PostgreSQL is unavailable. The test validates that URL before use.

Heartbeat completion locks the agent row before it reads remaining running work
and writes the agent status. A concurrent execution start cannot be overwritten
by a completion that read older run state. Run terminalization and agent status
finalization remain separate steps. If the process exits between them, the
existing startup and periodic orphan-run recovery pass repairs stranded agent
statuses after a five-minute grace period, at most 25 agents per pass.

The repair requires finished runs and wake requests, expired controller ownership,
settled accounting and retries, and no pending resource or instruction cleanup.
It also checks the shared local execution sets. It rechecks under an agent row
lock, preserves pause and retirement, and records the correction in the same
transaction. It preserves run history and does not invent a heartbeat timestamp.
The latest failed or timed-out run produces an error status. This adds no timer,
provider call, or automatic workspace wake. Idle sleep checks remain independent.
Failed lease history uses the same exact cleanup proof as idle sleep. Cleanup
queues are checked separately from retained run metadata. Recovery queries have
a two-second statement timeout, and the repair stops starting new candidates
after five seconds. A repair failure is logged without rejecting the rest of
orphan recovery.

```sh
pnpm exec vitest run server/src/services/heartbeat/agent-status.test.ts server/src/__tests__/heartbeat-agent-status-recovery.test.ts
```

## Queued run dispatch order

When an agent is at its concurrency limit, each freed slot starts the next
queued run chosen by `server/src/services/heartbeat/queued-run-dispatch-order.ts`.
The "place in line" a waiting task shows uses the same facts and order
(`queued-run-line.ts`).

Runs fall into four tiers, started in this order:

1. **Person.** A run a person asked for (an assignment, comment, chat message
   or Retry by a board user, itself or through its source chain), and any other
   non-recovery run on a task tree a person created. A task belongs to such a
   tree when it, or any task above it, has `createdByUserId`. This covers an
   agent's subtasks of a person's task and the parent's resume once they
   complete (`issue_children_completed`), so a half-finished task is not left
   behind newer tasks.
2. **Work.** Other agent work, such as a tree an agent or routine started.
3. **Recovery** and 4. **old recovery backlog.** System recovery wakes, even on
   a person's tree.

Within a tier, runs are ordered by readiness (in progress first), then task
priority, then age, oldest first. A newer run on a person's tree never passes
another person's equally ranked task that has waited longer.

Fairness bounds:

- **Oldest-run share.** Every `OLDEST_DISPATCH_SHARE` (4th) start goes to the
  longest-waiting ready run that has waited past `QUEUED_RUN_AGING_MS`
  (60 minutes), preferring runs people wait on. So even while a deep tree keeps
  adding in-progress or higher-priority work, another person's new task starts
  within 60 minutes plus 4 x (aged person-tier runs queued before it + 1)
  starts.
- **Recovery share.** Recovery takes every `RECOVERY_DISPATCH_SHARE` (4th)
  start from lower-tier work. It is held only while a run a person asked for is
  ready, not for the rest of a person's tree, so a deep tree cannot hold
  recovery indefinitely.
- **Scope.** Queues are per agent, and agents belong to one company, so tree
  priority never moves one agent's or company's runs ahead of another's.

Tree membership is read in one recursive query per dispatch pass, walking each
queued task's parent chain by the `(company_id, id)` unique index and stopping
at the first person-created task (at most 32 levels). It runs only when the
agent has more than one queued run.

## Run history authorization reads

Run history reuses the authorization service's batch read API for distinct task
bindings. Existence checks remain company-scoped and use batches of at most 500
IDs. Missing or foreign tasks stay unreadable in every privacy mode. The batch
snapshot lasts for one request only; the next request checks current grants,
membership, and run restrictions again. Adapters that expose only `decide`
retain the individual-read path with duplicate bindings shared within the request.

## Config Freshness

Agent, project, environment, secret, skill, and workspace config edits are sampled at the next run boundary. A heartbeat that is already running finishes with the config it started with. Native runners project explicitly configured task environment variables into provider processes and tool commands, including custom `PAPERCLIP_*` names such as `PAPERCLIP_PAGE_BUCKET`. Adding, changing, or removing a projected variable replaces a retained provider process at the next run boundary. Unchanged variables permit process reuse. The projection contains names only; secret values stay in the child environment. Ambient host secrets are not projected. Native projections allow up to 128 variable names, 64 KiB per entry, and 256 KiB of values in total. These native launch limits do not apply to legacy adapter configuration. Runtime authority, provider login credentials, and process-loader settings use their existing restricted paths.

Native OpenCode applies that projection when starting `opencode serve`, so its
shell tools receive both plain bindings and resolved company secrets from
`adapterConfig.env`. Forwarded values participate in diagnostic and provider-trace
redaction. The isolated HOME, provider credential proxy, and GitHub broker retain
their existing launch rules. OpenCode owns the `OPENCODE_*` and `XDG_*`
configuration variables; task bindings cannot override them.

When effective run config changes, Paperclip may intentionally skip a saved adapter session, refresh persisted workspace runtime config, replace a reused execution workspace, or avoid reusing a sandbox/environment lease. Fresh execution can lose adapter-specific session, workspace, or sandbox state; correctness of the next run's config takes priority over continuity. Plain environment values affect freshness through value hashes; run result JSON and workspace operation logs expose only the non-sensitive freshness decision categories, without storing secret values, full env maps, provider credentials, or private path details.

A workspace-provider plugin owns the files of the workspaces it prepares, so the run environment only decides where the runner executes. For these workspaces, a changed environment configuration is a refresh, not a replacement: Paperclip records the new workspace fingerprint once and reports the drift in that run only. Other replacement-class changes, such as the repository or base ref, keep the replacement decision.

The saved-session fingerprint covers only inputs that can change what the provider thread saw or may do, or what the native session digest compares before a follow-up turn attaches to its warm Runner. It leaves out the agent config revision row itself (its id and time), agent identity and display fields that tools read live, turn timeouts, the legacy kill grace, permission keys of a provider that is not selected, wake scheduling (`runtimeConfig.heartbeat`), the environment row's update time and selection source, and the environment's release, log-streaming, and RPC-timeout settings. Lifecycle inputs stay in: the lifecycle mode, the agent and environment warm idle windows, and the environment's lease reuse, because they become `session.lifecyclePolicy`, and a kept session with a different policy cannot attach to its warm Runner. `server/src/services/heartbeat/session-fingerprint-inputs.ts` classifies every input with the reason. Its tests fail when an agent revision field, a runner config schema field, a provider permission key, or an environment config key appears without a classification, when a new field reaches a hashed category, or when an excluded runner key reaches the native execution input. An unknown adapter or runtime config key is hashed. A session saved with the previous fingerprint composition is accepted once for the same inputs, so an upgrade does not discard saved sessions.

An explicit `reuse_existing` Git workspace keeps its recorded source repository, including after its project-workspace row is deleted or the project primary changes. The server verifies the original company, project, repository origin, and worktree registration before reuse. It does not attach a deleted association to the new primary. A conflicting explicit project-workspace selection, missing source identity, or an unverified legacy local checkout blocks the run. Restore the original source. Before intentionally clearing the existing-workspace binding to choose a new repository, review and preserve its retained work. Missing worktrees may be reconstructed only from the verified original source; current project defaults are not a fallback.

## Heartbeat Service Extractions

Routine and issue-monitor dispatch uses saved future deadlines through
`server/src/services/scheduled-work.ts` and the existing delivery coordinator.
Startup restores the next deadline. Routine edits and monitor changes notify
their worker after the enclosing database transaction settles, including native
`set_task_monitor` writes. Deadlines crossed during a scan receive an immediate
follow-up scan. Work already overdue at scan start retains heartbeat recovery.
Each worker runs
independently and retains the existing atomic claims and execution checks.
The heartbeat interval still requests a recovery scan; it does not determine
the dispatch time of a known future deadline. Failed scans retry at that same
interval. Future timers do not hold idle work open, and standby, idle drain and
shutdown retain the coordinator's admission gates. During idle drain, expired
deadlines retry at the recovery interval while dispatch is paused; future
deadlines keep their original timer so a canceled drain does not delay them. External database writers
rely on the periodic recovery scan. Sparse cron searches reuse one parsed
expression and skip impossible UTC dates before localized formatting.

Keep relevant heartbeat extractions and their focused tests in `server/src/services/heartbeat/`.
Follow [Heartbeat execution boundaries](../rules/heartbeat-execution-boundaries.mdc)
for state lifetime, admission, recovery ownership, cleanup ordering, and verification.

Runtime-service coordination is in `server/src/services/heartbeat/runtime-services.ts`.
It validates service intents, starts configured services, records adapter-managed
services and primary URLs, and posts workspace-ready notices. Process registries
and leases stay in `workspace-runtime.ts`; the executor keeps release ordering in
its existing cleanup path. Public-path tests use real local service processes.

Instruction working-copy coordination is in
`server/src/services/heartbeat/instruction-working-copy.ts`. Its per-run controller
prepares copies, tracks save receipts, and coordinates warm-directory handoffs.
Live getters preserve updated copies and expose acquired reservations even if
preparation fails. The executor keeps release and environment-cleanup ordering;
a separate release closure defers cleanup failures without replacing run results.
See `tests/e2e/instruction-working-copy/README.md` for isolated browser acceptance.

Task assignment Markdown is rendered by `server/src/services/heartbeat/task-markdown.ts`.
`heartbeat.ts` re-exports it for existing callers. Keep prompt
formatting changes in the renderer and its tests, separate from run orchestration.

Task context assembly is in `server/src/services/heartbeat/task-context.ts`.
`prepareHeartbeatTaskContext` rebuilds prompt fields on the current run context:
continuation summaries, wake comments, task plans, communication guidance, and
full/compact assignment Markdown. It preserves quarantine and secret redaction
before computing turn-context revisions. The executor supplies the already-loaded
issue, session, and trust policy, and retains admission, resource ownership, and
cleanup. Public-path characterization tests are in
`server/src/__tests__/heartbeat-task-context.test.ts`; the workspace-bootstrap
browser fixture also checks the persisted prompt variants and description revision
from a real process adapter before completing its task.

Execution configuration is assembled in
`server/src/services/heartbeat/execution-configuration.ts`: workspace and issue
overrides, scoped credentials, managed AI identity, and runtime skill delivery.
The executor receives credential ownership and failure-redaction updates as soon
as they are available, so later setup failures still clean up acquired resources.
Busy-account deferral returns explicitly before session/workspace preparation.

On Cloud-managed sandbox connections, an ACPX platform check can defer runtime
preparation to the normal Runner launch. After the selected account completes
its provider hello probe or live API-key check, that specific deferred check is
informational. Authentication failures, unsupported platforms, other warnings,
and self-hosted or SSH runtime checks retain their status. A passed connection
test does not replace Runner package verification before execution.
Public-path tests are in `server/src/__tests__/heartbeat-execution-configuration.test.ts`.

Concurrent skill preparations join the company inventory refresh before taking
the version-cache lock. Each preparation then reads its actor's current skill
visibility under that lock. Snapshot materialization and the durable run version
pins stay in the same locked callback. Only the in-flight inventory work is
shared; completed refreshes and permission results are not cached.

Browser Use skill assignment first checks for an enabled, active Browser Use
connection in the run's company. With none, it skips full tool discovery.
With one, the existing task, tool-policy and credential-grant checks still apply.

Session preparation is in `server/src/services/heartbeat/session-preparation.ts`.
It selects fresh or resumable sessions from effective config and managed-account
identity, then resolves adapter session identity and compaction after workspace
preparation. Both phases keep their original ordering in `heartbeat.ts`; they
acquire no runtime resources. Public-path characterization tests live in
`server/src/__tests__/heartbeat-session-preparation.test.ts`.

Session compatibility uses effective workspace policy and settings. Generic issue
and project row timestamps do not reset a session. This includes the first
project-owned directory binding. Changes to effective execution configuration
still require a fresh session.

Run-log formatting is in `server/src/services/heartbeat/run-log.ts`. It bounds
stored event payloads, redacts and shortens log chunks, and caps stdout/stderr
excerpts. `run-output.ts` owns per-attempt log handles, current-user redaction,
output progress writes, live log delivery, and adapter event callbacks. The log
store remains service-scoped. Completion reads live excerpt getters so output
that arrives during finalization is retained. Existing public helpers and flush
interval constants remain available from `heartbeat.ts`.

Workspace preparation is in `server/src/services/heartbeat/workspaces.ts`. It
owns managed checkout materialization, workspace validation and reuse, referenced
project resolution, and session/workspace configuration freshness. Its
`createHeartbeatWorkspaceResolver(db)` factory binds the run workspace resolvers
to a service's database. The checkout single-flight map stays at module scope so
all service instances share in-flight materialization. Existing public helpers
and the workspace validation error class remain available from `heartbeat.ts`.
Keep workspace policy changes separate from scheduling and run execution changes.

Run preparation is in `server/src/services/heartbeat/run-preparation.ts`. It owns
issue and wake context, responsible-user resolution, routine environment snapshots,
skill mentions, adapter environment configuration, and MCP/tool access setup.
`createHeartbeatRunPreparation(db)` binds the context loaders to a service's database
without doing database work during construction. `heartbeat.ts` composes queue
dispatch with cancellation and execution, and re-exports the existing
public helpers and configuration-incomplete error class. Keep preparation policy
changes in this module and its tests.

Queued-comment display reads select only wake identity, queue state, typed comment
and interaction bindings, the displayed wait reason, and fresh-session flags.
They read only the queued run's runtime mode. Mutation locks retain complete
wake and run rows, so edits, ordering, interruption, and saved execution inputs
keep their existing write contract.

Wake-queue also handles automatic steering for a saved task comment when an
active session goal is working. It suppresses the assignee's comment wake after
the live runner acknowledges delivery. When the live command cannot deliver the
comment, the comment follows the route's normal wake rules.

The task composer offers Steer when the native session has an active provider
turn that accepts steering. Wake-queue locks the task and receipt for the click,
then locks and rereads the run after the provider acknowledges delivery. It
records the acknowledgement and removes the queued entry in one transaction.
If steering is unavailable or unsupported, the composer offers Interrupt.
Interrupt records the board user's intent,
requests cancellation, and delivers the saved queue through normal admission after
the previous execution stops. Preparation and cleanup can keep messages queued;
the action does not bypass Stop confirmation or execution gates.

Run retrieval and session state are in `server/src/services/heartbeat/run-state.ts`.
It owns bounded run projections, database encoding checks, task session reads and
writes, explicit resumes, session compaction, and usage/billing helpers.
`createHeartbeatRunState(db)` binds these operations without doing database work
during construction. The encoding-check cache belongs to each factory instance.
Queued-comment polling reads current issue control fields, the typed issue binding,
and the selected adapter type. Mutation and execution paths retain their full run reads.
Workspace-operation polling reads the current run access scope and typed workspace
binding, then applies the existing run and operation permission checks.
`heartbeat.ts` keeps run execution and re-exports the
existing public helpers. Keep session policy changes separate from run
orchestration changes.

Explicit continuation admission reads only task/comment identity and dispatch
evidence from the saved context. Its preflight reads the historical adapter type
and workspace sync receipt. The coordinator and run locks retain their order.
The locked reread retains the complete Runner profile because suspended-session
and quarantined-cleanup proofs parse the exact saved execution input. Other run
and dispatch paths retain their existing reads.

Measure these two admission queries with
`pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-continuation-run-reads.ts --baseline-ref=<pre-fix-commit>`.
The synthetic PostgreSQL fixture compares the admission result and reports exact
text-format DataRow frame bytes, SQL samples, and execution plans. It excludes
TLS and protocol metadata. To use an isolated external database, set
`PAPERCLIP_CONTINUATION_BENCHMARK_DATABASE_URL` to a disposable database ending
in `_test`. The harness applies migrations there and adds synthetic fixtures.

Continuation history reads select completed tool receipts and the typed
conversation/workspace recovery fields used to choose the prior terminal run.
Every completed receipt keeps its full result. Receipt order, company/agent/task
scope, and the complete retained history stay unchanged. Saved results remain
available to detail, recovery, and execution paths.
Use `pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-continuation-history.ts --baseline-ref=<pre-fix-commit>`
to compare generated SQL, complete continuation envelopes, and DataRow bytes.
The benchmark includes a large required-receipt control. Its external database
option is `PAPERCLIP_CONTINUATION_HISTORY_BENCHMARK_DATABASE_URL`, with the same
disposable `_test` database restriction.

Retry scheduling is in `server/src/services/heartbeat/retries.ts`. It owns bounded
retry schedules, connection and workspace contention deferrals, shared-workspace
holder checks, due retry promotion, and retry-now requests. `createHeartbeatRetries`
binds these operations to the service database and explicit lifecycle callbacks
without doing work during construction. `heartbeat.ts` supplies status writes,
run events, issue-lock release, plan-resume reporting, and worktree cutoffs. It
re-exports the existing retry helpers and workspace-busy error class. Keep retry
policy changes separate from this extraction.

Restart recovery and lease cleanup are in `server/src/services/heartbeat/recovery.ts`.
It owns hot-restart snapshots and adoption, native restart recovery, shutdown
draining, orphaned-run reaping, and active/pending-cleanup lease sweeps.
`createHeartbeatRecovery` binds the service database and explicit lifecycle
callbacks without starting work. The service supplies its shutdown flag callback
and shared execution sets so separate service instances keep the same ownership
and shutdown barriers. Cleanup single-flight state stays at module scope.
Keep recovery policy changes separate from retry scheduling and execution changes.

Heartbeat coordinates wakeup dispatch, queued-run claims, daily heartbeat caps,
concurrency and priority checks, timer admission, and native status wake intents
in `server/src/services/heartbeat/queue.ts`. The wake-queue module owns the
company and issue lock, the admission transaction, and the handoff after commit
for both fresh task runs and wakes arriving behind an active execution. Heartbeat
uses the locked transaction for its specialized eligibility gates and continuation
writes. Wake-queue selects eligible saved comment receipts in request order and
binds them to the new run. Chat authorization and its admission callback run in
the same transaction. Authorization contention defers the wake and rolls back
without publishing buffered effects.
`createHeartbeatQueue` binds these operations without querying or starting work.
The service supplies lifecycle effects, execution callbacks, worktree gates, and
its process-wide execution and wakeup promise sets. Forwarding callbacks preserve
construction order for retry and recovery services. Keep queue policy changes
separate from this extraction and from adapter execution changes.

Run lifecycle handling is in `server/src/services/heartbeat/run-lifecycle.ts`.
It owns status transitions, run events and progress, liveness classification,
completion handoffs, issue-comment finalization, and runtime/cost settlement.
`createHeartbeatLifecycle` binds the database and explicit reporting, recovery,
and wakeup callbacks without starting work. The service supplies terminal
reporting and forwarding callbacks preserve construction order for the other
heartbeat modules. Existing public helpers remain re-exported by `heartbeat.ts`.
Keep lifecycle policy changes separate from this extraction and adapter execution.

Run cancellation and cleanup are in `server/src/services/heartbeat/run-control.ts`.
It owns Stop, agent and budget cancellation, environment lease release, and
resumption of saved comments after execution stops. `createHeartbeatRunControl`
binds the database, lifecycle and admission callbacks, and shared executor
barriers without starting work. The service retains the process-wide execution
and cancellation maps so scheduler and route instances observe the same owners.
Forwarding callbacks preserve construction order for budget, retry, recovery,
and queue services. Existing public helpers remain re-exported by `heartbeat.ts`.
Keep cancellation policy changes separate from this extraction and execution.

An operator Stop during preparation can settle before any adapter starts. The
preparation owner records `executionCancellation.state = acknowledged` only after
it unwinds and the retained dispatch, process, session, event and lease evidence confirms
that provider work never started. A terminal run status alone is not this proof.
The locked run must have no `budgetDispatch.handedOffAt` marker. The dispatch gate
writes that marker before adapter entry, so a missing invocation event or an old
owner's local flag cannot prove that dispatch never occurred.
The task page shows a confirmed operator Stop as Stopped and accepts a new message
through normal admission. Stop does not automatically restart the task. Recovery
holds, approvals, budget limits and uncertain termination keep their own gates.
The receipt's `preparation_settled` proof identifies that evidence path. Both page
projections read the same bounded evidence and require that proof; an acknowledged
receipt from a different path does not clear the preparation failure notice.
Only a user's operator Stop gets this acknowledgement and clears an obsolete
automatic-recovery marker. A system cancellation keeps its existing recovery
delivery metadata, so saved comments and continuation intents still reach admission.

Scheduling is in `server/src/services/heartbeat/scheduling.ts`. It owns timer
ticks, issue-monitor claims and dispatch, exhausted-monitor recovery, and
session-goal recovery. `createHeartbeatScheduling` binds explicit dependencies
without querying or starting timers. Queue admission, heartbeat policy parsing,
and atomic timer claims stay in `queue.ts`; the service supplies those operations
and the current scheduling-suppression and worktree-cutoff callbacks. Monitor
claims remain database-scoped so separate scheduler instances cannot dispatch
the same claim. The public heartbeat methods keep their existing signatures.
Keep scheduling policy changes separate from this extraction and execution.

Run completion is in `server/src/services/heartbeat/run-completion.ts`.
`createHeartbeatRunCompletion` binds terminal result persistence, accounting,
response presentation, task-session updates, and execution/setup failure handling.
The executor calls these handlers from the original try/catch boundaries. It
retains native recovery exceptions, dispatch ownership, and the outer cleanup.
Completion reads the shared Stop barriers, uses live output getters, and reports
trace finalization immediately so a later error cannot lose cleanup state.
Existing public failure helpers remain re-exported by `heartbeat.ts`.
Keep completion policy changes separate from this extraction and dispatch.

Runtime selection is in `server/src/services/heartbeat/runtime-selection.ts`.
`selectHeartbeatRuntime` constructs or restores native execution inputs, selects
completion contracts and sessions, and persists native or legacy runtime choices.
Native selection retains the row lock that serializes it with cancellation and
controller lease renewal. The executor receives an explicit selection result;
lifecycle and ownership callbacks update its teardown state immediately, including
when preparation later throws. Public sandbox lifecycle and model fallback helpers
remain re-exported by `heartbeat.ts`.

Environment selection is in `server/src/services/heartbeat/environment-selection.ts`.
`selectHeartbeatEnvironment` resolves environment policy and workspace reuse,
including immutable native recovery bindings, managed sandbox enforcement, and
Kubernetes provisioning. It validates native chat isolation and checks shared
workspace contention before acquisition. It can defer a sandbox run or add a
concurrency note to the task context. The executor retains lease ownership,
dispatch gates, and terminal cleanup.

Workspace preparation is in `server/src/services/heartbeat/workspace-preparation.ts`.
`prepareHeartbeatWorkspace` resolves and provisions the workspace, persists its
metadata and issue binding, then acquires and realizes the execution environment.
It preserves the immutable workspace binding used by native recovery and records
preparation spans even when acquisition or realization fails. The executor retains
dispatch gates and terminal lease cleanup. Persistence
failures still clean newly created workspace artifacts before propagating.

Runtime execution is in `server/src/services/heartbeat/runtime-execution.ts`.
`executeHeartbeatRuntime` dispatches a prepared native session or legacy adapter,
captures usage, finalizes workspace operations, and releases gateway tokens and
instruction copies. The executor supplies the atomic dispatch gate and retains
admission, terminal run status, retry handling, and outer lease cleanup. An explicit
dispatch result preserves early cancellation returns; ownership callbacks update
teardown state before errors propagate. Instruction getters retain updates made
during provider execution. Keep policy changes separate from this extraction.

## Investigating polling load

Deferred-message recovery reads run admission fields before calling the release
policy. The release coordinator reads authentication evidence and then refreshes
completion identity after post-commit effects. These checks do not load stored
prompts, Runner profiles, or output excerpts. Full execution and detail reads
retain those fields. Queue cadence, delivery admission, and cleanup ownership
remain unchanged.

Runtime progress updates recheck the persisted run status before publication.
This check selects only the run ID, company ID, agent ID, and status through
`createHeartbeatRunState().getRunStatus`. It does not fetch prompts, runner
configuration, or provider results. Keep this read fresh so terminal or deleted
runs cannot publish late progress from an old executor snapshot.

Native event and retry-exhaustion ingestion lock the run row to verify its
company and agent bindings. That lock reads only those two fields. Sequence
allocation, replay checks, and event insertion remain in the same transaction.

Sandbox-provider driver lookup filters plugin manifests by driver key and kind
in Postgres before returning rows. Install order, status and worker checks still
select the provider. Each lookup reads current registry state without a cache.

Run-to-issue links authorize through `getRunReadAccess`, which reads only the run
ID, company ID, scope kind, and issue ID. The existing visibility policy then
filters linked issues without loading the run's prompt, output, or result.

Run the deterministic native event replay with the normal server test runner:

```sh
pnpm --filter @paperclipai/server exec vitest run src/__tests__/native-observer-replay.test.ts
```

The test uses disposable PostgreSQL and the production event persistence and
authenticated WebSocket paths. Its `OBSERVER_REPLAY` JSON line follows the
existing benchmark stdout convention. Each case records the measured interval,
active viewers and subscribers, polling cadence and actual read offsets, timing,
query counts, and event/log/delivery/duplicate-replay assertions. Push-only cases
mark polling as not applicable. Subscriber counts include one diagnostic listener
that checks duplicate publication synchronously and does no database work.
The polling fixture reads the production replay
port; it does not model the full browser query graph. Query counts include
Drizzle statement attempts on the measured connections, including authorization,
duplicate replay, and separately counted delivery-time visibility proof reads.
Seed, handshake, post-interval proof reads, and driver SQL are outside that count.

`interval.workMs` stops after event ingestion, delivery, duplicate replay, and
visibility proofs. Performance comparisons use this elapsed time. The separate
`interval.wallMs` includes the minimum observation window and polling drain, so
that deliberate wait cannot hide work-time differences. Polling cases wait for
two completed read batches with a bounded deadline before stopping observation.
The `slow-first-poll` regression delays its first batch until 100 ms after work
completion and still requires two completed real reads per viewer. That injected
delay is explicit in the polling evidence and comparison matching rules.

Every viewer-sensitive case names its zero-viewer control. The report shows a
matched push pair, unmatched viewer-count and polling pairs, and explicit
observation-load experiments. Unmatched pairs have no timing ratio. A different
fixture or observer churn stays unmatched even in an observation experiment.
These local diagnostics do not establish hosted latency or provider performance.
The output is test evidence; there is no product API or dashboard consumer to
migrate. Keep future fields additive and check the schema and comparison status
before interpreting timings.

The company heartbeat-run and live-run lists load secret registries in one
company-scoped query per response. Registry reads project only
`paperclipSecretRedactions` from the run context. They do not load the full
prompt/context JSON. Decrypted values live only for that request and each run
uses its own registry.

Hidden browser tabs suspend the company live-events connection and transcript
log reads. Returning to a visible tab refreshes active queries once and resumes
transcript reads from their retained offsets. A queued live-event invalidation
that flushes after the tab hides marks data stale without starting a refetch.

Live-event delivery and workspace-operation run checks select only the stored
company, run scope, and task binding. Event-list access also selects the run ID.
These checks do not load run context, runner configuration, results, or output.
Every delivery and request still checks current permissions. Grant revocation,
deleted tasks, missing runs, and cross-company run IDs remain fail-closed.
The developer-server health poll also stops in hidden tabs.

Workspace detail responses return stored metadata and runtime service information
without inspecting Git, resolving delivery PRs, or reconciling remote storage.
This also keeps operation-history reads, login handoffs, runtime controls and
metadata updates from inspecting storage through their common workspace lookup.
Delivery state stays `unknown` on these reads. Explicit close-readiness and final
cleanup validation still inspect current Git state; neither uses a display result
to authorize removal.

The terminal-workspace reaper uses the database work coordinator. Startup scans
recover existing workspace rows in bounded pages. The first readiness sweep
defers the new remote delivery-proof checks while preserving candidate deadlines;
later scheduled work performs them. GitHub latency does not block readiness
through this path. Issue status and tree changes,
workspace lifecycle writes, finalization receipts, and pull-request work-product writes signal work on
their transaction before writing. The coordinator wakes after the outer
transaction settles and holds idle admission while writes or cleanup are active.
Empty and nonterminal-only lanes have no recurring timer or query. Terminal trees
schedule their actual cooldown deadline; unresolved delivery or cleanup eligibility
is checked again after five minutes. Providers that explicitly declare
`supportsMergeAncestry: false` use the latest successful finalization receipt as a
candidate HEAD. Core checks GitHub before inspecting storage: the exact HEAD must
be an ancestor of the intended destination tip, or an associated merged PR must
have that exact final HEAD and destination, with its integration commit still
reachable from the destination. Recorded PR work products are optional lookup
hints. This supports squash merges without equating the squash commit with the
original workspace commit.

Preparation captures the resolved destination branch when the provider supports
it. Cleanup never silently adopts a changed project source or today's default
branch for an ambiguous old workspace. Missing receipts or destinations park the
workspace; finalization, workspace, issue, provider and work-product changes and
startup reconsider it. A known commit awaiting delivery, or an unavailable remote
lookup, keeps a five-minute remote-only retry. GitHub merges have no guaranteed
local ingress for this lane, so this concrete unresolved delivery obligation can
keep the worker scheduled until delivery is proved. There is no new polling loop.
Background GitHub delivery checks use the source project's explicit GitHub
authorization, with the same consent checks as provider inspection and removal.
The stored source must still match the workspace repository. Each proof, including
the final removal check, revalidates the selected grant, project access and trust.
Public sources use anonymous access; missing or revoked private-source consent
retains storage without falling back to another identity. No task identity is borrowed.

Only positive delivery evidence triggers a fresh storage inspection. The actual
HEAD and branch must match the receipt. Cleanup revalidates delivery after its
last inspection before recording removal intent. A provider can opt into
`recoveryPullRequestVersion: 1` to receive one specific PR number and original
HEAD for recovery checks. A merged PR alone does not prove that the original
commit remains recoverable after source-branch deletion. The provider must
independently prove recovery of that exact commit and reject any local data.
Missing capability declarations preserve existing provider protocols.
Nonterminal trees, cooldowns, and active runs are checked before Git. The worker
shares readiness across compatible rows within a bounded page. Each row retains
its own task and delivery assessment. Scoped task/workspace hints invalidate
backoff; changed tree or workspace revisions invalidate it too. Deadline selection
reuses task trees read by those pages without a separate full-inventory query.
Commits during a paged rotation request another bounded rotation so changes behind
its cursor are recovered.
The backoff retains at most 256 candidates and only applies to the background
worker. Final cleanup still checks the current task tree,
delivery evidence, ownership, lifecycle generation, and Git state under the
existing cleanup locks.

These wakes cover the owning `createDb` scope in this server process. Direct SQL
and other server processes require startup recovery. Local deadlines do not
establish external wake-alarm coverage or whole-instance sleep safety. The local
sleep inventory blocks host suspension until bounded recovery succeeds. Cooldown
eligibility is an earliest allowed cleanup time; passive retained directories can
wait for the next wake, when startup restores their rows. Existing idle-sleep
blockers and cleanup admission holds remain authoritative.

The connection-health sweep selects only due IDs in SQL before applying its
limit. Legacy `paperclip_plugin` placeholder connections are excluded: their
tools run in plugin workers and do not have remote MCP endpoints. These rows
remain available; the sweep does not disable or delete plugin connections.

When investigating an overloaded instance, distinguish request amplification
from stored configuration problems. Verify connection transport and endpoint
fields before disabling a connection. Verify workspace ownership, active runs,
Git state, and runtime-service readiness before closing a workspace. A missing
URL or old workspace timestamp alone does not prove that a row is disposable.

## Budget accounting performance

Budget admission and settlement share the company accounting lock. They evaluate
only the company, responsible agent, and applicable project. Running usage is an
internal exposure projection, not a provisional ledger charge. Cancellation and
lifecycle effects run through the delivery coordinator after accounting commits.

The final provider gate commits a dispatch claim before entering provider code.
The reservation and native recovery lease generation fence duplicate handoffs;
neither provider startup nor termination holds the company accounting lock.
After accounting commits, a short ownership transaction rechecks the current
task/run fences and covers the synchronous adapter handoff. It commits without
awaiting provider bootstrap, results, or finalization.
Hosted browser operations retain their own hold and admitted project in existing
run metadata. Unknown provider outcomes retain that capacity until accounting
establishes the charge. Browser holds are separate from their parent run's usage.
Unfinished uncapped browsers and legacy rows without a reliable exposure record
remain unknown usage when a new budget is introduced. The existing unpriced-usage
policy controls admission until their terminal charge is known.

Use a disposable real PostgreSQL database to compare cost evaluation and complete admission:

```sh
pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-budget-enforcement.ts --baseline-ref=6c9b87d0922f1ebfc43e8b0c36889ac5ba7b9837 > /tmp/budget-forward.json
pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-budget-enforcement.ts --baseline-ref=6c9b87d0922f1ebfc43e8b0c36889ac5ba7b9837 --reverse > /tmp/budget-reverse.json
```

The cost comparison keeps one company policy and no active runs while adding 0,
17, and 1,000 unrelated idle agents. It records 20 warm samples, SQL statement counts,
company accounting locks, agent reads, and an `EXPLAIN (ANALYZE, BUFFERS)` plan.
It asserts unchanged agent state and no agent reads in the new evaluation path.
The harness also measures reservation, the final ownership gate, and an immediate
offline provider result with one responsible agent and one active operation. It
records transaction counts and asserts no reads of unrelated agents. Baseline
service, lifecycle, reservation, and dispatch modules come from the supplied Git
revision.
Provider inference, network latency, stop acknowledgement, and hosted database
latency need separate measurements. Do not run this benchmark beside test suites
or builds when reporting timing results.

## Public MCP and Dot event delivery

Public MCP task events and Dot mailbox events use separate topics in the shared
transaction-aware delivery coordinator. They no longer scan SQL every two seconds.
An enabled subscription without new events or unfinished deliveries is quiet,
including when delivery history remains in the database.

| Obligation | Source and wake path |
| --- | --- |
| Task status, comments, documents, prototype work | Existing activity rows; issue activity writes in `persistActivity`, the activity service, and wake recovery notify before their transaction commits |
| Dot task follow-up discovery | Existing comments and assignments; `insertIssueComment` centralizes committed comment notifications, and assignment acceptance wakes the scanner |
| Dot mailbox delivery | Existing mailbox rows; native broker events, explicit challenges, fencing, follow-up publication/consumption, and subscription reconnection notify through their owning transactions |
| Subscription creation, renewal, removal | The subscription transaction wakes its worker; renewal can recover unreceived Dot assignment references |
| Feature disable/reenable | The experimental settings transaction wakes both workers; disabled workers remain quiet until another change |
| Delivery retries and abandoned claims | Existing `mcp_event_deliveries.next_attempt_at` drives the next deadline, reconstructed on startup |
| Admission and old subscription cleanup | Opportunistic on startup and subsequent enabled sweeps; expiry remains enforced on use |

The scanner preserves durable delivery receipts instead of advancing a timestamp
cursor that could skip a late commit. Subscription scans use pages of 20; full source/delivery batches schedule another
sweep until caught up. Subscription creation, refresh, and removal target their
subscription ID (or the shared Dot binding for reconnect mailbox entries). Issue
activity targets its task; comment discovery targets its company; mailbox and
assignment changes target their Dot binding. Delivery retries do not rescan
unchanged subscriptions. Only startup and instance-wide settings changes request
a full scan. Settings changes retain an explicit wildcard when a transaction also
contains scoped hints. A fresh request or failed sweep survives warm standby and
idle drain; skipped dispatch never marks it complete. Shutdown stops admission of
new batches and waits for the current bounded webhook attempt to settle.

Automatic Dot readiness challenges are issued once for a connected subscription.
A pending or expired challenge does not imply periodic renewal; an explicit retest
creates and signals another challenge. The worker keeps the existing challenge and
authorization checks. No schema, OAuth, or webhook contract changes are required.

Notifications require supported writers in the same live server/database scope.
Independent SQL writers and separate live server replicas do not wake this process;
startup reconstructs their durable records, but continuous multi-writer discovery
would require an ingress or notification contract before removing its backstop.
The host sleep-safety checks remain conservative for MCP/Dot state. These retry
deadlines are not yet exported to Paperclip Cloud's scheduled-wake contract.

`events-work.test.ts` exercises real PostgreSQL commits, rollback, startup/drain,
retry restoration, producer reactivation, large batches, and SQL/network quiet.
When embedded PostgreSQL is unavailable, use separate disposable databases ending
in `_test` for `PAPERCLIP_MCP_SLEEP_TEST_DATABASE_URL`,
`PAPERCLIP_PUBLIC_MCP_TEST_DATABASE_URL`, and
`PAPERCLIP_DOT_RUNNER_TEST_DATABASE_URL`. The interaction-service regression suite
also accepts `PAPERCLIP_INTERACTIONS_TEST_DATABASE_URL`. The suites migrate and write to those
URLs; the sleep suite truncates company data between tests.
