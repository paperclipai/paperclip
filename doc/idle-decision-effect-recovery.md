# Idle decision-effect recovery

Interrupted decision effects now have a dedicated deadline worker. The main
maintenance tick no longer scans running decisions. Target invalidation remains
in that tick; TTL expiry and continuation delivery have their own workers.

## Obligation and activation

The existing decision row is durable truth. A row with `status = decided` and
`executionStatus = running` owes effect recovery. Its next deadline is
`updatedAt + PAPERCLIP_DECISIONS_RECOVERY_GRACE_MS`, default 60 seconds. Zero is
supported; invalid or negative values retain the existing default. Reads do not
move the timestamp. Open decisions and completed history create no recovery debt.

The existing `writeDecisionChange` transaction boundary signals effect recovery
for running claims, effect/archive settlement, cancellation, dismissal and expiry.
The generic `notifyDecisionChange` helper signals continuation and expiry only;
open-decision creation does not owe effect recovery. Notifications are awaited
before writes. Outer commit activates work; rollback does not publish a claim.
The additional topic does not wrap provider work or agent wakes in SQL transactions
and does not introduce a new queue table.

Committed notification bursts coalesce for up to one second after a successful
pass. This bounds sequential tenant writes to at most one notification-driven
global pass per window, rather than only coalescing overlapping scans. A saved
recovery deadline can preempt that window. New obligations discovered by a signal
can wait up to one second; foreground effects still execute immediately. The
window alone never schedules work when there is no notification or saved debt.

The supported writer model is the application DB signal owner and its child pools.
Independent SQL clients and multiple active writers need a separate notification
contract. Startup reconstructs committed claims; it does not observe future writes
from unsupported writers.

## Ownership and recovery

`decision-effect-recovery.ts` owns selection, grace, bounded paging, and earliest
deadline lookup. `decisions.ts` owns execution, current membership, effect claims,
audit, archive policy, and continuation delivery. The worker adapter only binds
that domain contract to the shared coordinator. Startup registers it only when
heartbeat scheduling is enabled. The public combined sweep retains its default
recovery behavior for existing callers.

Each pass honors the existing configured batch size (default 100, finite values
clamped to at least one integer). Its timestamp/ID cursor advances past failed
candidates within a frozen final timestamp/ID. Newer due claims wait for the next
rotation, so a continuous stream cannot postpone an earlier failure forever.
Both cursor positions retain PostgreSQL precision. Genuine execution or settlement
failures retain their retry obligation.

A missing saved decider or chosen option is a deterministic malformed outcome.
Recovery rechecks it under a row lock, records an audited failed outcome (partial
if a completed effect receipt exists), and preserves all effect receipts. It
creates no authority and executes no effect for the malformed claim. The failure
reason and continuation obligation are saved in the same transaction as the audit.
An audit or settlement failure rolls back and leaves the claim pending. A claim
repaired before the lock is acquired remains eligible for normal recovery.

The decision service re-reads current status before recovery. Foreground and
recovery execution share the existing per-decision flight scoped to the DB owner.
Individual effects keep their durable records and transaction advisory locks.
Completed effects are not repeated after a failed final decision status write.
Recovery derives authority from the saved decider's current active membership.
It preserves the current authorization intersection and current target checks.

The scheduler has a 30-second minimum retry spacing for pending or failed work.
A first claim or failed retry during drain retains its wake without passive SQL.
Shutdown stops subscriptions and checks cancellation between candidates. An
already admitted effect/continuation is awaited; later candidates remain durable
for restart. No periodic pass remains after all claims settle.

## Existing guarantees and limits

Regular effects preserve their existing per-effect transaction boundaries.
Continuation delivery retains its separate at-least-once wake/acknowledgement
contract. This migration does not establish exactly-once external delivery.

Archive proposals have a separate versioned manifest contract. Recovery still
verifies the saved signature/manifest and current authority. A crash after an
archive commits but before the decision settles can encounter the changed
manifest version on restart. The existing result is a failed decision with an
archive error, while the archive remains committed once. The new worker preserves
and tests that outcome; it does not claim to repair this preexisting atomicity gap.

Cloud sleep guards remain conservative. The internal next deadline is not a
persisted external alarm and does not authorize host sleep with running decisions.
This change establishes worker quiet, not actual instance/database suspension.

## Verification

The new real-PostgreSQL suite covers 17 cases: empty/open/completed-history quiet,
real foreground claim and failed settlement, exact grace and zero override,
restart from a claimed effect, active foreground/recovery overlap, outer commit
and rollback, first claim and failed retry through drain, revoked authority,
continuation failure, aggregate exclusion, fair paging past missing-decider and
malformed claims, archive recovery before and after an archive commit, a claim
created during delivery, and shutdown between candidates. Quiet assertions observe
SQL methods through one hour of fake time after settling.

The combined selection passes 212 tests: the 17 new cases, 50 existing decision
service cases, 14 TTL cases, 39 startup cases, and 92 agent-history route cases.
The first 15-case recovery run also passed. Workspace typecheck/build and the
final server typecheck pass. No failure was suppressed or timeout increased.

The current regenerated migration `0390_salty_killraven.sql` adds one partial index concurrently, with `IF NOT EXISTS`, through
the migration owner's top-level statement path. Generation retains the newest
five schema snapshots. Fresh application, replay, safety, and numbering checks
pass. With 40,000 completed decisions and one running claim, both due selection
and earliest-deadline lookup use the partial index and read two buffers (0.012 ms
and 0.003 ms in the local probe). The probe transaction is rolled back.

Full PR CI and review must pass separately before this slice is ready.

A follow-up regression seeds a legacy invalid claim with a PostgreSQL-generated
microsecond timestamp ahead of a valid claim. With a one-row page, the original
Date cursor selected the invalid claim again and starved the valid effect. That
regression failed before repair. Recovery now retains the timestamp as database
text for cursor comparisons, leaving business grace deadlines unchanged. The
unresolved claim remains durable debt and is revisited after paging wraps; the
valid claim progresses without repeating its completed effect. The regression
now holds a candidate unresolved through the dispatch callback, because known
malformed claims receive a durable failed outcome as described above.
All 18 effect-recovery lifecycle cases and server typechecking pass after repair.

### Foreground join test timing

CI exposed a timing assumption in the foreground/recovery overlap test: it
expected exactly two lifetime recovery sweeps. A controlled PostgreSQL replay
waited for the committed claim's deadline discovery before advancing time. It
recorded two completed, zero-resumption scans before the deadline (startup and
claim notification), followed by the legitimate deadline scan. The old assertion
then failed deterministically with three calls. No recurring idle poll or duplicate
effect was found in that sequence.

The test now waits for discovery, measures the deadline recovery relative to that
point, and proves that its promise stays pending while foreground execution holds
the effect lock. Advancing through several retry periods cannot start another
sweep or effect. After release, recovery completes, one comment and one continuation
wake exist, and the worker performs no SQL through the existing hour-long quiet
check. Counting actual lock attempts also distinguishes joining from a second
execution blocked on the same PostgreSQL advisory lock. A temporary mutation that
removed flight joining made this stronger assertion fail; production code was
restored before final verification. No runtime code, retry policy, timeout, or
business deadline changed.

All 123 tests across the four complete effect-recovery, decision-service, expiry,
and startup suites passed, followed by server typechecking. Evidence:
`/tmp/sleep-effect-join-red.log`, `/tmp/sleep-effect-join-green.log`,
`/tmp/sleep-effect-join-mutation.log`, `/tmp/sleep-effect-join-owning-tests.log`,
and `/tmp/sleep-effect-join-root-types.log` with their status files. The initial
failure and mutation failure are expected evidence, not passing runs. Remaining
review findings and fresh stack CI remain separate acceptance requirements.


### Recovery review repairs (October 26)

Two regressions failed before repair: an old failure was not revisited while newer
due claims kept each page full, and creating an open decision caused an unnecessary
effect-recovery scan. Frozen rotation boundaries now preserve both retry fairness
and forward progress. Creation still signals its continuation/expiry consumers;
the effect queue is signaled by the existing claim/settlement write boundary.

Four malformed-outcome cases also failed before repair. Recovery now records
`effectRecoveryError` and a `decision.recovery_failed` activity atomically. Live
activity publication follows commit. Existing completed effect receipts remain
unchanged, and the normal continuation owner delivers the result. A real audit
insert failure leaves both status and audit uncommitted, then later recovery
settles successfully. A real PostgreSQL row-lock test repairs a claim while
settlement waits; the locked recheck leaves that claim running, and its valid
effect executes once on the next pass.

The shared execution flight now loads the current claim and derives recovery
authority together. Recovery no longer performs a redundant full-row lookup
before entering the flight. Foreground overlap, current membership checks,
per-effect locks, continuation behavior, and the resumption count are preserved.
Only the two known malformed states are terminalized; other failures retain their
existing retry policy. No schema, queue, or external-wake contract is added.

All 24 recovery lifecycle cases and server typechecking pass. Controlled failures
and final evidence are retained in `/tmp/sleep-effect-fairness-red.log`,
`/tmp/sleep-effect-invalid-red.log`, `/tmp/sleep-effect-owner-tests.log`, and
`/tmp/sleep-effect-owner-types.log`. Broader stack and remote acceptance remain
separate requirements; these results do not prove host suspension.

The owning branch also passes all 129 cases across the four complete recovery,
decision-service, expiry, and startup suites. Database-backed suites use separate
migrated disposable databases. See `/tmp/sleep-effect-review-owner-acceptance.log`.


### Bounded notification review repair

Ten sequential real cancellation transactions reproduced ten extra recovery
scans. After enabling the existing shared notification-coalescing capability,
the same transactions cause one follow-up scan and then return to SQL quiet.
A separate real-database case preserves an already loaded deadline 500 milliseconds
away. The initial deadline fixture observed the scheduler while its SQL pass was
still active; waiting for that read removed the fixture race before the baseline
was recorded. The cancellation amplification still failed before the production fix.

All 131 tests in the four complete recovery, decision-service, expiry and startup
suites pass at the owning branch, as does server typechecking. The helper's optional
coalescing capability is promoted from the later plugin scheduling slice into this
PR; consumers that omit it keep their previous behavior. The integrated stack is
verified separately before publication. The original full-suite and external-wake
limitations remain.


## Current parent integration

The expiry and continuation review repairs are integrated normally. The running
claim index is regenerated as 0390 after parent 0388/0389, with concurrent creation
registered in the existing executor. All 388 parent journal entries are unchanged;
the five newest generated snapshots remain. Schema drift, numbering/safety and
fresh migration apply/replay pass. No generated snapshot was hand-edited.

All 141 cases in the five complete effect-recovery, decision/continuation, expiry,
startup and scoped-deadline suites pass. This includes all 26 recovery cases and
the parent's deterministic cross-pool archive contention test. Server types and
build pass. The first integrated run passed 140 cases and failed an old scheduler
assertion: the coordinator now also holds an earlier continuation-coalescing
deadline. The overlap test services that earlier registered wake, then still
requires the original effect grace deadline, one active effect flight, two total
advisory-lock attempts (test gate plus foreground), one committed effect and one
continuation. No production timing or retry was changed to pass the test.

Existing one-second effect-notification coalescing and thirty-second failure
retry remain. Continuation notification coalescing is owned separately by the
parent. Extra upstream embedded-only tests attempted during parent integration
could not initialize locally; fresh current-head CI must cover that environment.
Full CI and both automated reviews remain merge gates.


After normal integration of master-target expiry parent `f7c61e9912`, the
effect-recovery owner, worker, decision execution and notification implementations
are unchanged. All 69 current recovery/startup/deadline cases and server types/
build pass with the updated Runner vendor. The earlier full 141-case selection
remains evidence at its stated revision. Parent migration history is an exact
prefix and five generated snapshots remain. Fresh head CI and both automated
reviews are required after this parent integration.


## Landed expiry integration and CI interruption

Expiry-only creation notification from `aa03d2c4c2` is integrated. All 143 cases
in the complete recovery, decision, expiry, startup and scoped-deadline suites
pass, including single/bundle creation without continuation signals. The normal
merge of landed expiry `3421366903` also preserves all 21 independently merged
master files. The same 143 cases pass after that reconciliation.

The previous candidate `f54a707d74` had both reviews at 5/5, but CI run
40597921712 failed because server shard 6 was interrupted. Its test step was
cancelled and orphan cleanup ran; no failing test assertion or suite summary was
reported. The workflow eventually completed with that shard and its dependent
verify gate failed. It was not retried or presented as passing. The necessary
expiry parent repair creates a new candidate with fresh CI and reviews required.
