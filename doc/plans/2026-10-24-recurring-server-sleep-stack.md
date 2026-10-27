# Recurring server work migration stack

Baseline: `785d54636e1c8513ee5503d602daf6a5ee1970d6` (2026-10-24).

The requested outcome is a reviewed PR stack for every remaining recurring server
work item below. A PR owns one reason for background activity. Split compound
items into separate PRs as their producer and lifecycle audits identify distinct
owners. Each PR includes behavior, producer audit, tests, and documentation.
Do not mark an item done from a timer removal or a green check alone.

## Scope and completion ledger

| ID | Original checklist duty | Required slices / disposition | PR / evidence |
| --- | --- | --- | --- |
| 01 | Custom-image setup expiry | Session writes, existing expiry, startup/retry/drain | [#17443](https://github.com/paperclipai/paperclip/pull/17443), merged after CI and passing reviews |
| 02 | Remaining chat maintenance | Provider runtime discovery; voice reconciliation; milestones; wake notices; interaction continuations; terminal confirmations; GitHub recovery; Teams maintenance, separately by owner | Pending |
| 03 | Run and task recovery | Orphan runs and active leases; shutdown workspace settlement; scheduled retries; queued runs; stranded assignments; resolved dependencies; task watchdogs; silent-run monitoring; stale locks | Pending |
| 04 | Decision retention and notifications | Retention deadlines and notification delivery are separate reasons | Retention pending; archive delivery [#17475](https://github.com/paperclipai/paperclip/pull/17475) merged after exact-head 5/5 reviews and passing current CI |
| 05 | Decision expiry and interrupted effects | Expiry, effect recovery, continuation recovery | Continuations [#17478](https://github.com/paperclipai/paperclip/pull/17478) merged; expiry [#17479](https://github.com/paperclipai/paperclip/pull/17479) merged; effects [#17482](https://github.com/paperclipai/paperclip/pull/17482), and targets [#17486](https://github.com/paperclipai/paperclip/pull/17486) await current-head review/CI gates |


| 06 | Tool connection health | Configuration/use activation and defined proactive health deadlines | Pending |
| 07 | Secret proposals, tool reviews, gateway tokens | Separate expiry/scrub/recovery owners | Slices 02–07 merged: [secret proposals](https://github.com/paperclipai/paperclip/pull/17446), [credentials](https://github.com/paperclipai/paperclip/pull/17450), [review expiry](https://github.com/paperclipai/paperclip/pull/17453), [approved recovery](https://github.com/paperclipai/paperclip/pull/17454), [interrupted claims](https://github.com/paperclipai/paperclip/pull/17458), [projection](https://github.com/paperclipai/paperclip/pull/17468) |

| 08 | GitHub connection events and continuity | Event discovery/replay and credential continuity separately | Pending |
| 09 | Merged-PR confirmations | Candidate writes, webhook activation where supported, outstanding-candidate fallback | Pending |
| 10 | External-object refresh | Configuration changes, refresh deadlines, source events | Pending |
| 11 | Status-card evaluation | Settings/card mutations and evaluation deadlines | Pending |
| 12 | Plugin scheduled jobs | Registration/update/removal and actual job deadlines | Pending |
| 13 | Routine, agent-timer and issue-monitor scheduling | Remove periodic wake backstops after complete producer coverage; routine execution-status reconciliation separately | Pending |
| 14 | Skill-version retention and native-harness backup expiration | Separate retention owners and existing retention guarantees | Pending |
| 15 | Automatic database backups | Shared scheduling, actual backup deadlines, existing checkpoint contract | Pending |
| 16 | Aggregate maintenance tick | Retire enabled and disabled branches after all constituent owners migrate | Pending |

## Stack and verification contract

The first PR targets master. Each following PR targets its predecessor branch so
its diff shows only its own reason. Parent changes must be propagated before
final verification. Record the exact checked head and base for every PR. All PRs
must finish with passing checks, fresh 5/5 Greptile review, and no unresolved
findings. This request does not authorize merging the stack.

Reuse the delivery coordinator, transaction notifications, and shared scheduler.
Existing durable rows own work; no table per loop. Keep domain/provider behavior
in its service and wiring in startup. A write signal is not durable truth. Preserve
outer commit/rollback and uncertain-outcome reconciliation. Audit every supported
producer, including alternate routes and recovery writers.

For each slice verify applicable empty/configured-idle/history quiet states,
first real producer, actual deadlines, rollback/outer commit, restart, failures,
changes during execution, drain/resume, and shutdown. Use real PostgreSQL where
transaction boundaries matter and controlled providers where external behavior
is under test. Record failures and subsequent repair evidence.

External-source reconciliation may remain only for a concrete supported obligation
with a defined cadence and stopping condition, using the shared scheduler. Never
remove the only missed-event backstop without replacing its recovery contract.

## Boundaries

Cloud sleep eligibility and durable alarm coverage remain conservative. An
in-process deadline cannot wake a stopped host. Browser traffic, persistent
connector transport architecture, probes, telemetry/exporter qualification, and
end-to-end provider suspension are outside this requested recurring-server stack;
none are claimed solved by these PRs. Required active-operation lease renewals and
request timeouts remain with their owners.

## Next owner audit: tool reviews

Inspected after gateway credential slice `75332b9641`. The existing
`sweepActionReviews` combines four reasons that need separate migration slices:

1. Pending review expiry: `status = pending` and saved `expiresAt`.
2. Approved action recovery: approved rows that still owe execution/settlement.
3. Interrupted execution: executing rows with the existing ten-minute stale
   threshold; unknown provider outcomes must remain quarantined, not replayed.
4. Interaction projection repair: terminal requests whose interaction result
   does not reflect the authoritative request/invocation state.

The next branch is `codex/sleep-04-tool-review-expiry`. Implementation now separates pending expiry with commit-aware signals and its
existing deadline. Preserve the other three duties while migrating the first, then
retire them individually. Keep the public/manual recovery entry point compatible
or update all callers and tests explicitly; tests currently call the combined
method to cause expiry.

Producer locations found by the audit:

- `tool-access-policy.ts`: creates pending requests with null signature/expiry.
- `tool-gateway.ts`: signs pending requests and assigns their one-hour expiry;
  handles competing-call invalidation, approval/execution transitions, provider
  outcomes, and sweep settlement. Audit all writes, not just initial insertion.
- `tool-action-review.ts`: owns a transaction for human resolution.
- `tool-access/activity/review-queue.ts`: invalidates unsigned/unreadable requests.
- `issue-thread-interactions.ts`: resolves linked pending/approved requests when
  their governing card is resolved administratively.

The unsigned-row signing grace is distinct from the saved review expiry. Do not
invent a new expiry policy while removing the scan. A pending row can be observed
between insert and signing; expiry workers must not cancel an in-flight producer.
Keep provider execution outside database transactions. Signals must be registered
before writes in existing transaction ownership, without wrapping provider calls.

Latest evidence: #17443 has all checks passed and both review threads resolved.
#17446 at `d41590ac0e` has all checks passed, Greptile 5/5, and no review threads.
#17450 at `c5c53fc43f` fixes the deadline query cost with bounded indexed lookups
and an idempotent concurrent session index. Both findings are resolved; fresh
Greptile is 5/5 and CI is running. Local migration/replay, 47 expiry/startup tests,
workspace typecheck/build passed. A synthetic 40,000-row PostgreSQL plan reads
one row from each expiry index. Recheck external state before readiness claims.

Slice 04 now has 11 real-PostgreSQL worker lifecycle tests plus 59 existing
service tests and 39 startup tests passing (109 total). The initial fixture
incorrectly treated an argument-summary object as a string. After correction,
the failure test exposed its invalid expectation of no idle hold during an
unresolved write; it now checks rollback while retaining the hold. A combined
run also exposed fixture cleanup ordering: this repository uses ordered hooks,
so the worker must stop before the outer hook deletes rows. The corrected full
selection passes. The current implementation adds a partial pending-expiry
index, applies/replays its migration, and preserves approval-time rejection and
separate approved/executing/projection recovery. Workspace typecheck/build and all 92 existing gateway acceptance tests also
passed. The first acceptance command matched no files; the corrected
`tool-gateway.test.ts` selection passed. Fresh PR CI/review remains required.


## Approved-review follow-up repairs (2026-10-26)

Slice 05 preserves the rate slot admitted before a human review. Agent and
Test-tab foreground/recovery paths reuse only the exact invocation/context and
unchanged rate-policy admission while rechecking current policy. A one-call
limit must not reject the same approved operation against its own occupied slot.

Recovery now locks and rereads invocation/request history before dispatch.
Finished records repair the request without provider replay; executing records
retain unknown-outcome recovery. Invalid signatures, unusable formal approvals,
and inconsistent invocation states settle once. Missing signing-key configuration
and temporary dependencies retain retries. Company mismatches never mutate the
foreign invocation. No new table or generic HTTP-error discard rule is introduced.

Formal approvals awaiting human input have no recovery cadence. The existing
approval service publishes commit-aware review notifications for approve/reject
and cancellation. Its shared record owner retains the decision validation/CAS
contract; hire decisions remain with their lifecycle owner. Revision/resubmission
keeps the review parked, and startup rediscovers saved work. Budget approval writes
belong to budget incidents, not tool-gateway formal reviews. Company deletion
removes the dependent work. These exclusions come from the producer audit.

Local evidence: the four rate-admission regressions, seven permanent-record
regressions, and four formal-approval commit/rollback regressions failed before
their respective repairs. The complete gateway, policy, approval-service and
signature suites pass (208 tests), and server typechecking passes. Configuration
failure, company boundaries, concurrent claims, provider-outcome persistence
failure, restart and paging remain covered. The paging fixture now has independent
invocations instead of 101 approvals sharing an already-expired invocation.
Full remote checks and downstream integration verification remain required;
this is not an all-stack acceptance or deployed-sleep claim.

## Next owner audit: approved tool-action recovery

The next branch is `codex/sleep-05-approved-tool-recovery`, based on pending
expiry PR #17453 at `ce6a260a83`. Keep this separate from interrupted execution
and terminal projection repair. The public combined sweep remains compatible.

- `commitToolActionReview` and accepted-interaction inference in the gateway are
  approved-state producers. Existing notification ownership from slice 04 can
  carry the new duty without adding another wrapper around callers.
- Agent execute-on-approve uses an atomic approved-to-executing claim before
  provider execution. Keep that claim and all current authorization, signed
  argument, current-target, identity, and issue-state checks in the gateway.
- Approved history is not uniformly executable. Legacy signed arguments without
  `executionOnApprove` are deliberately inert. The payload can be encrypted;
  shared scheduling must not decode it or inspect private provider fields.
- Board Test-tab invocations are a separate execution origin. The normal fresh
  approval calls `runApprovedTestInvocation`, but the already-approved branch
  currently skips test-origin execution. Test execution can leave the request
  approved while the invocation holds the completed result. Do not treat those
  completed rows as perpetual unfinished work.
- Before driving test-origin recovery, establish the same single-execution
  claim on both foreground and recovery paths. The existing test helper does
  not claim the request before provider dispatch. Simply invoking it from a
  new worker would risk duplicate effects during foreground/recovery races.
- Distinguish saved completed outcomes, never-dispatched approved work, and
  interrupted execution with unknown outcomes. Known completed provider results
  must not be converted to unknown-outcome failures because another projection
  write was interrupted. Retain quarantine for actually uncertain calls.
- Concrete unresolved approval work may retain a retry; configured idle,
  terminal invocation history, and deliberately inert legacy approvals must
  not cause empty recurring scans. Preserve restart reconstruction and all
  supported producer paths, including transitions that finish an approved row.

This is an audit, not an implementation or readiness claim. Tests must exercise
real approval producers, foreground/recovery contention, provider failure,
commit/rollback, legacy inert approvals, completed Test-tab history, and actual
unfinished Test-tab recovery before the next PR is ready.

Current parent CI note: #17450 at `c5c53fc43f` has Greptile 5/5. Its server shard
10/12 failed the unchanged login-cleanup consume test waiting for an idle hold.
All 16 login-cleanup tests passed locally on recheck. The run remains active;
an attempted single-job rerun was rejected as not rerunnable. Recheck after the
run finishes before requesting its one justified retry. Do not report it green.


Slice 05 implementation now separates approved recovery from the aggregate tick.
The existing review notification boundary wakes it after outer commit. Legacy
inert approvals and completed Test-tab history become quiet; unresolved work
retains a retry. Test-tab foreground and recovery share a claim and atomic outcome
settlement. No provider call occurs inside that transaction. See
[approved recovery](../idle-approved-tool-recovery.md). Local service/startup
verification passes 122 tests, gateway acceptance passes 92, and workspace
typecheck/build pass. Paging and outcome-failure tests passed again after their
final strengthening. Full CI/review is not yet complete.

Parent CI follow-up: #17450's completed run was retried once for its unchanged
login-cleanup timeout after all 16 local tests passed. #17453 has a Runner
prepared-launch close failure. Seven focused local Runner cases also fail, so
this is under investigation rather than assumed flaky. No retry of that run has
been requested. Neither parent is reported green without fresh evidence.


Slice 05 is [#17454](https://github.com/paperclipai/paperclip/pull/17454).
Review identified a real one-shot outcome-write error path. A new regression
failed before the repair; result persistence now runs outside provider-error
handling. The repaired head passes 123 service/startup tests, 92 acceptance
tests, workspace typecheck and build. Fresh CI/review remains required.
#17450 now has passing checks after its single retry. The local Runner
reproduction for #17453 was missing the fake-provider binary: its durable state
showed ENOENT hidden by close failure. After building the fixture all seven
cases pass; one CI retry is running.

#17453 now has passing checks after its single Runner retry. #17454's initial
server shard found an old expected approved state for a completed Test-tab call;
the updated regression requires executed and one provider call. All 469
tool-access service tests pass after enabling the existing external database
path independently of embedded support. Its initial browser shard failed during
unrelated plan-task fixture company deletion with a concurrent activity-log FK
violation. Inspect fresh-head CI before deciding whether that needs a repair.


## Slice 06: interrupted tool executions

Branch `codex/sleep-06-interrupted-tool-recovery` is based on #17454 and includes
its one-shot outcome-write repair. The next deadline is the minimum executing
claim timestamp plus the existing ten minutes. The new service locks invocation
then request, rechecks claim identity, preserves saved terminal outcomes, and
atomically quarantines unknown outcomes without calling a provider. All claim
producers and request settlements use the existing review notification boundary.
A partial index supports the first deadline. The aggregate tick now excludes
interrupted claims; projection repair remains its own pending slice.

Sixteen new worker cases and the existing service/startup selection pass
(136 total on the combined head). Workspace typecheck/build and migration checks
pass. Two fake-clock fixture ordering failures were corrected to wait for real
settlement while advancing retry time. The combined tool-access run had one
unchanged connection-archive timeout; it passed in isolation. The full suite
and gateway acceptance are running separately before readiness is claimed.
No PR is claimed ready until fresh CI and review pass.

## Next owner audit: tool-review interaction projection

The remaining aggregate tool-review duty selects terminal requests whose
interaction result does not match the authoritative request state. Recovery
currently reads up to 100 joined rows. Move this duty to its own transaction-
notified worker, with retries only while projection debt remains. Do not add
an outbox table merely to migrate the scan.

Audit the final two direct request writers in the gateway as well as existing
review helpers, expiry, interruption, and Test-tab outcome settlement. Preserve
the existing reflection owner: it locks issue/interaction/request, checks the
current request state before writing the card, then publishes activity and
requests continuation. A no-op reflection can mean an ownership or lifecycle
condition, not successful reconciliation. Retained terminal requests with
already matching cards must be quiet. Unprojectable/mismatched durable state
must not be silently dropped. Paginate without starving later candidates.

Continuation delivery already has its own coordinator. A projection write is
not proof that downstream delivery or activity publication completed. Identify
the exact existing recovery owner before removing any backstop, and keep
provider/private payload interpretation out of the scheduler.

Final slice-06 local verification: the isolated tool-access rerun passes all
469 tests, gateway acceptance passes 92, and the combined service/startup
selection passed 136. All 697 selected tests pass on the combined head. The
initial concurrent-run timeout is retained above as evidence, not hidden.
Workspace typecheck/build and migration safety/numbering pass. The first four
PRs are mergeable and have all checks passed at their recorded heads. #17454
is mergeable with fresh checks and review in progress at `7a1cf03e62`.

Slice 06 is [#17458](https://github.com/paperclipai/paperclip/pull/17458), head
`85003a7ac4`, based on #17454. Greptile review was requested and the PR is
attached to this chat. Slice 05 has fresh Greptile 5/5 at `7a1cf03e62`; CI is
running with no failure in the latest snapshot. The next branch is
`codex/sleep-07-tool-review-projection`, based on #17458. No seventh implementation
or readiness is claimed yet. The full remaining inventory stays in scope.


## Slice 07: tool-review interaction projection

The implementation removes the last combined review sweep from the main tick.
It pages terminal mismatches and retains retries only for actual debt or failures.
Gateway reflection keeps locks, current-state checks, activity, and continuation
ownership; concurrent identical repairs do not write twice. The producer audit
also covers administrative card result replacements, before the mutation in the
existing transaction. See [projection repair](../idle-tool-review-projection.md).

Twelve new lifecycle cases are included in 148 passing service/startup tests.
Gateway acceptance passes all 92 tests and workspace typechecking passes. The
initial missing-state bug and referenced-key fixture failure are recorded in the
behavior document. Build and additional consumer regressions are running; no
seventh PR is claimed ready yet.

Historical parent evidence at the initial migration: #17454 at `7a1cf03e62`
and #17458 at `85003a7ac4` passed the recorded CI matrices and Greptile review.
Those snapshots preceded their current-head review and landing. The first six
stack PRs have now merged. The full remaining inventory is still in scope.

Initial slice 07 local verification: 815 selected tests passed, with workspace
typecheck and build passing. One initial interaction cleanup-hook timeout is recorded in
the behavior document; the complete isolated suite then passed. Both parent
PRs #17454 and #17458 now have every check passed and are mergeable, including
the additional Paperclip Review checks. Full CI/review for slice 07 is next.


Slice 07 current integration: master `f6bc653f7f` contains the first six landed
slices and the independent identity/resume/sidebar performance work. This slice
adds generated concurrent interaction-link index migration `0386_steady_epoch`
and retains five schema snapshots. Projection worker passes stop at 500 rows,
honor abort/drain between rows, and resume past failed or unprojectable pages;
empty reconstruction clears obsolete cursors. Six real regressions failed before
the fixes. All 320 integrated gateway/projection/startup/deadline/identity/HTTP
cases, server types and build pass; 35 independent master files are preserved
exactly. Current-head CI and Greptile/Ponytail review remain required. Earlier
case counts above describe the broader selections at their original revisions.


Slice 07 follow-up: scoped hints avoid redundant discovery, empty sweeps avoid a
second candidate read, and unresolved-card retries back off to five minutes.
Fresh writes reactivate promptly and settlement is quiet. The full affected
gateway/startup/deadline selection passes 222 cases; server types/build pass.
The initial invalid one-wake-per-approval assertion and corrected isolated-hint
measurement are retained in the behavior document. Current-head CI/reviews remain
required before this slice can merge.


## Slice 08: decision-archive notification delivery

Projection repair is #17468. Its bounded master integration passes local
acceptance and awaits fresh checks and review. Slice 08 builds on that branch
and separates archive notification delivery from retention scanning.
The existing auto-archive transaction is the sole outbox producer. A committed
enqueue wakes delivery; pending rows retain retries and delivering rows retain
their saved five-minute claim deadline. Delivered history is quiet.

The implementation preserves the delivery API and payload. It fences stale
completion by claim timestamp and orders unattempted/oldest-attempted pending
rows so failed batches do not starve later work. No table is added. Generated
migration `0387_boring_professor_monster.sql` adds the concurrent partial index
for pending delivery order. See [archive delivery](../idle-decision-archive-delivery.md).

All 58 selected tests pass: 15 real-PostgreSQL retention/delivery cases, 42 startup
cases and the shared deadline worker case. Migration checks, generated snapshot
drift, server typecheck and build pass. The initial fixture failures, stale-claim
counter regression and corrected disabled-mode expectation are recorded in the
behavior document. Full current-head CI and both reviews remain required.
Retention eligibility/scanning, decision expiry, effect recovery, and decision
continuation delivery remain independent unfinished reasons in the full ledger.


Slice 08 is [#17475](https://github.com/paperclipai/paperclip/pull/17475), head
`692e3ee02c`, based on #17468. The PR is attached and Greptile review was
requested. Fresh CI is active with no failures in the latest snapshot.
The first seven PRs are mergeable and have all checks passing at their recorded
heads. They remain open; no merge was requested for this stack.

## Next owner audit: decision continuations

The next branch is `codex/sleep-09-decision-continuations`, based on #17475.
No ninth implementation or readiness is claimed. `decisions.ts:sweepExpired`
currently mixes four distinct reasons: interrupted effect recovery, pending
continuation delivery, TTL expiry, and invalidated strict targets. Preserve
separate PRs for those duties. A deadline alone cannot replace target-change
notifications; target deletion and completion need an audited producer contract.

For continuation delivery, the existing decision row already stores the durable
obligation: `continuationPolicy = wake_origin_agent`,
`metadata.continuationPending = true`, and a terminal outcome. Decided rows
are ready only after execution reaches succeeded, partial, or failed. Open
decisions and still-running effects must not create a delivery retry.

All current decision-row writers are in `decisions.ts`. Production service
instances are created in server startup and decision routes with the server DB
handle. Audit creation/bundles, decision claims, regular and archive-proposal
effect settlement/failure, TTL expiry on use, background expiry, cancellation,
dismissal, and continuation acknowledgement. Reuse a narrow pre-write helper
inside existing transaction ownership; do not wrap provider/effect execution
or agent wake calls in a database transaction. The archive-proposal error
branches inherit the claim's pending metadata and must remain eligible after
terminal failure.

The current foreground paths call `deliverContinuation` after saving the result.
It sends the wake then clears pending metadata. Simply adding an eager worker
would make foreground/worker overlap common. Preserve prompt foreground delivery
and the existing at-least-once crash contract, but coalesce simultaneous attempts
for the same decision and re-read durable readiness before sending. Scope any
in-memory coalescing to the actual database/instance owner; do not let unrelated
instances or differing transaction ownership share an accidental global key.
The DB signal owner also supports child pools, so a proposed coalescing mechanism
must explicitly reconcile that boundary rather than assuming object identity
is always sufficient. No new table is needed merely for this migration.

After commit-aware producer coverage, add a paged continuation-only recovery
entry point and register it with the existing coordinator. Remove only its
independent pending scan from the periodic combined sweep. Keep normal
continuations produced by expiry/effect completion, and preserve the public
combined recovery entry point for current callers/tests. A failed wake or
acknowledgement retains its durable pending state and a retry. Matching delivered
history becomes quiet.

Tests should exercise actual decide/cancel/dismiss/expiry producers, completion
of effects after a running claim, concurrent foreground and worker delivery,
wake/acknowledgement failures, restart, outer commit/rollback, first write and
failure during drain, pagination past failing rows, and delivered-history quiet.
The existing decisions suite has an embedded-only setup; use the repository's
validated external test database helper to exercise it on the disposable local
PostgreSQL server, without silently skipping the suite when embedded setup is
unavailable.

Slice 08 review update: Greptile is 5/5 on `692e3ee02c` with no actionable
findings. The latest CI snapshot has 10 successful checks and 44 in progress,
with no failures. This is a live CI wait, not a readiness or completion claim.


## Slice 09 implementation: decision continuations

The continuation owner and worker are implemented on `codex/sleep-09-decision-continuations`.
See [decision continuations](../idle-decision-continuations.md) for producer,
transaction, concurrency, failure, and test evidence. The existing row is durable
truth; the only DB API addition is an opaque shared work-scope identity for local
coalescing across child pools. No new queue table or external wake exemption is
added. Terminal effect settlement is fenced to running state so a competing
caller cannot re-arm an acknowledged continuation. A concurrent partial index
bounds pending selection independently of retained history.

The selected run passes 92 tests; nine older embedded-Postgres cases are locally
skipped, with the new lifecycle tests running against real external PostgreSQL.
Workspace typecheck/build pass. Migration apply/replay and a 40,000-row prepared
query probe pass. Initial fixture type/error-shape failures are recorded in the
behavior document. PR creation and full CI/review are next.

Parent #17475 at `692e3ee02c` now has passing checks and Greptile 5/5; the extra
Paperclip Review check was skipped. Fresh master is `fe85fd7ac4`, still at
migration 0377. The stack remains open and unmerged. The full inventory above
remains the completion scope.


Slice 09 is [#17478](https://github.com/paperclipai/paperclip/pull/17478), initially
`66bbef521e`. Review found a concurrent archive result race and unbounded backlog
shutdown. Both failed real-boundary regressions before repair. The local repair
shares effect execution through completion per DB owner/decision, bounds each
continuation pass to 100 with a fair cursor, and forwards cancellation through
the shared deadline adapter. The repaired selection passes 217 tests, with nine
older embedded-only signal tests skipped locally. Typecheck passes. Fresh build,
CI, and review remain required; the initial head has no other CI failure.

The separate TTL branch `codex/sleep-10-decision-expiry` contains implementation
commit `18c11e3110`. It passed 101 selected tests, workspace typecheck and build.
Its fault fixture initially cleared its error collector before a previous
admitted failure finished; the assertion now verifies all errors after settled
recovery. No hold or retry was weakened. This branch must receive the parent
review repairs and adapt its own paged expiry worker to cancellation before PR
publication. No tenth PR or readiness is claimed.


Slice 09 review follow-up: every failed archive-proposal settlement explicitly
creates its origin-agent continuation obligation. Three recovered-row regressions
failed before repair and pass with exactly one wake and persisted acknowledgement.
The current parent-integrated selection passes 111 decision/archive/startup/deadline
cases, server types/build, fresh migration apply/replay and generated snapshot
drift. Own unmerged index is regenerated as `0388_ambitious_micromax.sql`; parent
386/387 migrations and journal entries are preserved. The initial skipped retention
command and corrected 15-case run are recorded in the behavior document.

Slice 09 security follow-up: sequential real decision writes reproduced six
global continuation scans. Existing thirty-second notification coalescing now
bounds those scans while preserving immediate foreground wakes and durable
pending recovery. All 293 integrated decision/archive/gateway/startup/deadline
cases and server types/build pass. The incorrect expectation of zero active
work during the coalescing window is recorded in the behavior document; the
intent hold remains until reconciliation. Fresh security/CI/reviews required.

Eight slices are merged after archive delivery #17475. Slice 09 now reconciles
with its exact squash `5785090ff1`; all 31 independent master files are preserved.
The 97 decision/startup/deadline cases and server types/build pass after the
Runner vendor rebuild. Fresh master-target CI and reviews remain required.




## Slice 10: decision TTL expiry

The TTL implementation now includes parent continuation repairs from `5f96892a58`.
The merge preserves both the expiry owner and per-decision effect ownership.
See [decision TTL expiry](../idle-decision-expiry.md). Creation and bundle writes
join the same notification helper; an indexed minimum open expiry drives work.
The combined tick opts out of TTL selection without removing target invalidation
or effect recovery. Expiry-on-use remains enforced, including exact equality.
Bounded passes retain a fair expiry/ID cursor and stop between candidates.

All 103 selected tests pass after the merge, including fourteen TTL worker cases.
Migration replay and a 40,000-row history query probe pass (two buffers).
Final workspace typecheck/build and fresh PR CI/review remain required.
The parent continuation PR is awaiting fresh review/CI on `5f96892a58`, with both
initial findings repaired and resolved. The full inventory remains in scope.

Slice 10 review repair: configured batch bounds, one-second successful overdue
continuations and atomic expiration/activity settlement pass all three previously
failing real PostgreSQL regressions. All 129 affected expiry/continuation/archive/
startup/deadline cases, server types/build and snapshot drift pass. Own concurrent
index was regenerated as `0389_brave_hulk.sql`, preserving parent history. The
initial startup-reconciliation assertion failure and corrected boundary are
recorded in the owning behavior audit. Latest-head CI/reviews remain required.

Final slice 10 parent integration passes 130 expiry/decision/archive/startup/
deadline cases, server types/build and migration replay. The parent continuation
coalescing and deterministic cross-pool contention regression remain intact.
The archive parent now targets master after projection #17468 merged. Fresh
current-head reviews and CI remain required in dependency order.

Slice 10 creation signal follow-up: single and bundle creation now notify expiry
only through the central owner. Terminal updates still signal continuation. Both
real regressions failed before repair; all 117 current expiry/decision/startup/
deadline cases, server types and build pass. Fresh CI/reviews remain required.




Slice 10 is [#17479](https://github.com/paperclipai/paperclip/pull/17479), head
`63b58cc26f`, based on the repaired continuation branch. It is attached to this
chat and review was requested. Workspace typecheck/build passed on the combined
branch after parent propagation. Full CI and review are active, not complete.
Slice 09 has fresh Greptile 5/5 at `5f96892a58`, no unresolved review threads,
and CI active with no failure in the latest snapshot. The first eight published
slices remain open with their recorded passing checks. No merge is authorized.

## Next owner audit: interrupted decision effects

The next branch is `codex/sleep-11-decision-effect-recovery`, based on #17479.
No eleventh implementation or PR is claimed. The remaining combined decision
sweep selects `status = decided`, `executionStatus = running`, and
`updatedAt <= now - recoveryGraceMs`. The existing grace defaults to 60 seconds;
invalid values fall back and zero is permitted. The combined batch size defaults
to 100. Preserve these semantics while moving only interrupted effect recovery.
Target invalidation remains a separate pending reason after this migration.

The existing decision update helper covers the running claim and terminal
settlements. Extend that boundary for effect-recovery intent. Creation is open
and does not itself constitute effect debt. The indexed minimum running claim
plus grace should drive the next recovery attempt; open/terminal history must
not keep it scanning. Preserve expiry and continuation as separate workers.

Keep effect execution, signatures, recovery authority, effect claims, and
postcommit issue actions in `decisions.ts` and its domain collaborators. A
recovery selector may call a narrow decision-owned operation rather than move
that policy into the scheduler. The new per-owner execution flight already
coalesces foreground and recovery calls and re-reads the current decision before
execution. Reuse it. Do not hold a DB transaction while waiting for the whole
operation or replace durable per-effect claims with the in-memory flight.

Regular effects use transaction-scoped advisory locks and saved effect execution
rows. Completed effects must not replay; claimed work can resume. Recovery derives
current user authority from stored `decidedByUserId` and current membership.
The existing combined sweep skips rows without a deciding user. Audit how such
invalid legacy rows are represented in readiness and sleep safety; do not allow
them to starve actionable rows or invent permission to execute them. Malformed
stored options or genuine execution failures must retain a visible obligation.

Archive proposals have separate manifest/version checks and transaction ownership.
The parent race repair serializes archive execution through its state write in
one live owner. It is not a durable cross-process claim and does not establish
exactly-once recovery after a process dies between archive commit and decision
settlement. Preserve and explicitly test the supported failure behavior instead
of treating this limitation as solved by a new timer.

Use bounded passes, advance past per-row failures, and propagate cancellation
between candidates. A first claim during drain, completion during recovery, and
an unresolved failed write must retain their existing notification semantics.
Reconstruct recovery deadlines on startup, keep new production SQL indexed, and
preserve the public combined sweep's default behavior while removing its effect
scan from the main tick.

Required evidence includes a real claim with foreground interruption, exact
recovery grace, ordinary active execution coalescing, completed effect history,
claimed-effect restart, changed user authority, invalid legacy rows, provider/
archive failure semantics, outer commit/rollback, failed retry through drain,
changes during execution, fair bounded paging, and shutdown. Run existing
archive and continuation regressions on the combined stack. The full original
inventory remains the goal after this slice.


## Slice 11: interrupted decision effects

The effect-recovery owner and worker now use committed decision changes and the
minimum running claim timestamp plus the existing recovery grace. The aggregate
tick opts out of this duty while preserving target invalidation. Effect execution,
current authority, claims, audit, and archive policy remain with the decision
service. See [effect recovery](../idle-decision-effect-recovery.md).

All 212 selected tests pass: 17 new recovery cases, 50 decision service cases,
14 TTL cases, 39 startup cases, and 92 agent-history route cases. Workspace
typecheck/build and final server typecheck pass. Migration apply/replay and a
40,000-row completed-history query probe pass; both lookups use the new partial
index with two buffers. PR creation and full CI/review are next.

The continuation parent #17478 now has passing checks and Greptile 5/5 at
`5f96892a58`, with both review findings resolved. TTL #17479 has Greptile 5/5 at
`63b58cc26f` and no findings. Its first CI run timed out in the unchanged
agent-history route test. All 92 route tests passed locally; one failed-job retry
was requested. This evidence does not yet establish green TTL CI. The full
original inventory remains in scope; no stack PR has been merged.

Current slice 11 parent integration passes all 141 effect/decision/expiry/startup/
deadline cases, server types/build, generated snapshot drift and migration replay.
The recovery index is regenerated as `0390_salty_killraven.sql`; parent history
is unchanged. The initial overlap assertion failure and its earlier-queue deadline
explanation are recorded in the behavior audit. Seven slices are merged; this
PR and the remaining stack still require fresh current-head CI and both reviews.


Slice 10 merged after exact-head Greptile/Ponytail 5/5 and all 58 check contexts
passed or were neutral/skipped: `aa03d2c4c2` → `3421366903`. Slice 11 normally
integrates that landed parent and all 21 independent master files. All 143 cases
in its five complete suites pass. Its preceding CI shard interruption remains
recorded in the owning effect-recovery audit; it is not a passing receipt. Fresh
CI/reviews are required on the reconciled head.
