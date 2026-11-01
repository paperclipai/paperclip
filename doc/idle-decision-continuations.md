# Decision continuation delivery while idle

A terminal decision can owe an agent wake. Its existing row stores that debt:
`continuationPolicy = wake_origin_agent`, `metadata.continuationPending = true`,
and either expired/cancelled status or a decided status with succeeded/partial/
failed execution. Open decisions and running effects are not ready to deliver.
This migration adds no queue table and changes no wake payload.

## Ownership and producers

`decisions.ts` owns decision creation, authorization, signatures, effects, and
state changes. Its ten update sites now use a narrow transaction-aware write
helper before the SQL statement. These cover the running claim; ordinary effect
completion; archive-proposal signature, manifest, and execution failures; archive
success; TTL rejection on use; cancel; direct dismissal; and background expiry.
The helper acquires intent in the existing outer transaction or its savepoint.
It does not include effect execution, provider calls, activity publication, or
agent wake callbacks in a new database transaction.

Creation and bundle creation insert open decisions, so they do not create ready
continuation debt. Acknowledgement only clears debt and belongs to the delivery
owner; it does not signal itself. The production decision services are created
by server startup and routes with the application's DB handle. Independent SQL
writers and additional active processes require a separate notification and
ownership contract. This change does not make wake-producing service methods
safe to call inside an uncommitted caller transaction; only their SQL mutation
boundary has the existing outer-commit guarantee.

`decision-continuations.ts` owns the readiness predicate, delivery, and recovery.
Each worker pass attempts at most 100 candidates. A saved in-memory cursor
advances past failed candidates between passes and wraps after the last page.
Remaining durable work retains another pass. This avoids starving later rows behind a failing first page.
A partial ID index contains ready pending continuations only. The predicate uses
fixed SQL literals so a prepared generic plan can still use that index.

The shared DB package exposes an opaque work-scope identity. Raw DB object
identity is insufficient because dedicated and liveness child pools already
share their owner's signals. The key is shared by those children and nested
transactions; independent roots have different keys. No connection credentials,
private transaction state, or decision policy are exposed. Existing signal
consumers and transactions that do not register work keep their behavior.

## Foreground, recovery, and failure

Foreground delivery remains immediate. All service instances sharing the DB
owner coalesce a simultaneous wake for the same decision into one promise.
Delivery re-reads durable readiness after claiming that local flight, so a late
foreground call cannot resend a continuation already acknowledged by recovery.
The promise is removed on success or failure. Effect execution and its final
state write also share one local flight per decision. This prevents concurrent
archive callers from turning a successful archive into a stale-manifest failure. This is process-local coalescing,
not a new durable claim or an exactly-once guarantee.

Effect completion requires the row to remain running. A competing completion
cannot restore pending metadata after another caller has completed and delivered
it. Effects retain their own existing durable claims and authorization checks.
The delivery worker never executes effects.

A wake failure leaves pending metadata intact. A failed acknowledgement also
leaves debt, so a later attempt can send the wake again. A crash after accepting
the wake but before acknowledgement retains the existing at-least-once contract.
An uncertain producer transaction remains held until the shared work-signal
protocol establishes settlement; one empty scan cannot clear that uncertainty.

## Lifecycle and scope

Startup reconstructs pending delivery. Committed changes wake the worker through
the existing coordinator. Failures or remaining ready debt retain a 30-second
retry. Open/running decisions, no decisions, and delivered history have no
recurring continuation scan or deadline. Changes during a pass retain another
request. Drain/standby defer dispatch without consuming that request; shutdown
waits for the current admitted delivery and stops before starting another.
The shared deadline adapter forwards its existing AbortSignal to task execution;
existing callbacks that do not consume the signal keep their behavior. A future process-local retry is not a Cloud alarm.

Enabled-heartbeat startup registers this worker before the combined decision
sweep. The main tick skips that sweep's independent continuation scan. Its public
API retains combined behavior by default. Expiry or effect recovery can still
deliver their newly produced continuations immediately. Disabled-heartbeat
startup keeps its existing behavior and does not dispatch this new worker.

Decision expiry, invalidated-target scanning, interrupted effect recovery, and
retention remain separate migrations. Existing Cloud safety blockers are not
relaxed. This establishes worker quiet under the named conditions, not deployed
host/database suspension or measured fleet savings.

## Verification

The selected run passes 93 tests: 50 real-PostgreSQL decision cases, 39 startup
cases, and four database work-signal unit cases. Fifteen new continuation cases
cover real decide/cancel/dismiss/expiry producers, running-to-terminal completion,
foreground contention, dedicated child pools, stale caller re-read, restart,
failed acknowledgement, outer rollback/commit, first write during drain, failed
retry through drain, changes during delivery, shutdown, and paging past a failed
candidate. Quiet checks observe no SQL calls across an hour of controlled time.
Nine pre-existing embedded-PostgreSQL signal tests are skipped locally because
the embedded runtime is unavailable; CI must run that supported environment.
Workspace typecheck and build pass. The final literal-predicate adjustment also
passes all 49 decision tests before the additional archive-race regression.

The original continuation index applied and replayed without error. After parent integration it is generated migration `0388_ambitious_micromax.sql`; the fresh apply and replay also pass. A rolled-back synthetic
40,000-row history with one pending continuation uses the partial index under
`force_generic_plan`, reads two shared buffers, and executes in 0.015 ms on the
local PostgreSQL server. This is query evidence, not a production latency claim.

The first test selection had 90 passes and one failure: the injected PostgreSQL
acknowledgement error is wrapped by Drizzle, but the assertion expected its
message at the top level. The assertion now checks the original cause. No
production retry, hold, or timeout was weakened. A recursive unit-fixture type
initially prevented migration generation; an explicit fixture type fixed it.
Full CI and fresh review remain required before PR readiness.


Review found two real regressions. Before repair, a controlled concurrent archive
reported failed after archiving successfully, and shutdown sent a second wake
after stop was requested. Both regressions failed before the fix. Shared local
effect ownership fixes archive completion; bounded passes and abort propagation
fix backlog shutdown. The 93-case selection passes after repair. The paging test
also proves a failed first candidate cannot hide the 101st candidate across
bounded passes. A result-type alias initially made the known decision ID optional;
the alias now matches the existing outcome contract.

The existing tool-review and archive-delivery consumers also pass 124 real-DB
tests after AbortSignal propagation. Together with the decision/startup/signal
selection, 217 selected tests pass; the same nine older embedded-only cases
remain locally skipped. Workspace typecheck passes after the outcome type fix.


## Explicit archive-failure delivery

The three archive-proposal failure paths now explicitly set
`continuationPending: true` for `wake_origin_agent`, rather than assuming the
pre-read running row already carries that metadata. The existing running-state
fence remains, so stale settlement cannot re-arm an acknowledged result.
Invalid signatures, manifest mismatches and archive execution failures each
failed a real-PostgreSQL recovery regression before repair. Each now saves the
failed result, wakes once, acknowledges delivery and remains quiet on replay.

Normal parent integration preserves the projection interaction-link index and
archive pending-order index. The unmerged continuation index was regenerated
as 0388 from the parent's generated metadata; every parent journal entry is
unchanged, five snapshots remain, the SQL uses the existing top-level concurrent
executor, and snapshot/schema drift passes. No generated snapshot was hand-edited.

The final affected selection passes 111 cases: 53 decisions, 15 retention/archive,
42 startup and one scoped-deadline case, with all four suites exercised. The
first combined command used the wrong retention DB variable and skipped those
15 cases; the corrected external-PostgreSQL retention run passes all 15. Server
typecheck and build pass. The historical nine embedded-only work-signal skips
above are not reclassified as executed by this selection. Fresh CI and reviews
remain required.


## Bounded notification-driven recovery

Security review identified that sequential decision writes could each start an
instance-wide continuation scan. A real-producer regression reproduced six
sweeps for six sequential cancellations. The worker now uses the existing
`notificationCoalesceMs: 30_000` option. The first wake after a quiet window still
reconciles promptly, and subsequent notifications in that window share its end
deadline. Foreground continuation delivery is unchanged and immediate. Recovery
can wait up to thirty seconds, matching the prior maintenance cadence. This
bounds global scan frequency; it does not make queries company-scoped or add a
cross-process notification contract.

The regression verifies one scan during repeated real create/cancel writes,
retention and eventual delivery of a later pending row, and no recurring SQL
after settlement. Its first green attempt wrongly expected zero active work
while the coalesced request was pending. The existing intent hold correctly
remains until reconciliation; the test now checks that hold's actual terminal
boundary through the existing quiet assertion. No production hold was removed.
All 293 integrated cases across decisions, archive, gateway/projection, startup
and scoped-deadline suites pass without skips; server types/build pass. Fresh
security review, Greptile, Ponytail and exact-head CI remain merge gates.


The archive contention regression no longer waits a fixed 100 ms. A dedicated
single-connection contender signals its decision read; two FIFO SQL round trips
then establish that it reached shared execution while the first archive remains
held. The test requires one contender decision read and one archive execution.
Temporarily removing the effect-flight guard made this test fail (two reads);
restoring the production guard passes. The mutation was restored before commit.
This verifies actual cross-pool contention without a timing delay or a new
production-only test hook.


Archive #17475 is merged. Normal reconciliation with its exact squash
`5785090ff1` preserves all 31 independent incoming master files, including
Runner controller-authority recovery. All 97 decision/startup/deadline cases and
server types/build pass after that integration. The Runner vendor rebuilt from
its changed inputs. The preceding full five-suite selection passed 293 cases;
the continuation owner's production behavior is unchanged by reconciliation.
Fresh exact-head reviews and CI remain required on the master-target candidate.
