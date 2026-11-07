# Approved tool-action recovery

Approved tool actions recover at startup and after committed review changes.
The aggregate maintenance tick no longer scans approved requests. The existing
request and invocation rows remain authoritative; this change adds no queue table.

## Work and quiet states

The gateway owns the approved-work predicate. A signed agent action with
`executionOnApprove: true` owes execution through the normal approval path.
A legacy signed action without that flag remains deliberately inert. A Test-tab
approval can owe execution even when no agent run exists. Recovery uses the saved
origin and current authorization/target checks; the scheduler sees only whether
another attempt is needed.

Startup discovers companies with saved approved requests. Committed review
signals carry the affected company ID; subsequent discovery and recovery reads
filter by that company. The shared scoped worker coalesces changes and dispatches
one company per pass with a one-second minimum spacing. A company writing reviews
does not scan or lock another company's approved backlog.

Recovery pages that company's approved requests in ID order using a partial index. It does not
let a full batch of unavailable approvals starve later work. A failed read or
unresolved executable approval retains a 30-second retry. New writes preserve
that company's retry deadline, while other companies can run independently.
A company pass still drains all its pages; this change does not cap provider
calls within that pass or alter the provider's existing execution timeout. Once a pass leaves no
such obligation, there is no recurring approved-recovery query. An empty system,
configured idle tools, completed history, and deliberately inert approvals are
quiet after reconciliation.

## Producer and transaction ownership

The existing tool-review notification boundary now signals both pending expiry
and approved recovery. This covers human review transactions, gateway approval
and accepted-interaction inference, administrative interaction resolution, review
queue invalidation, and the gateway's approval claims and managed-argument
invalidation. The notification is awaited before SQL in the existing transaction;
caller-owned outer transactions retain commit/rollback ownership.

A pending-only change can cause one empty company-scoped discovery read. It does not
create a periodic scan. No per-route recovery bookkeeping or database listener
is added. Signals use the existing database owner's single-active-writer model.
Independent SQL writers or another process need a separate notification contract.

## Single execution and outcome ownership

Agent actions retain their existing approved-to-executing claim. Test-tab
foreground approval and recovery now share an equivalent claim before provider
dispatch. The invocation then starts only if the request still holds that claim.
Provider calls and target discovery remain outside SQL transactions. Current rate-policy admission and its receipt commit together in a short database transaction.

The Test-tab invocation outcome and terminal request status commit together.
Claim timestamps fence late settlement. A later audit failure cannot overwrite
an already committed outcome. Recovery repairs legacy approved Test-tab requests
from a saved terminal invocation without decoding old arguments or calling the
provider. A legacy executing invocation moves to the existing interrupted-work
path; it is not dispatched again.

If the provider may have run but its result cannot be persisted, the executing
claim remains authoritative. The existing stale-execution recovery quarantines
unknown outcomes. This slice does not promise exactly-once external effects or
replay an uncertain provider call.

## Lifecycle and remaining duties

The shared deadline worker coalesces notifications, preserves changes during a
pass, and retains skipped work across idle drain/resume. Startup reconstructs
saved approvals. Company deletion invalidates cached recovery and retries through
the same transactional notification boundary. Shutdown stops its coordinator registration. With heartbeat
scheduling disabled, startup keeps the existing one-off recovery behavior.

Pending expiry is owned by the preceding slice. Interrupted execution and
interaction projection repair remain in the old sweep until their own migrations.
The public combined sweep retains all duties for manual/recovery callers.
No Cloud eligibility or external-wake proof changes here; worker quiet does not
establish deployed database or host suspension.

## Verification

Real PostgreSQL service/startup tests cover producer commit and rollback,
startup reconstruction, empty/configured/history quiet states, concrete retries,
first-write drain/resume, legacy inert approvals, and multi-page recovery.
Controlled Test-tab provider tests cover both foreground/recovery race winners,
completed legacy outcomes, interrupted legacy calls, target changes, and a failed
atomic outcome write followed by quarantine without another provider call.

The service/startup selection passes 123 tests. The existing gateway acceptance
suite passes 92 tests. The strengthened paging and outcome-failure cases pass
again after their final edits. Workspace typecheck and build pass. Full CI and
review remain separate PR gates; no real external provider was invoked by these
fixtures.

Review found that a one-shot success-write failure could fall into the provider
error handler and save a false failure on its second attempt. The added sequence-
based PostgreSQL fault reproduces that bug before the fix. Provider execution,
pre-dispatch validation, and outcome persistence now have separate error
boundaries. Both persistent and one-shot result-write failures retain the claim
for quarantine without repeating the call. The complete 123-test selection and
92 gateway acceptance cases pass after the repair, as do typecheck and build.

The existing tool-access service regression now expects a completed Test-tab
request to be executed and verifies exactly one provider call before asking for
a new approval. Its full 469-test suite passes. The initial local command skipped
its database cases; the suite now honors its supplied disposable database through
the standard test-database guard independently of embedded Postgres support.

Company-scoping regression: a real signed/reviewed action in company A previously
caused an unfiltered approved-request SELECT over company B's inert legacy action.
The captured-SQL test fails before this repair and passes with scoped reads. Added
lifecycle cases check retry preservation across committed writes, independent
company progress, and disarming after the real company-deletion producer. These
checks supplement the earlier execution, transaction, and paging evidence above.

After company scoping, the complete gateway-service and startup selection passes
149 tests against a disposable PostgreSQL database, and server typecheck passes.
Stack integration, workspace checks, and fresh remote CI remain separate gates.

## Preparation failures retain an approved Test-tab action

A real PostgreSQL policy-read timeout reproduced a permanent-failure bug after
claiming a Test-tab action: the provider had never been called, but both request
and invocation were saved as failed, so approved recovery could not retry them.

The preparation boundary now distinguishes explicit validation/access rejections
from unexpected dependency errors and transient HTTP errors. The existing
`tool-approval-execution` owner releases only its exact claim: invocation and request
are locked in the established order, their link/company/claim timestamp must
match, and the invocation must still await approval with no recorded start.
The request returns to `approved` with a transaction-aware notification. Signed
arguments and the human approval remain unchanged; the error propagates so the
existing recovery worker retains its retry obligation.

This boundary ends before `runTestToolInvocation`. Provider dispatch and outcome
persistence keep their existing conservative no-replay behavior. A changed claim,
started invocation or prior-dispatch evidence cannot be released by this path.
If the requeue transaction itself fails, the error propagates and no terminal
failure is fabricated; existing interrupted-execution reconciliation remains the
fallback. This change does not infer replay safety from a failed requeue.

Before the fix, both foreground and recovery timeout regressions failed. They
now observe the committed claim under a real PostgreSQL table lock, wait for
`55P03`, verify unchanged approval and no provider call, then prove automatic
recovery invokes the provider once and becomes quiet. Additional real-row cases
cover changed ownership, mismatched invocation, a started call, prior-dispatch
history, and outer-transaction rollback. A released claim cannot start execution.
All 117 gateway-service cases pass on the owning slice, including existing target
invalidation, provider-outcome persistence failures and unknown-outcome no-replay
cases. Integrated consumer checks, workspace verification and remote PR gates
must still be recorded after propagation.


## Agent-origin preparation and dispatch ownership

Agent-origin approvals use the same pre-dispatch retry contract as Test-tab
approvals. Previously, a policy or identity dependency failure after claiming an
approved action permanently failed it; earlier issue/signing failures could
leave the claim executing. Preparation now has one owning error boundary around
issue, signature, identity, target, policy, managed-argument, and content checks.
Validation and nontransient access rejections retain their terminal handling.
Unexpected dependency failures and transient HTTP errors release only the exact,
still-undispatched claim to the existing approved queue and publish its existing
transactional work signal. No table, maintenance scan, or retry wrapper per
producer is added.

`tool-approval-execution.ts` owns the shared claim token, release, and dispatch
transition. Its Test-tab claim/outcome functions remain specific to that consumer.
Both origins use the same invocation-then-request locks and verify invocation,
company, request linkage, claim timestamp, awaiting-approval state, and absence
of an earlier start before dispatch. An agent that loses its claim during
preparation cannot call the provider or overwrite its successor. The Test-tab
unapproved direct-call path retains its original behavior.

Only preparation is retryable here. Recording the invocation start, provider
execution, and outcome persistence remain outside that catch. A provider error,
unknown outcome, or failed durable release does not establish replay safety.
Existing interruption handling remains the conservative fallback. Closed-issue
expiry, signature/target invalidation, identity authority, and policy rejection
remain enforced, including the final issue check before recording dispatch.

Real PostgreSQL lock-timeout cases cover foreground approval and recovery:
observe the committed executing claim, block the policy read, then require the
same signed request to remain approved with no invocation start and zero provider
calls. Recovery after releasing the table lock executes once and becomes quiet.
A separate contention case replaces the claim while preparation is blocked and
proves the old owner cannot dispatch; the surviving approval later executes once.
A provider-error case proves that an already-started call is not requeued as a
preparation failure. The existing Test-tab timeout and ownership cases exercise
the other consumer of the shared boundary.


## New or edited rate rules during approval

A reviewed invocation already has durable `consumedRateAdmissions` in its policy
explanation. The original read-only recheck retained unchanged rules correctly,
but new or edited rules only inspected their counters. Two approved actions could
therefore both execute against one available slot. The real recovery regression
failed for both a newly added limit and an increased limit before this repair.

The policy service now owns `admitInvocation`: lock the company-scoped invocation,
validate its exact actor/task/tool/argument binding, recheck current policy, spend
only admissions not already recorded for that policy generation, and save the
receipt atomically. The gateway supplies its execution claim; that claim is locked
and checked by ID, invocation, company, executing status and timestamp. This also
supports historical approved requests whose invocation still says pending, without
accepting a stale claimant. Existing claim/start/settlement owners still control
provider execution. No queue table, periodic query, or per-route wrapper is added.

Counter updates preserve the number of already spent slots when the limit changes.
A rejection by a later policy or failure to save the receipt rolls back new charges.
A retry of a committed admission retains the saved receipt, including concurrent
rechecks. Read-only approval preflight and browser authority probes stay read-only;
trust-rule usage is not counted again during execution revalidation. The policy
service and its metric helper accept only the database capabilities they use, so
transaction clients do not require a cast to a root connection.

The owning gateway and policy suites pass all 181 cases against disposable real
PostgreSQL databases. Coverage includes two competing invocations, concurrent
retries of one invocation, changed limits, failed receipt writes, rejection after
an earlier rate charge, unchanged admissions, historical approvals, scope mismatch,
claim loss, quiet recovery and unknown provider outcomes. Server typechecking
passes after preparing current runner dependencies.

Earlier verification failures remain part of this evidence: the first full run
was stopped because an old claim-loss fixture held the policy table while trying
to revoke the newly locked invocation. It now pauses discovery before admission
and retains the no-provider-dispatch assertion. A new receipt assertion was fixed
to permit the intended additional receipt while preserving original fields. The
next full run exposed an overly strict historical-approval check; exact execution-
claim validation fixed it. Typechecking then exposed root-client-only signatures,
which were narrowed to their actual database capabilities. The final complete
suites and TypeScript check pass; stack integration and current-head CI remain
separate gates. This proves worker and admission behavior, not deployed host sleep.


## Managed-argument expiry ordering

Latest-head CI exposed a preparation-order regression in
`tool-gateway.test.ts`: a valid historical Shopify approval whose managed UCP
arguments were obsolete became `failed` instead of `expired`. The new consuming
admission compared the current invocation identity before the existing managed
argument expiry owner ran. It prevented dispatch, but bypassed the correct saved
expiry outcome.

Approved execution now verifies target/signed/managed arguments and content
before consuming admission. Exact claim fencing, fresh policy checks, atomic
rate receipts, and the final issue-open check remain before dispatch. No check
was removed and stale payloads are not permitted to execute.

The existing regression reproduced the CI failure on this owner in
`/tmp/sleep-approved-managed-expiry-red.log`. All 92 gateway acceptance cases
pass after the ordering change (`/tmp/sleep-approved-managed-expiry-full.log`),
including the historical approval's expired request, failed invocation with
`approvalState: expired`, and zero provider requests. Server typecheck passes
in `/tmp/sleep-approved-managed-expiry-types.log`. Latest-head remote CI and
combined-stack acceptance still need their own results.

## Delegated Test-tab admission after policy changes

A delegated Test-tab call has an originating agent but no gateway token. The
named-gateway admission path therefore did not evaluate its caller policy. If a
rate rule was added while approval was pending, approval charged only the target.
A shared company/tool bucket then rejected the caller against that same charge;
a caller-specific rule instead allowed execution without recording its charge.

The Test-tab owner now supplies its caller/target policy evaluation to the existing
claim-transaction admission API. Both decisions use the claimed invocation's
receipts. The target can share the caller's charge only when the rule and bucket
match. Both receipts commit together. A denial rolls back new charges and receipts.
Management reauthorization and credential identity checks remain with their owners,
and provider execution stays outside the transaction. This adds no queue or timer.

Three actual HTTP/PostgreSQL cases cover a newly added shared rate rule, separate
caller and target rules, and a target denial after caller admission. The unchanged
implementation failed the first two cases: the shared rule rejected execution,
and separate rules left only one charge. The denial case already passed. After
the repair, all three pass, including duplicate approval, both saved receipts,
one provider execution, and rejection of a subsequent authorized call.

The full connection-management suite passes all 78 cases against a fresh database.
All 92 existing gateway tests and the server production typecheck also pass.
Intermediate fixture failures remain accounted for: the new assertion initially
used a nonexistent counter count field instead of remaining; the subsequent-call
fixture first reused an ended run and then lacked responsible-user authority.
The final fixture uses a new live run with the original responsible user. A reused
full-suite database also retained a conflicting Slack bot identity; final acceptance
uses a fresh isolated database. These are local checks, not current-head CI or a
host-suspension qualification.


## Historical argument identity compatibility repair

Earlier invocations stored the hash of their redacted argument preview. Modern
admission correctly requires the complete request identity, including a keyed hash
for sensitive arguments. The gateway already verified signed historical arguments,
but admission rejected their saved preview hash even with no rate policy. That
permanently failed an otherwise valid approval before the provider call.

Both agent-origin and Test-tab preparation now bind the verified complete identity
for a historical invocation before current policy admission. Signature, reviewed
target and managed-argument checks still run first. The approval execution owner
performs the identity transition in an invocation-then-request lock transaction.
It requires the exact current claim, company and invocation relationship, an
undispatched awaiting-approval invocation, and the expected reviewed/preview hash.
Unrelated saved hashes are not accepted. Modern matching identities do not add
this transaction. Current policies and rate charges still apply afterward.

Four real-PostgreSQL regressions reproduced the defect: valid sensitive historical
arguments, with and without a newly configured rate rule, through each of the two
origins. Four controls keep invalid signatures and unrelated invocation hashes
rejected without dispatch or identity changes. The provider receives the original
verified arguments exactly once, rather than their redacted preview. A separate
real-transaction case proves a replaced claim cannot change the saved identity.

The first draft fixtures used a nonexistent request-level tool name and then
non-sensitive arguments whose preview and complete hashes were equal. Those
fixture failures are not credited as product regressions. The corrected four
positive cases fail before the repair and all eight parameter cases pass after.
The complete gateway, policy and startup selection passes 230 cases with no skips;
server types pass. The complete assembled-server connection-management suite also
passes all 78 cases, including delegated approval and rate-policy behavior. Fresh
remote CI and reviews remain required after publication.


The repair was then integrated with the master-based parent, including #17918's
tracing changes, at `81231824d773a79fc50c835eccf7d9b3977e79fc`. Server types and the
production server build pass. The gateway, policy, startup and preparation-timing
suites pass all 242 cases. The complete HTTP management suite passes all 78 cases
on a fresh dedicated database, for 320 passing cases across the accepted runs.

The first combined integrated run passed 319 cases and failed the Slack setup
case because its reused HTTP database still held the previous run's bot identity.
The existing ownership guard correctly rejected the duplicate connection. A fresh
dedicated fixture resolved that environment collision; no product behavior or
assertion changed for the rerun. That failed run remains part of the evidence.


## Gateway admission uses its transaction connection

Review of the master-targeted branch exposed a delegated gateway deadlock: the
admission transaction held the sole pool connection while issuer/token authority
reads used the root client. Foreground approval and approved recovery each failed
the real one-connection regression; a revoked-issuer control already passed.
The admission callback now receives its transaction and passes it through the
existing issuer authority checks. Both connection authorization checks and the
token read use that connection. Ordinary checks retain their root client, and
current authority, claim, company and rate enforcement remain in place.
The three constrained-pool cases pass, as do all 81 HTTP integration cases and
190 gateway, policy, startup and deadline consumer cases. The initial consumer
command selected an incorrect policy filename and omitted the gateway database
override; it was interrupted and is not counted as passing evidence.

## Pending historical approvals retain their original admission

A second review finding concerned the normal foreground approval gate, before
execution has claimed and rebound historical arguments. A real PostgreSQL
regression with signed sensitive arguments and an already-consumed limit of one
failed with `rate_limited`; the Test-tab and invalid-signature controls passed.
The gateway now supplies the preview digest only after verifying the signed
payload and matching either supported form of the review's canonical digest. Policy may match that digest
only in a read-only preflight, with every other invocation-context field and
stored rate-rule receipt still checked. The consuming admission continues to
require the complete keyed identity, rebound under the exact execution claim.
New or changed rate rules still apply. Historical recovery, invalid signatures,
foreign invocation hashes, stale claims, and provider argument preservation stay
covered. This adds no schema, recurring query or additional connection.

The preceding CI head also failed E2E shard 3/8. Its failure is retained in the
validation record; local gateway checks do not erase it. Fresh-head CI and both
required automated reviews remain merge gates.

The five full gateway/policy/startup/deadline suites passed 329 cases before the
additional mixed historical identity control. The first combined attempt is
retained: a Test-tab failure-result assertion incorrectly expected a thrown
error, and reusing the earlier HTTP database left formal-approval foreign keys
that prevented gateway acceptance setup. The assertion now checks the existing
failed-result contract, with unchanged no-provider, hash and counter checks;
the complete acceptance rerun used an independently migrated gateway database.
Server production typechecking and build passed. The earlier E2E failure was a
500 during the agent-chat project-plan fixture restoration, with a PostgreSQL
deadlock in cancellation; it remains a fresh-head CI gate.
