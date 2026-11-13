# Remove company serialization from all five settlement paths

Date: 2026-11-03
Status: Implemented candidate; final verification/review in progress
Source reviewed: `a194166017597860a0e53c0c1314e95c597d75cc`

## Decision and finish line

Remove the company accounting mutex from run, decision-model, fast-response,
prompt-classifier and browser settlement. Independent paid operations in the
same company, including the same agent, must commit independently. Remove the
shared company/agent counter writes and synchronous budget evaluation from those
commits too; otherwise removing the explicit lock leaves the bottleneck intact.

Keep durable receipt/ledger accounting exact and replayable. Make budget
admission and threshold enforcement explicitly best effort: concurrent work can
start from the same available-budget observation, and cancellation follows a
coalesced decision. Reservations record each operation's obligation; they no
longer allocate an exclusive portion of a company balance.

This eliminates company-wide accounting serialization, not PostgreSQL's internal
locking. Keep the existing short operation-row arbitration and unique keys for
two workers settling the *same* operation. Resource ownership, lifecycle fencing,
foreign keys and manual Stop retain their domain owners. No company advisory
lock, company CAS counter or per-receipt policy-row update replaces the mutex.

This is the concrete next milestone after PR18830 and the earlier
[architecture proposal](2026-11-03-lock-free-accounting-design.md). It does not
require that proposal's full append-only journal/partition-reducer system.
Removing the mutex can improve settlement and dispatch capacity; it does not by
itself prove a CPU or event-loop improvement. Existing generic settlement spans
also do not identify which of the five callers owned a slow transaction.

## Current owners

All five call `withAccountingTransaction`, which awaits
`SELECT companies.id ... FOR NO KEY UPDATE` before running the callback.

| Path | Owning service and entry point | Existing local accounting identity |
| --- | --- | --- |
| Agent run | [run-cost-accounting.ts](../../server/src/services/run-cost-accounting.ts), `accountRunCost` | Run row; `heartbeat:<run>:final` / existing model-part keys |
| Decision model | [decision-models.ts](../../server/src/services/decision-models.ts), `settle` | Invocation row; `decision:<id>` |
| Fast response | [fast-responses.ts](../../server/src/services/fast-responses.ts), `settle` | Request row; `fast-response:<id>` |
| Prompt classifier | [prompt-injection-prevention.ts](../../server/src/services/prompt-injection-prevention.ts), `settle` | Invocation row; `prompt-injection:<id>` |
| Browser | [browser-use.ts](../../server/src/services/browser-use.ts), `account` | Browser-run row; provider run identity and cumulative exact total |

The common cost helper also updates `companies.spentMonthlyCents` and
`agents.spentMonthlyCents`, sometimes `agentRuntimeState` totals, then evaluates
budget exposure. Run settlement and billing correction have additional runtime
counter writes. These are prerequisites to remove, not optional follow-ups.

## Shared foundation before the first path is unlocked

### 1. A narrow ledger transaction contract

Split [costs.ts](../../server/src/services/costs.ts) so owners can call a
ledger-only insertion primitive. It validates tenant/attribution, normalizes exact
money, inserts the cost event, writes audit evidence and registers durable budget
work. It neither updates shared totals nor evaluates policies.

Preserve `(companyId, idempotencyKey)`, immutable receipt fingerprints and existing
legacy-hash replay compatibility. Replace read-then-insert reliance on the mutex
with conflict-safe insertion followed by comparison with the committed winner.
Equal evidence is replay; conflicting evidence is an explicit conflict. Only the
winner emits the charge/audit effects. Uncertain commit acknowledgement is safe
to retry with the same identity.

Each owner uses an ordinary transaction to:

1. Arbitrate its own operation row and recheck current accounting evidence.
2. Insert/reuse all qualified ledger parts through the common helper.
3. Replace that operation's live exposure/hold with its ledger contribution.
4. Record its acknowledgement and durable follow-up work, plus finance/audit
   records required by that owner.
5. Commit, then publish existing post-commit activities and delete any acknowledged
   receipt spool files.

All five steps roll back together on failure. Provider requests, provider polling,
filesystem reads and unrelated reconciliation stay outside the database transaction.
Keep provider-specific receipts, result handling and retries in their services;
do not create a generic helper that switches on arbitrary invocation tables.

Use the existing `cost_adjustments` mechanism for later authoritative valuation:
extract an event-scoped transactional correction core shared by invoice/manual
correction and verified late receipt handling. Preserve the original reported
amount/fingerprint, expected-value checks, correction provenance and idempotency.
Correction commits its owner's hold/evidence transition and budget work together.
No second charge is created for the same paid attempt.

Use one audited lock order across settlement and manual/late correction:
attribution issue/FK protection, owner row, existing ledger/correction targets,
then own reservation. Discover candidate attribution without locks and revalidate
it after acquiring the owner fence. Update the existing invoice correction's
ledger-first ordering when it also touches owner state; do not create an inversion.

### 2. Remove hidden company and agent counter writes

Stop monthly increments/reinitialization in `updateMonthlySpendProjections` for
every financial writer, including direct cost reporting and billing corrections.
Company/agent API hydration already aggregates the ledger; reuse bounded, batched
ledger reads. Monthly UTC windows and backdated adjustments then follow ledger
dates without a shared rollover initialization write.

Migrate direct raw-counter budget consumers in `email-channels.ts`,
`external-agents/dot.ts`, `muse.ts`, `native-broker.ts` and
`native-runtime/paperclip-runner-tool-authority.ts`. Budget authority comes from
the shared eligibility contract; display totals come from ledger aggregation.
Audit all other readers before retiring fields. Keep old columns temporarily
for migration compatibility, but make them non-authoritative.

Remove lifetime money/token increments from run settlement, late cost reporting
and billing reconciliation. Reuse the existing accounting-integrity formula:
`accounting_runtime_baselines + ledger for acknowledged v2/new-version runs`.
Hydrate public runtime-state reads, leaving frequent internal session/control
reads cheap. Preserve historical v2 contributions and existing baselines;
initialize missing baselines once under the old writer fence/drain with an
explicit reconciliation, never by adding the same historical ledger twice.
Do not use an ID/time cutoff as a commit-order boundary. Preserve exact arithmetic
until existing API serialization boundaries.

Update integrity inspection/repair to validate canonical receipts, acknowledgements,
baselines and ledger valuation. It must not flag intentionally retired counters
as corruption or write them back into authority. If read aggregation later needs
a materialized view, batch it off the settlement path; no per-charge company or
agent accumulator is part of this milestone.

### 3. Coalesced budget decisions with durable, independent inputs

Extend the existing budget worker/coordinator, not a new queue service. Add one
durable evaluation-work feed with independent rows for committed changes:
company, operation/source identity, input revision or event identity, affected
scope attribution, server enqueue time and pending/consumed state. Enforce logical
identity with a unique index and index pending work/oldest age by company/scope.
Settlements append their own rows; they never upsert one company dirty flag.

Cover *all* exposure producers: admissions/reservations, live usage, terminal
settlement, zero-charge releases, unknown outcomes, source handoffs/capture
failures, browser holds, direct charges, corrections, policy edits and UTC-window
transitions. A replay with no state change does not manufacture more work.

The evaluator coalesces committed inputs by affected scope. In one repeatable-read
snapshot, select explicit pending IDs and read policy configuration/decision and
manual-control versions plus ledger, observations, reservations and browser exposure using
`budget-exposure.ts`. A settlement is visible entirely before or after its atomic
hold-to-ledger handoff, so it cannot be omitted or counted twice. Initially reuse
the existing batched exposure queries; add partitioned totals only if measured
batch cost requires them. Use one fixed evaluation time/window for that snapshot.

Publish through a short transaction conditional on the captured policy,
decision and manual-control versions and the still-applicable window. A losing
evaluator recomputes from a new snapshot; it cannot
attach a fresh version to stale totals. Commit the winning decision, incident/
hold transition, idempotent durable stop intent and consumption of only the
selected inputs together. Consume an input only when every affected scope is
covered; if batches split scopes, retain per-scope acknowledgement. Include both
old and new attribution when a mutation changes scope. Policy edits invalidate
old decisions. New or late-committing inputs stay pending; never acknowledge
`MAX(id)`, sequence or time.
If no policy applies, consume that work; policy creation emits a fresh obligation.
Resume requires agreement of all applicable policies and the current manual-
control generation, not merely one policy dropping below its limit.

Admissions read current controls and applicable decisions from an authoritative
consistent snapshot, then write only their own invocation/reservation. They do
not reserve/decrement shared capacity or synchronously reconcile policy state.
Estimate-fit checks are advisory observations. Missing decisions or unresolved
unpriced work are not implicitly unlimited. Manual pause/Stop, permissions,
dispatch identity and lifecycle fences remain final admission gates. Preserve
provider caps where supported and agent-deletion fencing around new holds.

Proposed healthy-load settings, to qualify: about one-second coalescing, p99
priced-change commit to durable stop intent at most five seconds, and refusal
of new limited-budget paid work when relevant unevaluated changes exceed fifteen
seconds. Measure oldest applicable unevaluated-input age; do not refresh freshness
merely because a worker woke. Successful evaluation of unknown/capture-failed
evidence can consume its input while retaining a durable uncertainty/block state
and source recovery obligation. Unknown billing age is separate from evaluator
lag; unchanged uncertainty must not keep an empty evaluation loop running. An
unchanged idle decision does not expire. Policy edits and window changes create
real new obligations.
Provider reporting/cancellation delays and already in-flight spending are extra;
these targets do not bound billed-dollar overshoot. Receipt acceptance continues
while admission is blocked.

Use transaction-aware `notifyDeliveryWork` before the relevant write. Durable
rows are truth; notifications are hints. Startup/resume and reconnect reconstruct
pending work, and changes during a batch/drain remain discoverable. Use bounded
batches/retries and actual scheduler deadlines. Once settled, no recurring empty
SQL scan remains. Qualify cross-process delivery before supporting multiple
controllers; preserve existing sleep blockers until durable external wake is
proven. Cancellation delivery stays scoped, idempotent and recoverable; budget
resume cannot clear a manual hold or retract an already committed per-run Stop.

## The five owner refactors

### Run settlement: `accountRunCost`

- Replace the company wrapper with a run-scoped transaction; preserve issue/FK
  lifecycle protection and the existing run-row arbitration order.
- Give usage receipt persistence a caller-transaction primitive so finalization
  never enters a nested company wrapper. Migrate live receipts, source handoff
  and capture-failure writers to the same run-local evidence contract.
- Capture a durable closed-source/final-receipt identity before reading receipt
  files outside the transaction. Under the run fence, revalidate that closure,
  source and accepted final identity; retry if they changed. A pre-read directory
  scan is not proof the producer finished. Delete only acknowledged files after
  commit. Genuinely late post-ack evidence must create a correction/uncertainty
  obligation; the current journal-and-return behavior is insufficient.
- Preserve native closure, final-usage completeness, dispatch provenance and
  capture-failure checks. A terminal runtime status alone is not accounting
  closure. Accounting-only late receipt authority never authorizes execution.
- Atomically write all model parts with existing stable keys/order, settle or
  release the run's reservation, replace running exposure and acknowledge the
  run. Keep operator retry and background reconciliation on this same function.
- Remove agent runtime increments; mark the run for the baseline-plus-ledger read
  contract instead. Test final receipt versus live checkpoint/recovery in both
  orders, missing closure, multi-model replay and commit-before-file-delete crash.

### Decision-model settlement: `settle`

- Keep invocation-scoped arbitration and `decision:<id>` identity; atomically
  commit result/accounting metadata, cost link and own reservation transition.
- Preserve registered-feature authorization, background sponsorship and archival
  dispatch attribution; this independent charge has no heartbeat ledger link.
  Do not store prompts/answers to obtain billing evidence.
- Persist normalized billing evidence promptly after provider completion and
  retry persistence with the same invocation identity, without calling the
  provider again. A crash with no recoverable receipt remains explicitly unknown.
- Make interrupted/unknown closure provisional for billing: later authoritative
  evidence corrects the same event through the audited correction core. Racing
  recovery cannot discard a real price because the result status is terminal.
- Test duplicate workers, priced failure, unpriced success, no-provider-work
  release, late price after recovery and deletion of linked task/project.

### Prompt-classifier settlement: `settle`

- Use invocation-scoped arbitration and `prompt-injection:<id>` with the same
  exact ledger/reservation contract and provisional-unknown correction behavior.
- Keep classifier verdict, attribution and billing certainty separate. A failed
  or invalid classification can still cost money; an unpriced receipt does not
  become a safe/unsafe verdict.
- Preserve the order that commits incurred charge before propagating caller
  cancellation. Recovery and abort cannot release a hold as zero-work unless
  provider work is proven absent.
- Test abort during provider completion, recovery racing a priced result, verdict
  behavior when accounting retries, and idempotent hold resolution.

### Fast-response settlement: `settle`

- Use request-scoped arbitration and `fast-response:<id>`; explicitly include
  `companyId` in claim/settlement predicates. Keep cost, terminal metadata and
  reservation changes in one accounting transaction.
- Preserve the existing independent acknowledgement publication transaction:
  publication precedes accounting and never waits for budget evaluation. Retain
  source-current, expiry, disable and superseding-real-reply checks.
- An obsolete or suppressed reply can still have incurred a charge. Recover
  unknown billing and late prices without republishing or rerunning the provider.
- Test expiry/disable/real-reply races, slow accounting after publication, two
  recovery workers, publication success with lost accounting acknowledgement,
  and late authoritative receipt after interrupted recovery.

### Browser settlement: `account`

- Keep provider terminal summary I/O outside the transaction. Arbitrate only the
  browser-run row, not its whole company or session.
- Persist normalized observed summary evidence before settlement with a stable
  receipt/occurrence time and captured attribution; retries must not move spend
  across UTC windows by using a new `now`. The provider currently exposes no
  billing revision/finality marker: a valid priced terminal summary settles the
  known amount without claiming it can never change. Keep stream-drained status
  separate from billing certainty; qualify late receipt/recovery ingress and
  never keep polling completed work without an unresolved duty.
- Store exact accounted amount and normalized billing-evidence state in typed
  accounting fields instead of relying on the integer display field/private
  result JSON. Preserve backward reads while backfilling existing exact values.
- Validate the provider-run/invocation identity. Atomically advance its exact
  cumulative amount, insert only the qualified positive delta, link the finance
  event, replace its hold, record events-drained evidence and append budget work.
  Replays/stale lower snapshots add no charge; a proven authoritative reduction
  uses audited correction, never silently rewinds the total.
- Unknown POST outcomes/uncapped work remain unknown until proven. Keep provider
  caps as dispatch controls; never clip the recorded bill to a configured cap.
- Fence stale session-sweeper/cursor writes by existing lease token/version;
  financial correctness rests on run identity and unique evidence, not the session
  lease. Test two reconcilers, cumulative growth, duplicate/lower summaries,
  correction, lost commit acknowledgement, unknown POST and month rollover.

For all three AI services: proven no-provider-work releases its hold; a priced
outcome settles it; an unpriced outcome retains uncertainty until correction.
Result success/failure and billing certainty are independent dimensions.

## Delivery and compatibility

Prepare a reviewable prerequisite stack, keeping proof with each change:

1. Ledger-only append/correction primitives and owner-tagged observability,
   initially behind the existing company wrappers. Compatibility callers retain
   old projection/evaluation orchestration outside the new primitive. Test
   conflict/replay and transaction atomicity without changing budget authority.
2. Retire monthly/runtime counter writes and migrate every reader/repair path.
   Reconcile baselines and reports before enabling subsequent writers.
3. Install the durable input feed, fenced evaluator and read-only best-effort
   admission contract across every producer/consumer. Existing settlement wrappers
   can remain briefly, but no writer relies on them for aggregate consistency.
   Keep synchronous evaluation authoritative until the new feed is caught up;
   the shadow evaluator must not publish competing holds/Stops. Under the drain,
   switch to one fenced evaluator/admission authority before unlocking a writer.
   Update `doc/SPEC-implementation.md`, relevant product/API budget wording and
   tests to remove the strict concurrent-capacity guarantee explicitly.

These together form the **compatibility floor**. Deploy it everywhere and drain
old controllers/workers and in-flight database transactions before unlocking a
path. External paid work may finish later through the compatible receipt path.
Old binaries cannot coexist with unlocked writers: their multi-query exposure
reads and unfenced budget transitions assumed the mutex isolated all writers.
Do not mix old counter increments with asynchronous absolute recomputation.

Then ship one owner change per PR: decision model first as the smallest exemplar,
followed by classifier, fast response, browser and run accounting. The latter
four may be developed independently on the shared floor. Include companion
admission/recheck/release/recovery entry points in the owning PR, not just the
visible settlement callback. In particular audit `reserveRunBudget`, browser
before-dispatch/rejected/unknown/stale-creating paths, usage receipts, direct
costs, billing reconciliation and budget startup/rollover/stop delivery.

Rollback after unlock returns to a compatible version that retains the new
ledger/evaluation contract, optionally re-enabling a wrapper. A pre-floor binary
is not a safe rollback. Keep additive fields and old read compatibility through
the rollout; remove obsolete helpers/columns only after all five migrate.

## Acceptance

- **Real PostgreSQL concurrency:** hold the company row `FOR NO KEY UPDATE` on
  connection A. Every path must settle on B before A releases it. Repeat while
  holding an agent row and a budget-policy row. This catches hidden shared writes.
  Do not use company `FOR UPDATE` for this test: legitimate FK key-share checks
  conflict with deletion/key-changing locks.
- **Operation isolation:** hold operation A's row; operation B in the same company
  and agent still settles. Duplicate A produces one effective charge, finance
  link, acknowledgement and reservation transition. Inject rollback at ledger /
  owner / hold / work-feed boundaries and replay a lost commit acknowledgement.
- **Accounting correctness:** exercise the owner cases above, correction versus
  settlement, exact fractional money, unknown evidence, multi-model identity,
  invoice adjustment, UTC rollover and historical baselines. No lost money,
  double-counted exposure or discarded authoritative late price.
- **Best-effort controls:** simultaneous admissions may oversubscribe an observed
  balance and must retain all obligations. A visible block/manual Stop still
  denies new work. Test policy edits racing evaluation, old/new evaluators,
  stale-view refusal, lifecycle deletion and durable scoped cancellation.
- **Recovery/quiet:** committed late inputs survive a batch, rollback, restart,
  reconnect and drain/resume; a lower allocated ID that commits later is found.
  No recurring SQL/network after completion. Real cross-process wake remains a
  separate acceptance claim from in-process coordinator tests.
- **Performance:** benchmark pinned baseline/treatment on real PostgreSQL with
  concurrent same-company/same-agent paid operations plus foreground requests.
  Match workload/policies/history/resources; report completed work, errors,
  settlement/admission/request p95/p99, queries per operation, database wait/hold
  evidence, evaluator backlog/stop lag, process CPU and event-loop delay.
  Add closed owner tags (`run`, `decision`, `classifier`, `fast_response`,
  `browser`) to existing operator-gated OpenTelemetry spans; include replay and
  outcome categories without prompts/receipts/credentials. New spans or reduced
  counts alone do not establish a speedup.

Use the smallest existing owner tests during development, real PostgreSQL for lock
proof, then required repository typecheck/tests/build and final-head PR checks.
Hosted acceptance confirms the serving revision and matched ordinary workload;
report lock removal, useful latency improvement and CPU/resource improvement as
separate findings. No live profiling or infrastructure change is required to
approve this plan.

## Implementation record

The candidate removes the company accounting wrapper from all five settlement
owners and their paid admission/recovery companions. Shared counter writes are
retired. Durable per-change budget inputs and coalesced fenced evaluation replace
synchronous policy evaluation. Exposure aggregates use one SQL statement, so
READ COMMITTED callers also observe the complete hold-to-ledger handoff.

Publication attempts use nonwaiting scope-row guards after the policy fence.
A conflicting existing control writer causes rollback/retry, rather than a
policy/resource lock inversion. New-policy edits leave durable inputs even when
a prior no-policy batch consumed their concurrent charge. Public report reads
create a fresh snapshot per call. UTC publication guards retain work on rollback.

Implementation delivery uses one coherent protocol-change PR, with separate
logical commits for the shared foundation and each owner. This replaces the
initial per-owner PR recommendation: ledger helper behavior, retired counters,
receipt recovery and budget authority must cut over together. Independent owner
commits remain inspectable. Deployment still requires draining incompatible
pre-upgrade controllers; this document does not authorize or certify deployment.

Targeted real PostgreSQL evidence includes all five shared-row blocker cases,
replay/rollback, late receipt recovery, scoped control publication and UTC
rollover. The browser source at the pinned baseline times out after three
seconds with the company row held; the candidate completes while the same locks
remain held (95 ms total test including fixture/assertions). This proves removal
of that serialization mechanism, not a hosted latency or CPU gain.

Late receipts preserve original monetary and usage evidence while audited
corrections update effective ledger tokens/provider request lookup as well as
price. Independent ambiguous run receipts retain independent debt. Browser
cumulative growth uses its own persisted occurrence time; retrying the same
receipt retains that time. Rare invoice import retains its old serialized
wrapper for cross-invoice finance deduplication; it is outside the five paid
settlement paths and does not block their ledger commits.
