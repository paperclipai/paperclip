# Accounting contention and best-effort budget enforcement

Date: 2026-11-03
Status: Investigation complete; first admission optimization implemented locally, remaining stages proposed
Source revision: `367f29478d14003cc5c0f161b7ce8f3164993634`

Follow-up: [Lock-free accounting design](2026-11-03-lock-free-accounting-design.md)
defines the requested target architecture. Its append-only receipt path replaces
the run-lock proposal below; this document retains the investigation evidence
and the possible behavior-preserving first migration step.

## Recommendation

Keep receipt persistence, deduplication, final settlement, and audit transactional.
Make budget detection and automatic stopping a measured, short-lag control. Move
frequent receipt writes to transactions scoped to their run or paid operation.
Evaluate budget policies in coalesced batches outside those transactions.

First remove avoidable admission transactions and measure the remaining critical
sections. Do not begin with distributed spending allocations or a new accounting
service. A short lock at an infrequent boundary can be acceptable; serializing
every company's receipt stream and admission preflight is the scaling concern.

The first implementation now inspects preliminary eligibility in a repeatable-read,
read-only snapshot. Healthy checks and checks with no policies bypass the company
writer lock. Holds, hard blocks, recovering accounting and incidents needing
resolution fall back to the existing mutating owner, which revalidates current
state under the lock. Transactional admission, reservations and receipt accounting
retain their authority. Separate inspection/reconciliation spans expose the bypass
ratio. This does not implement the later append-only accounting architecture.

Configured-policy tradeoffs: a healthy check adds an incident lookup, and an
unheld blocking/recovering scope can compute exposure once during inspection
and again during locked revalidation. Already-held scopes request reconciliation
before computing exposure. Qualify configured-policy workloads as well as the
predominant no-policy case; the change is not a claim of lower CPU everywhere.

The first milestone's budget-service suite passes 18 tests against real
PostgreSQL. A controlled writer holds the company accounting lock while routine
checks finish; authoritative admission on the same reader instead reaches its
500 ms lock timeout. Coverage includes healthy/warning policies, manual and
orphaned pauses, hold release, incident cleanup and cross-company rejection.
This establishes the lock-bypass contract, not deployed latency or CPU savings.
Seven additional accounting/enforcement/replay/tracing suites pass 55 tests,
for 73 passing targeted tests across eight files with no skips.
The full workspace typecheck passes via `node scripts/typecheck-low-memory.mjs`,
and `node scripts/check-module-boundaries.mjs` passes.
The full workspace build passes via `PAPERCLIP_TYPECHECK_LOW_MEMORY=1 pnpm -r
--workspace-concurrency=1 build`, including the current-source Runner release
binary, server, UI and CLI. The initial incomplete local Copilot build artifact
was repaired with the pinned installer before the successful canonical retry.

This proposes a product-contract change for the later stages. It does not change
the current spec or silently redefine existing configured budgets. The first
implementation stage below preserves existing enforcement semantics.

## What the investigation established on the source revision above

### The lock protects several different responsibilities

[`withAccountingTransaction`](../../server/src/services/accounting-transaction.ts)
takes `FOR NO KEY UPDATE` on the company row before invoking its callback. It
holds that lock until the transaction ends. Different companies can proceed
independently; writers for one company serialize. Ordinary report reads already
use a read-only repeatable-read snapshot and do not take this writer lock.

| Path | Work sharing the company lock before this change |
| --- | --- |
| Usage receipt | Lock run, validate source/sequence and replay hash, insert immutable receipt, update running usage, evaluate affected budgets if monetary exposure changed |
| Admission | Read company/agent/project state and policies, calculate exposure, reconcile budget holds/incidents, reserve estimated capacity before dispatch |
| Final settlement | Recover durable receipt files, validate completion, settle reservation, insert ledger entries, update projections and runtime totals, acknowledge the run, evaluate budgets |
| Other mutations | Direct cost reports, billing imports/corrections, accounting repairs, paid browser/decision/fast-response/classifier operations, and agent lifecycle operations |

The wrapper was unconditional. Having no configured budget did not bypass the
lock. The public `getInvocationBlock` method also used this mutating wrapper.
The implementation above separates its preliminary reads while preserving
the reconciliation and resume effects that some callers need.

Primary owners are [usage receipts](../../server/src/services/usage-receipts.ts),
[budgets](../../server/src/services/budgets.ts),
[reservations](../../server/src/services/budget-reservations.ts), and
[run settlement](../../server/src/services/run-cost-accounting.ts).
Queue, dispatch, and lifecycle code should consume their contracts rather than
implement another budgeting system.

### The current guarantee is already narrower than a dollar cap

Reservations serialize admission against known exposure and estimated holds.
They do not restrict how much an already-dispatched provider can charge.
`reservationCents` defaults to zero. A zero reservation still prevents duplicate
dispatch, but does not reserve a positive allowance for future model spend.

The [implementation spec](../SPEC-implementation.md) explicitly acknowledges that
mid-run enforcement depends on available provider reports or supported prices.
Providers reporting only at completion cannot provide exact mid-call detection.
Browser work can pass a provider cost cap; preserve such supported limits.

The current rules are approximately:

- Admission counts ledger spend plus the maximum of each unfinished operation's
  reservation and observed spend, plus separate browser exposure.
- Threshold stopping uses ledger plus observed running spend, rather than
  treating reservation estimates as money already spent.
- Pending terminal accounting and configured unknown-price restrictions can
  independently block work.
- Final settlement replaces live exposure with the ledger charge atomically.

Accurate recording of received evidence and instantaneous control of external
spend are separate contracts. Some prices remain estimates or unknown even when
their receipt is recorded correctly.

### The critical section can do substantial work

When applicable policies exist, [exposure evaluation](../../server/src/services/budget-exposure.ts)
executes four sequential aggregate statements over ledger entries, held
reservations joined to runs, pending/live runs, and browser work. Policies are
batched into those statements; it is not four statements per policy. With no
billable policies, these four queries are skipped.

A changed monetary receipt can invoke this evaluation synchronously. Duplicate,
stale, unchanged, and subscription receipts take different branches; not every
receipt performs the aggregate scans. Native delivery already suppresses
accepted source-event replays in its receiver, so duplicate suppression is a
measurement question rather than an assumed large win.

The hot inputs are usage and turn-lifecycle events, not every streamed text
token. Native capture handles usage reports and turn start/terminal events.
Legacy capture also durably spools before its database attempt. Recovery can
still read receipt files while the settlement transaction holds the company
lock, although it builds an initial file-identity index outside the lock.

[Monthly spend projections](../../server/src/services/costs.ts) update
`companies.spentMonthlyCents` for each ledger insert, and the applicable agent
counter. Merely deleting the explicit company lock would leave an implicit
shared-row write bottleneck and break assumptions around settlement and repair.
PostgreSQL updates acquire conflicting row locks too. See the
[PostgreSQL locking contract](https://www.postgresql.org/docs/current/explicit-locking.html#LOCKING-ROWS).

### Live traces justify a focused optimization, not a CPU diagnosis

Read-only observability queries examined one live host. The matched one-hour
sample is **2026-11-03 16:45–17:45 UTC**, service revision
`3910352c923afda320b2a5134e523932ee1d0633`.
The aggregate measurements are reproduced below. Private trace links and host
identifiers remain outside the repository.

| Observed span | Count | p50 | p95 | p99 | Maximum |
| --- | ---: | ---: | ---: | ---: | ---: |
| Company lock acquisition | 9,421 | 13.00 ms | 206.85 ms | 725.14 ms | 4,301.53 ms |
| Accounting transaction | 9,421 | 87.16 ms | 486.95 ms | 1,147.10 ms | 5,594.19 ms |
| Admission evaluation | 8,082 | 43.45 ms | 166.84 ms | 342.13 ms | 1,212.92 ms |
| Final settlement | 216 | 355.90 ms | 1,894.05 ms | 3,149.67 ms | 5,594.33 ms |

These are span counts; nested spans must not be added as independent operations.
There were 23 `budget.admission.reserve` spans in the same window. The much larger
admission-evaluation count warrants caller attribution, not an assumption that
all evaluations represent new paid dispatches.

Of 8,292 exposure evaluations on that host in that hour, **8,280 had zero policies**
and 12 had one. That is 99.86% with zero policies at this call boundary; it does
not prove that every company has no budgets. These empty evaluations are cheap,
but their surrounding admission/accounting work still takes the company lock.

One inspected admission transaction took 4.183 seconds, with 4.090 seconds in
lock acquisition. Its exposure child had zero policies and took about 0.026 ms.
A separate settlement transaction took 5.594 seconds, including 4.302 seconds
in acquisition and a zero-policy exposure evaluation.
Both inspected traces report mean sample rate 1.

Limits of this evidence:

- The acquisition span measures the complete awaited lock query. It includes
  database/network round trips and Node scheduling; it is not a PostgreSQL
  lock-wait measurement. Transaction duration also includes transaction setup
  and commit. Do not subtract unrelated percentiles to estimate hold time.
- The spans do not identify the locking company, blocker, receipt frequency,
  or operation caller. They do not establish one company's throughput ceiling
  or the cause of the previously observed CPU utilization.
- The sample identifies one host. It does not establish fleet-wide behavior or
  independently qualify the public instance serving each request.
- The local accounting wrapper, receipt, exposure, budget service, and run-cost
  files match the traced revision in Git. Other deployed components and database
  workload have not been qualified against this checkout.
- The existing [budget benchmark](../../scripts/benchmark-budget-enforcement.ts)
  varies unrelated idle-agent count. It does not test concurrent receipt writers,
  10,000 active runs, or growing ledger history. It was inspected, not run here.

## Proposed behavior

| Responsibility | Proposed contract |
| --- | --- |
| Receipt acceptance | Durable commit before acknowledgement; source ownership, sequence, hash conflicts and company scope remain enforced |
| Ledger and settlement | Idempotent transaction scoped to the run/invocation; no lost charges, duplicate application, or transient live-plus-final double counting |
| Budget detection | Coalesced evaluation from committed evidence; a measurable delay is allowed |
| New work | Check current authoritative pause/Stop and known budget-block state at dispatch; concurrent admission against a not-yet-reflected spend increase can overshoot |
| Automatic cancellation | Commit durable stop intent, then use the existing scoped cancellation worker; provider shutdown remains a separate obligation |
| Manual Stop and authorization | Preserve current execution-authority checks; budget approximation does not weaken them |
| Unknown accounting | Retain unresolved obligations and existing configured unknown-usage restrictions; missing evidence is never a zero-cost receipt |

Suggested initial service targets, to validate before adopting as promises:

- Coalesce dirty budget work over approximately one second while work exists.
- p99 from committed priced receipt to durable threshold-stop intent at most
  five seconds under the qualified workload. Measure provider reporting delay
  and cancellation latency separately.
- For applicable spend limits, stop admitting additional paid work when the
  oldest unevaluated accounting change exceeds fifteen seconds. This is a
  proposed protection against a failed evaluator, not a hard spending cap.
  An idle company's old evaluation timestamp alone must never trigger it.
- With no dirty changes, unresolved retries, or actual budget deadlines, the
  evaluator performs no recurring database scans.

Best effort needs a stated overspend model. As an illustration, 10,000 runs each
spending $0.001/second consume $10/second; five seconds of extra detection delay
adds about $50, before unreported and uncancellable in-flight work. Those are
hypothetical rates, not a measured cost estimate or maximum.

In general, additional spend depends on fleet burn rate multiplied by reporting,
evaluation, and stop delay, plus already-committed work. Without bounds on those
quantities, do not advertise a bounded dollar overshoot. A strict end-to-end cap
would require provider-enforced limits or preauthorized bounded work; distributed
allocations alone cannot cap a provider that can exceed its allocation.

## Implementation stages

### 1. Attribute the cost and eliminate unnecessary admission transactions

Owners: accounting transaction/tracing services, budget admission API, and its
queue/dispatch/lifecycle callers.

Add a closed operation-kind label to accounting spans so receipt, finalization,
preflight, reservation, policy edit, correction, and lifecycle work can be
distinguished. Capture acquisition-query time, time from acquisition return to
transaction completion, query count, and replay/outcome categories. Keep the
operator-gated Observability contract and content-free attributes; this is not
first-party Telemetry. Label the client-observed held interval honestly because
it includes commit/return latency. Use sampled PostgreSQL wait/blocker evidence
to establish actual contention, with SQL values and credentials excluded.

Separate read-only preliminary eligibility from mutating reconciliation.
Preflights should not take a company writer lock just to discover no applicable
policy. Keep the existing authoritative reservation and policy check at final
dispatch in this stage. Budget changes, rollover, settlement and explicit
reconciliation continue to own their necessary effects. Do not introduce a
stale cached "no budgets" result that can bypass a newly configured limit.

Measure identical receipt replay and unchanged snapshots before prioritizing
their optimization. Any early replay return must prove the immutable receipt
and relevant projection state agree. Native event identity and lifecycle events
cannot be discarded just because their monetary amount is unchanged.

Deliver a real-PostgreSQL benchmark using the service boundaries below, and the
small behavior-preserving optimization justified by the caller measurements.
If this removes today's significant delay, ship it independently; later stages
remain a deliberate scale/product decision.

### 2. Persist receipts per run and evaluate budgets asynchronously

Owners: usage receipts, native usage delivery, budget exposure, budgets, and the
existing accounting/enforcement delivery lifecycle.

In one run-scoped transaction:

1. Validate current source/ownership and lock the run.
2. Insert or verify the receipt with its unique identity and fingerprint.
3. Replace the run's accepted cumulative usage/exposure projection.
4. Persist a versioned pending-evaluation marker and register the normal
   transaction-aware wake.
5. Commit before acknowledging native delivery or removing legacy spool evidence.

Do not take the company accounting writer lock or evaluate all affected policies
inside this receipt transaction. Keep final and partial receipts durable; batch
derived budget evaluation rather than dropping intermediate accounting evidence.

Use the shared delivery coordinator for coalescing, retry and deadlines. Pending
state must be scoped to the changed run/operation, or an append-only change;
updating one company dirty counter for every receipt would recreate the lock.
Consumption must compare revisions or claim durable work so a concurrent change
cannot be cleared by an older evaluator. A timestamp/sequence high-water mark
alone cannot safely assume database transactions commit in allocation order.

Read ledger and live contributions in one consistent database snapshot, or use
transactionally consistent replacement contributions. The present four separate
read-committed aggregates are not safe to reuse unchanged once other operations
in the same company can settle concurrently: live-to-ledger
replacement must not be missed or counted twice across queries.

Evaluate each affected policy once per batch, revalidate its revision before
committing block/resume state, and retain durable cancellation generations.
Updates arriving during evaluation remain pending. Recovery reconstructs pending
work after restart; rollback must not publish a false wake or acknowledgement.
Use short policy-state transactions where necessary. Preserve manual holds and
committed stop obligations during policy changes and price corrections.

This is the first stage that permits an additional detection/admission race
window. Update the product contract together with implementation; removing only
the wrapper is not a valid intermediate change.

### 3. Remove remaining company writes from frequent settlement

Owners: run-cost accounting, costs, billing reconciliation/import, accounting
integrity, paid-service invocation owners, and DB/shared contracts.

Settle ledger entries, reservation state, final receipt acknowledgement, and
run-specific accounting together under the operation's lock. Use database
uniqueness plus conflict/hash verification for concurrent idempotency; a
read-before-insert check previously protected by the company lock is insufficient.
Retain narrow agent coordination for shared runtime totals where needed.

Move company monthly display-counter updates to versioned, coalesced projection
work. Update integrity inspection/repair and all counter consumers to understand
projection freshness and checkpoint identity. Reporting from ledger snapshots
remains available; intentional projection lag must not look like lost money.
Handle backdated events, credits/corrections, UTC rollover and lifetime budgets.

For receipt-file recovery, stage immutable candidate envelopes outside the broad
transaction, then validate source/version and closure under the operation lock.
Retain disk evidence until the final owning transaction commits. A concurrent
late receipt or replaced source must still prevent premature acknowledgement.

Apply the same boundary to browser runs, decision-model invocations, fast
responses, prompt-injection classification, and externally reported charges.
Inventory administrative users of `withAccountingTransaction` separately;
agent deletion, repair, and lifecycle safety must not depend on a lock removed
from receipt writers. Specify and test the new lock order, including issue/run
ownership and foreign-key interactions. Keep supported provider spending caps.

Start with bounded batches and indexed aggregates. If history growth or batch
time misses the target, maintain incremental scope/window contributions. If
those counters become the next measured hot row, partition their writes and
sum a bounded set of partitions. Do not synchronously increment a single new
company total on every receipt and call the bottleneck solved.

### 4. Qualify workload and roll out

Extend the existing benchmark rather than using idle-agent count as scale proof.
Use real PostgreSQL with at least two independent controller processes and
explicitly recorded connection-pool limits. Simulated provider events should
exercise real receipt ingestion and settlement, followed by a smaller real
provider qualification. Keep load tests off the active staging instance.

| Dimension | Required cases |
| --- | --- |
| Distribution | 100, 1,000, then 10,000 active runs; one company and many companies |
| Receipt cadence | One update per run per 60 seconds, 10 seconds and 1 second; record actual target-provider cadence before choosing the release load |
| Policies | None; company; agent/project only; overlapping scopes and windows |
| History | Increasing ledger history independently of active-run count |
| Event shape | Cost-changing, unchanged, subscription, duplicate, stale, conflicting and out-of-order reports; reconnect bursts |
| Races/failures | Simultaneous settlement and receipt, worker crash, failed/ambiguous commit, source replacement, policy change, manual Stop, late final charge, unknown price and UTC rollover |

At 10,000 runs the illustrative receipt cadences imply about 167, 1,000, and
10,000 receipts/second before admission or settlement. This defines a workload,
not a claim that current or proposed code supports it. A shared critical section
held for an average of H seconds has an ideal ceiling near 1/H operations/second
for that company; do not estimate H from the unrelated percentile summaries.

Acceptance requires durable receipt/ledger equality after quiescence, no duplicate
effect or acknowledgement loss, stable pending-work depth, correct policy/manual
hold behavior, and measured detection/cancellation/freshness targets. Record
p50/p95/p99 ingestion, admission and settlement latency, actual PostgreSQL wait
events, query count/rows/bytes, CPU/event-loop delay, and reconnect recovery time.
Prove unrelated companies remain responsive and writers for unrelated runs no
longer contend on a shared company update in the frequent path.

Initially compute the proposed evaluation in shadow mode without stop/resume
effects and compare it against the authoritative ledger and existing decisions.
Then canary the new enforcement contract on an explicitly selected environment,
with its versioned pending work rebuilt and validated before switching. Do not
run old and new enforcement authorities simultaneously for the same company.
Rollback must drain/reconcile accepted receipts and rebuild authoritative state
before restoring the older path; flipping a flag alone is insufficient.

Relevant existing coverage includes scoped budget enforcement, live attempts,
native usage delivery, run-cost accounting, budget cancellation, worker recovery,
and idle-accounting work. Add focused concurrency/failure tests for the changed
boundaries; run the repository's full checks before a PR-ready implementation
handoff. Browser qualification is needed if dispatch/Stop or budget UI semantics
change, not to validate this plan file.

## Contract and delivery boundaries

Before enabling the new behavior, update `doc/SPEC.md`,
`doc/SPEC-implementation.md` (especially scheduler and budget enforcement), the
applicable contributor invariants, shared budget contracts, and user-facing
budget explanations. The UI should say what auto-stop does and disclose possible
in-flight overspend; it should not expose internal partition mechanics. Decide
how configured existing reservations retain their estimate/visibility role
without promising atomic aggregate admission in the new mode.

Distributed bounded spending allocations are deferred. Revisit them only if
customers need stricter aggregate admission or qualified batch evaluation cannot
meet latency/overspend needs. They require provider cost bounds as well as
replenishment, revocation and policy-version coordination to become a monetary
guarantee. They are not required for the recommended first implementation.

Investigation validation: inspected the source and existing test/benchmark
contracts, queried live spans and two individual traces, and checked the relevant
deployed-revision source diff. No service, configuration, database, or deployed
code was changed. Runtime tests and load tests were not run for this planning
change; dependency installation and implementation belong to the next stage.
