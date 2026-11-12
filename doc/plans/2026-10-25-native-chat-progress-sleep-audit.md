# Native chat progress: sleep migration audit

Parent: #17606 at `ed76256b979541b962fa784016a550c32920d670`.
Branch: `codex/sleep-29-native-chat-progress`. PR: #17639.
Status: implementation, focused PostgreSQL acceptance, and browser acceptance
complete; exact-head remote checks and review pending. This is not a deployed sleep claim.

## Duty and owner

Native progress used the one-second chat reconciliation cadence. It projects a
closed allowlist of durable run event types into coarse provider-safe phrases.
It never copies event messages, payloads, tool names, arguments, or results into
external publications.

`chat-native-progress.ts` owns selection, authorization and insertion.
`safe-native-chat-progress.ts` owns the normalized allowlist and phrase policy.
`chat-run-publication-policy.ts` holds the existing projection window and shared
automatic-publication eligibility. It preserves upgraded GitHub bots' tool-owned
replies and legacy automatic replies. The original export and explicit combined
lifecycle/progress API stay compatible, including their shared insertion budget.
Startup registers the worker; it no longer invokes progress on the chat timer.
Other chat maintenance duties remain for their own migration slices.

## Durable contract and triggers

The candidate requires a native running run, matching company/agent and bound
issue, an active/waiting conversation, and an automatic endpoint assigned to the
agent. Its existing base working publication must be pending, retry, streaming,
or published. The latest allowlisted event must be within the existing 24-hour
window and at least 20 seconds after the base publication. Existing lineage,
interaction arbitration, final-output suppression and delivery authorization stay
with their current owners. The ordinary direct-origin path and stricter
post-close lineage path retain their existing different authorization stages.

There is at most one publication per phase. Spacing compares saved event time
with saved publication times. Waiting twenty seconds does not make an old event
eligible. No timer retries cadence-suppressed events. Existing events and
publications are durable truth; there is no new queue table or schema migration.

The two event writers register awaited intent before insertion, after duplicate
and ownership checks, inside their existing transaction boundaries:

- `appendHeartbeatRunEvent` covers native ingress through
  `PaperclipControlPlanePort`, direct allowlisted events and recovered trace diffs.
  It reads only runtime mode and bound issue alongside the existing binding
  fields. Ordinary non-progress direct log events retain their atomic-statement
  path. Direct allowlisted event writes now use a transaction even for legacy
  runs; only native bound runs signal progress.
- `NativeRunCoordinatorStore.appendEvent` has its own insertion path. It signals
  after binding, sequence and duplicate validation, before persistence.
- `persistReprojectedWorkspaceDiffs` delegates to the first writer and is tested
  through its actual recovered-trace persistence API, including duplicate replay.

Eligibility mutations share slice 28's issue/company notification boundary.
`notifyChatRunMilestones` now invalidates both lifecycle and native progress,
without adding recovery wrappers to every caller. Both topics share the outer
transaction's identity and commit/rollback outcome. Existing writers cover
lineage receipts, run state, interactions, endpoint/resource configuration,
identity and membership. Failed-publication replay and operator retry now supply
the affected issue to `notifyChatPublicationWork`: they can restore an existing
base working publication without any new run event. The lifecycle projector also signals native progress before creating a first
working publication. A long transaction can give that publication an older
transaction-start timestamp but commit after an event was already inspected.
Routine transport claim bookkeeping retains its narrower notification behavior.

## Scheduling, contention and lifetime

`chat-native-progress-work.ts` uses `registerScopedDeadlineWork` and the shared
delivery coordinator. It reconstructs relevant issue scopes on startup, refreshes
only the affected issue/company after a committed change, and projects batches
of 100. A full insertion batch retains immediate work. Lock contention retains a
one-second retry; failure uses the shared backoff. A settled short pass disarms.
The shared worker preserves changes during execution, paused work during drain,
startup failures through resume, fair company dispatch and shutdown ownership.

Projection retains issue-before-run SKIP LOCKED ordering. A skipped lock is a
concrete obligation only while the matching row still exists and the run is
native/running. Deleted or terminal candidates settle. Authority, latest event,
phase deduplication and final output are checked again inside projection.

The selector also repairs an existing pagination bug: JavaScript Date truncated
PostgreSQL microseconds, repeatedly selecting a full rejected page. Cursors now
retain PostgreSQL timestamp text and the full timestamp/run/conversation tuple.
The regression seeds 30 origin-rejected candidates at one fractional timestamp
and an eligible later event. A query-count guard bounds failure of the old code.

## Evidence and failures retained

- `/tmp/sleep29-progress-cursor-before.log`: causal pagination failure.
- `/tmp/sleep29-progress-cursor-acceptance.log`: 17 selected cases after repair.
- `/tmp/sleep29-progress-owner-acceptance.log`: 21 projection cases after extraction.
- `/tmp/sleep29-native-producers-before.log`: real event-writer cases fail before
  notification hooks; startup and lock cases already pass.
- `/tmp/sleep29-native-producers-fixed.log`: all five original producer cases pass.
- `/tmp/sleep29-native-lifecycle.log`: 14 worker lifecycle cases pass.
- `/tmp/sleep29-progress-recovery.log`: trace recovery and 105-run backlog pass.
  Its attempted publication-mode test was invalid: endpoint update does not
  accept that field. No production API was expanded to satisfy the test.
- `/tmp/sleep29-progress-eligibility.log`: the first identity test incorrectly
  assumed ordinary direct-origin projection enforced post-close authority.
  The replacement uses the real closed/reopened conversation and admission
  receipts, where the existing projection contract requires current authority.
- `/tmp/sleep29-progress-eligibility-fixed.log`: five real-service cases pass:
  post-close identity, resource and visibility restoration, plus failed publication
  replay and operator retry. No new event or manual projection call is used.
- `/tmp/sleep29-progress-worker-acceptance.log`: 13 app coordinator tests pass;
  the concurrent-event test's quiet assertion initially counted old calls from
  an already-installed transaction spy. Restoring that barrier spy before taking
  the quiet baseline corrects the test accounting, without a production change.
- `/tmp/sleep29-final-native-acceptance.log`: 44 selected tests pass across the
  18 worker cases and 26 existing/new integration cases. These cover both real
  event owners, nested outer commit/rollback, duplicate replay, irrelevant logs,
  issue/run lock contention and terminalization, startup reconstruction, drain,
  failed startup through resume, shutdown, trace recovery, issue/company scope,
  concurrent commits, full batches, cadence, final suppression and provider-safe
  content. The name filter skips the app file; its 13 cases passed separately.
- `/tmp/sleep29-wired-typecheck.log`: production server typecheck passes.
- `/tmp/sleep29-server-build.log`: server build passes (production TypeScript;
  test files are executed by Vitest, not included in the server typecheck).
- `/tmp/sleep29-first-base-before.log`: causal missing-wake failure when a
  first working publication commits after event selection. The test backdates
  the base inside its transaction to model transaction-start timestamp ordering.
- `/tmp/sleep29-base-fixed-workers.log`: all 19 worker and 13 app coordinator
  cases pass after the lifecycle producer signals native progress.
- Browser acceptance: all 16 `agent-chat-projects.spec.ts` cases pass, log
  `/tmp/sleep29-app-e2e.log`, fresh isolated database, port 32659. This run
  precedes the final base-publication hook. `/tmp/sleep29-final-e2e.log` then
  passes all 16 cases at committed implementation `bcf2f38ff5` with a second
  fresh isolated database. `/tmp/sleep29-final-typecheck.log` also passes with
  the final hook. No retries were needed in either browser run.

PostgreSQL is external and isolated because embedded PostgreSQL is unavailable
on this host. Worker fixtures clean their own companies. The reused chat fixture
DB retains history; tests stop workers and retire endpoints after assertions.
Configured-idle and retained-history quiet assertions observe select/transaction
calls, including two minutes of controlled time in worker tests. Provider APIs
are controlled fixtures, not live Slack/Telegram/Discord accounts.

## Limits and remaining acceptance

Process-local notifications retain the single active writer model. Independent
SQL writers and other processes need a wake integration. No Cloud sleep gate or
external alarm coverage changes here. An internal deadline cannot wake stopped
compute. Exact-head CI and review remain required before this slice is ready. The whole stack remains unmerged.

Fetched master is `19ec787e5b` (not replayed into this stack yet). Newly landed
#17616 expands native-harness backup expiration to continuity/quarantine evidence
and adds its evidence signal. Its interval remains. Preserve that newer contract
when migrating its separate retention owner.

## CI repair: narrow notification payload (2026-10-25)

CI at `34df8b0d01` failed native status/finalization consumers across server,
chat, Runner, and serialized suites. Local reproduction of the existing
same-run Slack response-recovery test failed before the repair. Its persisted
`native_run_finalizations.failure_detail.message` identified circular JSON
serialization of a Drizzle table through the caller's database handle.

The new native-progress notifier serialized the entire structurally compatible
scope argument. Existing lifecycle callers legitimately pass wider domain inputs
(including `db`) through that typed boundary. Serialize only `companyId` and
`issueId`, as the lifecycle notifier already does; do not constrain every caller
or serialize domain/private fields into work hints.

After repair, 15 existing chat finalization/response-recovery/authority cases
passed against external PostgreSQL, all 32 native-progress worker/startup cases
passed, and server typecheck passed. The attempted broader native-finalization
and session-resumption selection failed during local embedded PostgreSQL
initialization (bootstrap exit 1), before tests could run; it is not acceptance
evidence. Fresh CI must verify those native consumers. Before/after logs:
`/tmp/sleep29-finalization-repro.log`, `/tmp/sleep29-finalization-fixed.log`,
`/tmp/sleep29-notification-fix-workers.log`,
`/tmp/sleep29-notification-fix-typecheck.log`, and
`/tmp/sleep29-native-finalization-acceptance.log`.

## CI repair: keep non-progress event admission narrow (2026-10-25)

CI at `3447973f6f` clears the prior finalization failures. Its sole failing test
file is `heartbeat-run-event-atomic-append.test.ts`: native lifecycle and retry
exhaustion events unnecessarily select runtime mode and the task-binding SQL,
which can read a large context snapshot. Those events do not project progress.
The lock query now selects the extra binding only for allowlisted progress
kinds. Keep the existing strict SQL/payload regression assertions unchanged.

The atomic-event suite now supports the repository's guarded external test DB
convention, allowing its actual PostgreSQL SQL assertions to run locally despite
embedded bootstrap failure. The original implementation reproduces both CI
failures in `/tmp/sleep29-atomic-events-before.log`. That first external run also
exposed fixture cleanup ordering; cleanup now removes event/run/agent rows before
companies and always closes its pools. The repaired atomic-event and progress
worker suites pass all 25 cases in `/tmp/sleep29-atomic-progress-fixed.log`;
server typecheck passes in `/tmp/sleep29-atomic-progress-typecheck.log`.

Greptile reviewed `3447973f6f` at 5/5 with no threads. A new full CI/review pass
is required for this second repair; do not carry forward readiness from its
parent head.


## Current milestone-parent acceptance (October 28)

The existing native-progress slice is prepared with a normal merge of the verified
local milestone parent `eef52b9dd759417bd7a2fea835357fbfeb460111`. Its previous
published head is `08d07ead105dc89c2af9b62f4d90bff8cc93540c`, with original own
base `7991c2fa2ce7298bee69b25dbc6cb60a5e2fe250`. All unrelated parent changes,
including the current migration 0397 and authority, voice, and identity repairs,
remain present. The only explicit-base conflict was publication resolution: keep
this slice's issue-scoped retry notification and the parent's exact voice
conversation scope. No new duty, table, dependency, or scheduler is introduced.

Fresh separate PostgreSQL fixtures pass **163 distinct selected cases**:
**137 across eight complete suites** (native progress, atomic event append,
all five milestone worker suites, and app admission wiring), plus **26 real chat
integration cases** selected by `native progress`. These include replay/operator
retry, microsecond pagination, lock contention, current authority, cadence, phase
coalescing, final/question precedence, and redaction. The other **1,595 chat cases
were skipped**, not passed. Server production typechecking, build, and module
boundaries also pass; test files were executed rather than statically checked.

Commands, separate fixture names, output, and zero exit-status receipts are in
`/tmp/sleep29-current-parent-acceptance-command.json` and
`/tmp/sleep29-current-parent-{acceptance,producers,types,build,boundaries}.log`.
Earlier verification and failures above keep their stated revision scope. This
is local preparation only: final landed-parent reconciliation, all fresh exact-
head remote gates, and Greptile 5/5 remain required before merge. This does not
qualify a live provider, external alarm, whole-instance suspension, or savings.
