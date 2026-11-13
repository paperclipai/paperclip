# Scheduled retry cancellation sleep audit

Slice 39, based on `d8e1bd97f530fc7a5119549a35b871b7b3d9f737` from
[#17666](https://github.com/paperclipai/paperclip/pull/17666).
Inspected remote master: `5a28f7acf8a8c86536c4f5c5369bfeb49a46c41a`.
This slice owns only interrupted cancellation of parked scheduled retries.
The other orphan-run recovery duties remain separate work.

## Obligation and owner

A scheduled retry has no active executor to finish a Stop request if the final
status write fails after the cancellation fence commits. The old orphan reaper
queried for these rows on every heartbeat. It inspected only the first 20 rows,
so malformed intents could also hide valid work behind that prefix.

The source of truth remains `heartbeat_runs`: status `scheduled_retry`, an object
at `result_json.startupCancellation`, and a cancellation accepted by the existing
`readRunCancellation` parser with `expected: true`. No table is added. A correlated
Stop reservation without valid cancellation evidence is not an instruction to
cancel. The worker neither launches a provider nor replaces run-control policy.

`heartbeat/scheduled-retry-cancellation.ts` owns candidate discovery and delegates
to the existing cancellation owner. Cancellation keeps its expected-status guard,
issue/wakeup settlement, budget markers, and original result metadata. Inventory
queries select only cancellation evidence. A selected candidate is read with its
full result before delegation. Every candidate is reread before execution.

Startup and explicit manual reaping retain the compatibility sweep. The periodic
reaper skips this duty after its dedicated worker is registered. Registration
retains the heartbeat scheduler toggle, warm-standby and idle-drain behavior.

## Producers and invalidation

| Owner | Relevant write and signal |
| --- | --- |
| Run control | Ordinary cancellation fence, guarded handoff fence, and budget cancellation fanout signal before their writes. The ordinary fence gains a short transaction; no provider call is enclosed. Existing budget transaction ownership is reused. |
| Native cancellation request | Correlated Stop reservation signals its exact run. The worker still requires valid expected cancellation evidence. |
| Run lifecycle | Transitions from or to scheduled retry signal the exact run in the existing transaction. |
| Queue cancellation | Direct stale scheduled-retry cancellation signals its exact run. |
| Dispatch adapter | Promotion, gate suppression, and queued-to-scheduled cleanup deferral signal the exact run. Deferral can preserve an already-written cancellation intent. |
| Instance settings | Worktree execution enablement changes signal reconstruction. The worker reads this policy fresh; ordinary callers retain the existing cache. |
| Agent/company deletion | Company-scoped invalidation precedes deletion of run records. |

New retry insertion paths in heartbeat retries, recovery service, native provider
capacity retry, and native safe replacement do not copy cancellation intents.
They create no work for this owner until a supported cancellation producer writes
its fence. Retained completed history and ordinary pending retries are quiet.

The supported writer model is the existing single process using the instrumented
DB client. Independent SQL writers and other replicas do not produce these local
signals. This PR does not add cross-process ingress or claim those writers are
covered. Startup reconstruction recovers saved work after restart.

## Shared scheduling and lifecycle

The existing transaction signal boundary tracks intent before writes, including
outer commit/rollback and ambiguous outcome reconciliation. Signals are hints,
not a replacement for durable rows. No caller-managed counters are added.

The shared scoped worker reconstructs candidates in keyset pages of 100 and
processes company-fair batches of 20. It retries concrete failures after 30 seconds,
with exponential backoff capped at five minutes. Settled work removes its deadline.
Malformed evidence is not actionable, and pagination continues past it.

A small shared-helper change handles a per-owner admission gate that is closed
while the coordinator is otherwise running. Pending scopes and deadlines remain
in memory and get a 30-second admission recheck, without SQL. This avoids a tight
loop over an already-due deadline. Existing GitHub helper consumers were tested.
With no pending entries or dirty scopes there is no admission timer either.

Worktree suppression returns no executable work. Its settings writer reactivates
the worker on enablement. Fresh reads propagate failures into recovery instead of
silently treating an unavailable setting as permanent disablement. Task drain uses
the synchronous admission gate so a temporary pause cannot discard durable work.
Shutdown joins active reads and does not start a cancellation after admission closes.

## Migration

`0406_zippy_war_machine.sql` creates a partial ID index for scheduled retries with an
object cancellation fence. It uses concurrent, idempotent creation and is listed
in the client's top-level migration set. It changes no rows or API contracts.
The migration was generated through `pnpm db:generate`. Journal entries and SQL
history remain intact; snapshots 0402 through 0406 are the retained newest five.
The initial unlanded draft used `0398_breezy_mongu.sql`; the later integration
sections retain its history and explain append-only regeneration.
Migration application, explicit replay, and migration validation passed.

A rolled-back synthetic fixture with 10,000 completed rows and one candidate
used the new index: one row, two shared buffer hits, 0.013 ms execution. This is
local query-plan evidence, not a production performance or fleet savings claim.

## Verification and failure record

Local PostgreSQL 17 databases are dedicated test databases. The route, run-control,
dispatch, and recovery suites accept guarded external test URLs; embedded fallback
is unchanged. Never point these destructive fixture suites at a shared service DB.

- Retry route suite: 30 passed, including 16 worker lifecycle cases. Covers quiet
  history, real Stop with failed terminal write, lost response after commit,
  dispatch cleanup deferral, metadata preservation, outer rollback/commit,
  restart, drain/standby, actual task-drain release and expiry, worktree enablement,
  concurrent intent, foreground race, shutdown, and fair paginated draining.
- Recovery module suite: all 34 passed on a fresh database.
- Existing shared-helper GitHub consumers: 20 passed.
- Workspace typecheck/build passed before the final test-only additions. Server
  typecheck passed again with the final tests. Migration validation/replay passed.
- Initial owner acceptance was 138 passed and 26 skipped, not 164 passes. External
  recovery support enabled those 26. Its first run had 33 passes and one fixture
  failure: a second client still referenced the embedded connection. Updating it
  to use the same external URL produced 34 passes.
- Initial worker selection had eight passes and one incorrect standby assertion.
  Standby correctly retained the unresolved transaction hold. The corrected test
  proves no passive SQL and eventual recovery without asserting away that hold.
- Removing run-control notifications made the committed-fence lost-response test
  fail: the retry remained scheduled. Restoring the producer signal fixes it.
- A metadata regression test failed when recovery omitted the old full result
  argument. Passing the candidate's full saved result preserves budget/operator
  metadata and fixes the regression.
- A subsequent combined owner run had 95 passes and 69 failures in dispatch
  fixture cleanup. Its shared database contained browser sessions from run-control;
  the foreign key blocked issue deletion. Dispatch now has its own database for
  acceptance. This was test-command isolation, not a production source repair.
  The corrected combined acceptance result is recorded below when complete.

## Limits and remaining work

This proves the changed worker can become quiet and reactivate. It does not prove
host or database suspension, extend the Cloud alarm contract, or relax idle-safety
blockers. The scheduler cannot wake stopped compute by itself. Other run reaper
queries, scheduled retry dispatch, task recovery, and the original inventory remain
unfinished. At initial authoring, this slice and its parent stack were not authorized for merge. The later stack campaign authorizes an ordinary protected merge only after exact-current-head Greptile 5/5, clean CI, and resolution of required review findings.

Final combined owner acceptance passed all 164 tests in five suites, with no
skips, in 41.14 seconds using separate dispatch and recovery databases. Together
with the 30 retry-route tests this covers 194 tests. Remote PR gates remain pending.


## Startup CI fixture repair

Initial head bd490ee50b failed server shard 4/12: eleven tests in the startup
suite used a heartbeat test double without the new registration method. The
real worker and owner acceptance passed, but startup wiring coverage was missing
from the local selection. The double now exposes the method, and new assertions
verify scheduler enablement and periodic-reaper exclusion. All 48 startup tests
pass in 5.34 seconds. This is a test-only repair; fresh head CI/review is required.

## Master integration and Stop attribution follow-up (2026-10-27)

Integrated master `8548173fc9efdc0fa07644fb92dcc0b6851a95e5`. A real PostgreSQL
regression held the foreground Stop after each cancellation fence and allowed an
independent scheduled-retry recovery owner to win terminal settlement. All three
user/board cases reproduced missing operator attribution. Both existing fence
transactions now persist `cancelledByActorType` and `cancelledByUserId`, so the
recovery winner retains the fields used to suppress automatic restart. No new
queue, table, or timer is introduced. Arbitrary result metadata is not copied
into the fence.

All 49 run-control tests pass, including those three races. The integrated
recovery, dispatch, and scheduled-retry route suites pass on fresh disposable
PostgreSQL databases; their external-database fixtures apply migrations before
opening the test client. Production server typechecking passes after resolving
the overlapping upstream recovery fixture imports and connection variable.
The first targeted test command used an invalid project filter and ran no tests;
the corrected command established the failing baseline before the fix. These are
local behavior checks, not a full-repository or deployed-sleep claim.


## Current stack acceptance (2026-10-28)

The current source acceptance ran at `e3a2472fe375f53158fd591d0eaf96ae8130474b`.
All ten complete test files passed: **362 cases, no skips**, in 72.12 seconds.
Counts are taken from the verbose passing case records, not from a name filter:

| Complete file | Passing cases |
| --- | ---: |
| Scheduled-retry HTTP routes and worker | 30 |
| Heartbeat recovery | 45 |
| Heartbeat run control | 51 |
| PostgreSQL dispatch adapter | 69 |
| Heartbeat queue | 32 |
| Heartbeat run lifecycle | 31 |
| Native cancellation parser and admission | 32 |
| Native cancellation integration | 16 |
| Cancellation provenance | 5 |
| Server startup and feedback export | 51 |

Routes, recovery, run control, dispatch, and queue each used a different fresh
disposable PostgreSQL database. They were migrated before starting the tests.
Lifecycle and native integration retained their real embedded PostgreSQL fixtures.
The earlier dispatch foreign-key cleanup failure remains recorded above; sharing
that database with run-control fixtures was not repeated. No tests were disabled
and no production behavior was changed to accommodate the fixtures.

Database build, server typecheck, server build, module boundaries, migration order,
and all five fresh database migrations passed. The only draft migration owned
by this slice was regenerated as `0404_cynical_phil_sheldon.sql` after the verified
parent history. Its original partial-index definition is unchanged. It uses
concurrent, idempotent creation through the existing top-level migration path.
All prior SQL and journal entries, and all retained parent snapshots, are preserved;
the five newest snapshots are 0400 through 0404. No new table is added.

A populated parent database upgraded from 0403 to 0404. All 402 existing migration
receipts remained identical; exactly one receipt was appended. Replaying appended
none. The scheduled-retry cancellation index is valid and ready on both that
upgraded database and a freshly migrated database.

The latest normal parent integration is
`a1ae3be691e00cae4556c16f84a271ea6425864c`, carrying #17666 at
`836acef0370d42323fdfdbd6d62a805b2469f1d4`. The complete server, package, and UI
source trees and every owned source hash still match the tested revision. The
complete owned binary patch is identical against the corresponding parent tree.
The only carried changes are parent audits and unrelated onboarding smoke tests
and their feature map, with exact upstream bytes preserved. The parent startup
inspection correction is superseded by #17666's removal of that coordinator;
this slice does not restore the obsolete inspection.

These results establish this worker's behavior and integration, not deployed host
or database suspension. Final publication still needs the actual landed parent
ancestry, then fresh current-head review and CI. Existing reviews on earlier heads
do not count for the eventual merge.


## Landed stale-review parent ancestry

Parent #17664 landed as `8bc051245f77a47bee0f8ba45896b8bfa5922e0a`. Its entire
tree equals the already-adopted reviewed parent `0886a0229b1c4f68d2f582da86aa1f248e9124f3`.
A normal merge records the squash ancestry. Duplicate ancestry produced five
conflicts in the stack inventory, migration allowlist/journal, app wiring, and
startup inspection. The existing descendant content preserves the landed tree
and the later #17666 coordinator removal. After resolving those overlaps, the
**entire result tree** equals the previously validated local branch, not just
selected source hashes. The 0403 migration is therefore now in the actual master
ancestry before this slice publishes 0404. No production or test code changed.

The required #17666 parent still must merge before this slice. Publishing the
stacked branch allows its independent CI and review to run while that parent
finishes; it does not authorize merging into the unmerged parent.

## Current master integration after webhook recovery merged

Parent #17666 merged as `7afee8f0622e273d10506b0febfb68f143d168b1`.
Master also gained the Coordinator workspace and prepared Runner changes. These
landed migrations 0404 and 0405 while this PR's prior 0404 was still unmerged.
Only this slice's unlanded migration artifacts were deferred. A normal merge
preserved every original runtime and schema edit, all unrelated upstream blobs,
and the exact parent migration tree. The repeated conflict in the shared stack
inventory retained the existing slice39 historical section; no runtime conflict
was resolved by choosing a side. The actual parent squash ancestry is recorded,
and its complete tree matches the tested normal parent composition.

The existing partial index was then generated as
`0406_zippy_war_machine.sql`. Its concurrent, idempotent SQL bytes equal the
original owned migration. Every landed SQL file, prior journal entry, and retained
snapshot stays unchanged. The final snapshot set is 0402 through 0406. Four new
comment lines were removed to follow contributor rules; both files retain the
same complete non-comment TypeScript token streams.

At `66107ae0a7ad85fd0476f91c4f8f98ae74a7a048`, all **362 cases in ten complete
files** pass, with no skipped cases, in 61.86 seconds. Seven separate fresh
PostgreSQL 17 databases prevent destructive fixture interference. Five fixtures
use their existing external URL paths. The two embedded-only lifecycle and native
cancellation fixtures temporarily used separate pre-migrated external databases
because this host cannot start more embedded clusters. Only their fixture imports
and native client teardown changed during that local run. All assertions and
original timing limits stayed intact. Both test files were restored byte for
byte afterward. This is a qualified external-database acceptance run, not an
unmodified embedded or CI-environment reproduction. Published CI keeps the
original embedded fixtures and must pass on the new head.

Database build, server types/build, module boundaries, migration order, and all
seven fresh 0406 migration runs pass. A populated 0405 database retains all 404
prior migration receipts and all 300 companies, adds exactly one receipt, and
adds none on replay. The partial index is valid and ready on upgraded and fresh
databases. Earlier failures, including the old head's unexplained decision-expiry
CI assertion and later successful single retry, remain in the evidence ledger.
The initial draft metadata equality probe and a short-SHA validation-command usage
error were rejected and corrected before acceptance; neither was a product pass.

The previously green `9388f8c020d6f73d681cb1d183193f79754b324c` review and CI
are historical. The new published head requires fresh CI and exact-head Greptile
5/5. These results do not establish deployed host or database suspension.

## Bounded reconstruction and durable browser recovery acceptance

Current-head CI at `48b3fcb83f305616df02a4337a42ec0867bb4b80` failed the same
legacy `task_retry` reload assertion previously seen on the parent: an expected
reply was absent within the unchanged five-second reload check. The other five
legacy recovery journeys passed. The earlier parent retry had passed without
explaining the failure. This repeated failure was not retried blindly.

The browser test checked a visible reply, task status Done, and one new run, but
none establishes that the canonical reply was saved. The fixture marks the task
Done before emitting its reply and returning its final result. Completion later
materializes the agent comment. A controlled temporary twelve-second delay
between the fixture's existing visible reply and final result reproduced the
same five-second missing-reply assertion. A fixture-directory cleanup race then
masked that assertion in the top-level failure; the retained Playwright trace
records the original reload assertion, and the cleanup failure remains recorded.
CI did not capture a database snapshot at reload, so this reproduction identifies
a sufficient precondition race rather than claiming direct observation of the
exact CI interleaving or production data loss.

The test now requires exactly one saved comment from the resumed run and agent
before reload. It retains the original task, readiness, and reload limits and all
previous assertions. The same controlled delay then passes. Both the fixture
delay and temporary database-URI setup were removed/restored afterward. The
permanent fixture file is unchanged. All six journeys also pass without the
injected delay. No application polling or production timeout changed.

Ponytail's current-head review found that reconstruction read the entire backlog
before any cancellation. Two real-PostgreSQL regressions failed on the old worker:
manual recovery read a second page before its first cancellation, and scoped
startup had already processed twenty items beyond the first malformed page.
The worker now loads at most one hundred raw candidates per scope per scheduler
pass. It retains a scope cursor through the existing helper's incomplete-load
contract. The shared scheduler continues only while that real reconstruction
obligation remains. Manual recovery streams pages and begins cancellation before
reading the full backlog, retaining its twenty-item execution limit and the
ability to pass malformed records. No independent timer or table was added.

The regressions pass. The scoped case also commits a new valid intent behind the
active cursor, preserves fair twenty-item batches across two companies, settles
all twenty-nine valid obligations, and performs no SQL across the later former
poll periods. The worker keeps per-candidate admission reads: a settings change
or shutdown can occur during asynchronous batch work. The existing disabled/
re-enabled and in-flight authority-read shutdown cases still pass. The optional
suggestion to cache that authority for a whole batch was not applied. The original
Migration paragraph now names the current 0406 artifacts, while retaining the
initial draft filename as history.

Source `a35fa43b98e2bd378d4a920d2775ce243654838b` passes all **363 backend cases
in ten complete files**, with no skips, in 64.00 seconds. Seven separate fresh
PostgreSQL 17 databases migrated through 0406 isolate the fixtures. The temporary
external setup for the two embedded-only fixtures follows the qualification above;
both files were restored byte for byte. Actual database build, server typecheck/
build, module boundaries, and exact-current migration order pass. The entire
database source tree is identical to the previously verified populated-upgrade
revision, so its 0405-to0406 upgrade and replay evidence remains applicable.

The final six-browser-journey run on this source passes in 40.5 seconds, with
zero retries, the original 120-second case limit, and the original five-second
reload assertion. It uses the canonical CLI/server/static-UI path and a fresh
external PostgreSQL database. Only the fixture database URI was temporarily
adapted; this is not an unmodified embedded CI-environment reproduction. The
controlled red and green are one of those six journeys, not additional distinct
cases. The two focused paging cases are included in the 363, not added again.
Fresh review and CI on the new published head still must pass before merge.
