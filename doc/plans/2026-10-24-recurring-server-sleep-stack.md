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
| 04 | Decision retention and notifications | Retention deadlines and notification delivery are separate reasons | Approval retention [#17497](https://github.com/paperclipai/paperclip/pull/17497) and archive delivery [#17475](https://github.com/paperclipai/paperclip/pull/17475) merged; other source retention pending |
| 05 | Decision expiry and interrupted effects | Expiry, effect recovery, continuation recovery | Continuations [#17478](https://github.com/paperclipai/paperclip/pull/17478) merged; expiry [#17479](https://github.com/paperclipai/paperclip/pull/17479) merged; effects [#17482](https://github.com/paperclipai/paperclip/pull/17482) merged; targets [#17486](https://github.com/paperclipai/paperclip/pull/17486) merged |
| 06 | Tool connection health | Configuration/use activation and defined proactive health deadlines | [#17554](https://github.com/paperclipai/paperclip/pull/17554) merged after all checks and both 5/5 reviews |
| 07 | Secret proposals, tool reviews, gateway tokens | Separate expiry/scrub/recovery owners | Slices 02–07 merged: [secret proposals](https://github.com/paperclipai/paperclip/pull/17446), [credentials](https://github.com/paperclipai/paperclip/pull/17450), [review expiry](https://github.com/paperclipai/paperclip/pull/17453), [approved recovery](https://github.com/paperclipai/paperclip/pull/17454), [interrupted claims](https://github.com/paperclipai/paperclip/pull/17458), [projection](https://github.com/paperclipai/paperclip/pull/17468) |
| 08 | GitHub connection events and continuity | Event discovery/replay and credential continuity separately | Pending |
| 09 | Merged-PR confirmations | Candidate writes, webhook activation where supported, outstanding-candidate fallback | Pending |
| 10 | External-object refresh | Configuration changes, refresh deadlines, source events | Pending |
| 11 | Status-card evaluation | Settings/card mutations and evaluation deadlines | Pending |
| 12 | Plugin scheduled jobs | Registration/update/removal and actual job deadlines | #17518 published; see latest-head gate records below |
| 13 | Routine, agent-timer and issue-monitor scheduling | Remove periodic wake backstops after complete producer coverage; routine execution-status reconciliation separately | Pending |
| 14 | Skill-version retention and native-harness backup expiration | Separate retention owners and existing retention guarantees | Pending |
| 15 | Automatic database backups | Shared scheduling, actual backup deadlines, existing checkpoint contract | Pending |
| 16 | Aggregate maintenance tick | Retire enabled and disabled branches after all constituent owners migrate | Pending |
| 17 | Grok routine dispatch | Committed reservations and feature changes; prepared-only recovery | [#17490](https://github.com/paperclipai/paperclip/pull/17490) merged after exact-head 5/5 reviews and passing CI |
| 18 | Abandoned import transfer spools | Creation/completion events, existing retention deadline, startup recovery | Pending; explicitly retained from the remaining-blocker checklist |

## Stack and verification contract

The first PR targets master. Each following PR targets its predecessor branch so
its diff shows only its own reason. Parent changes must be propagated before
final verification. Record the exact checked head and base for every PR. All PRs
must finish with passing checks, fresh 5/5 Greptile review, and no unresolved
findings. The later user authorization permits merges after current-head Greptile
5/5, a passing Ponytail review when present, and passing CI, in dependency order.

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


Slice 11 is [#17482](https://github.com/paperclipai/paperclip/pull/17482), head
`a5b5994c1d`, based on #17479. It is attached and Greptile review was requested.
Its CI is active with no failure in the latest snapshot. Slice 10's one
serialized-job retry passed; all checks now pass at `63b58cc26f`, with Greptile
5/5 and no unresolved findings. The recorded original timeout remains part of
its verification history.

## Next owner audit: decision target invalidation

Branch `codex/sleep-12-decision-target-invalidation` starts from #17482. No target
migration is implemented or ready yet. This is the final responsibility inside
the current combined decision sweep, separate from retention and notifications.

Preserve its exact policy: only strict effect references count. A missing target
or any cancelled target expires with `target_gone`. If all strict targets are
done and at least one was not done in the saved proposal snapshot, expire with
`target_completed`. Lenient decisions and proposals intentionally targeting
already-done tasks remain open. Include secondary effect references through the
existing `decisionEffectTargetIssueIds` helper. Do not duplicate provider/effect
payload interpretation inside the scheduler or broaden invalidation to every
updated timestamp. TTL validity remains separately enforced on use.

The direct-writer audit found the main `issueService.update` boundary can enter
done/cancelled and already owns an outer transaction. Release preserves an
existing terminal status; checkout/adoption enter in-progress; conversation
writers enter todo/in-progress/in-review; recovery writers enter blocked.
Tree restoration explicitly excludes terminal snapshots. Administrative release
only changes locks/assignment. Route aliases `issueRows` write source-trust or
owner-notification metadata. Raw SQL updates found in issue/project privacy
propagation change privacy only. These are audit findings, not a substitute for
producer integration tests or final inspection.

Three direct deletion paths need accounting: issue removal, routine dispatch
failure cleanup, and company deletion. Routine creation is visible through its
service while dispatch holds a separate transaction, so do not assume its failed
issue could never have become a target. Company deletion currently encounters
restricting decision/run references if decisions exist; do not silently fix or
relax those foreign keys in this slice. Single-target links cascade on issue
deletion, so an after-commit lookup through those links cannot identify deleted
targets. Use pre-write intent and either preserve the affected decision scope or
request a bounded startup-style scan for this rare path.

A candidate design uses the existing coordinator's scoped hints: decision
creation signals its decision ID; terminal issue writes signal their issue ID;
deletion or unknown hints request a bounded full scan. Existing decision-target
links select affected open rows; the domain helper computes invalidation from
current targets and saved snapshots. Stable valid open decisions must become
quiet after their finite reconciliation, even with long retention or no near TTL.
No per-decision timer or new queue table is required.

Keep scoped scan state in the owner, with bounded pages and fair rotation.
Changes arriving during a scan must reset/requeue that scope without being lost
when the admitted pass completes. Failed candidates retain retry debt while
allowing later scopes to progress. Startup reconstructs all open targets from
durable state; rollback and uncertain writes use the existing transaction
protocol. `hasPending` must not perform passive SQL during drain. Shutdown must
finish admitted expiry and leave later candidates for restart. A changed target
can reopen before reconciliation; inspect current state rather than blindly
expiring from the notification itself.

Required tests include the actual issue update/removal producers, creation after
cancellation, intentional done-target proposals, secondary targets, lenient
history, no recurring SQL with valid open decisions, outer transactions,
rollback, restart with deleted target links, failed expiry, concurrent scope
changes, fair paging, drain/resume, and shutdown. Exercise relevant route/service
consumers when adding notification calls to their existing transaction boundary.
Do not remove the periodic target sweep before this coverage exists.


## Slice 12 implementation: decision targets

The target owner, scoped notification adapter, and audited producer calls are
implemented. Startup reconstructs open targets; ordinary terminal writes select
linked decisions; deletion requests a bounded full scan after cascading links.
The aggregate decision scan is removed now that its four separate owners exist.
See [target invalidation](../idle-decision-targets.md) for scope and policy.

The combined real-database/consumer selection passes 233 tests. Workspace
typecheck and build pass. The final target run also passes all 18 cases, including the additional
same-scope concurrent-change regression (234 unique selected cases in total). No new table or migration is introduced. Existing
indexes support both lookup shapes in the 40,000-row completed-history probe.

Slice 11 #17482 has Greptile 5/5 at `a5b5994c1d` and no unresolved findings.
Its first browser shard 3/8 failed in agent-chat fixture cleanup: cancelling a
run hit a PostgreSQL lock timeout, and the following test saw the experimental
flag left enabled. No CI retry has been used. Reproduce the two tests on the
exact parent head before classifying a retry or repair. This parent is not yet
claimed green. The full original inventory remains in scope.

Slice 11 #17482 now has all checks passing at `a5b5994c1d`, Greptile 5/5,
no unresolved findings, and no merge conflict. Its one browser-shard retry passed
after both affected cases passed locally on the exact head (2/2). The original
fixture-cleanup lock timeout remains documented in the PR.

Slice 12 is #17486 at initial head `5062efb368`. Review found that deletion's
absent hint could be dropped when the same outer transaction included a scoped
hint. Both operation orders failed new regressions before the explicit `all`
hint repair. The repaired target/TTL selection passes 34 cases. CI also exposed
a TTL test race: passive-SQL measurement now joins already-admitted sweeps,
without dropping unresolved recovery holds. Fresh CI/review remain required.

The fresh master audit at `991c47bc6e` identified an additional recurring-server
owner: the Grok routine dispatcher starts a one-second settings/dispatch scan
when public MCP is configured, even when Grok is disabled. Include this in the
full stack as slice 13, separately from decision retention. The disabled baseline
issued three settings queries in 3.2 seconds. Its durable prepared dispatches,
atomic claim, and existing uncertain-outcome policy must remain authoritative.

Slice 12 review repair: deletion captures affected open decision IDs under an
issue-row lock before links cascade. Ordinary cleanup without linked decisions
and empty-company deletion no longer signal global work. PostgreSQL text cursors
preserve microsecond precision. Four real regressions failed before repair;
removing the new lock also failed a controlled concurrent-proposal test. All
246 target/routine/decision/effect/expiry/startup/deadline cases and server
types/build pass. The existing restrictive company-deletion FKs and explicit
combined-service compatibility path remain documented. Fresh head gates required.


Slice 12 final combined-sweep cleanup: the repository/package/SDK audit found no
production consumer or public exposure of `decisionService.sweepExpired` after
the final duty split. Removed that method, its cursor/flags/imports and the
unneeded target-policy export. Its behavioral tests now use the four dedicated
workers. Real isolation tests show TTL does not recover effects and effect
recovery does not expire open decisions. All 248 cases in seven complete suites,
server types and build pass after integrating parent `c304273b75`. This supersedes
the earlier manual-caller compatibility claim. Both creation signals remain:
expiry-only creation and scoped target invalidation. Fresh head gates required.


Slice 11 merged at `c304273b75` → `e9e84bb8a1` after exact-head Greptile/Ponytail
5/5 and all 58 checks passed or were neutral/skipped. Slice 12 normally merges
that landed dependency and preserves four independent Runner E2E accounting
files. All runtime and acceptance test sources are byte-identical to its tested
`85ce6545bf` tree (248 cases, server types/build). Fresh final-head CI and reviews
remain required after retargeting to master.



## Slice 13: Grok routine dispatch

The one-second idle scan is replaced with a shared-coordinator worker. The existing
reservation and experimental-settings transactions notify it; the Grok service
retains all authority, claims, delivery, and uncertainty handling. Prepared-only
selection uses a concurrent partial index. The 21 lifecycle cases, 45 existing
Grok cases, and 39 startup cases pass together (105). Workspace typecheck passes.
See [Grok dispatch](../idle-grok-dispatch.md). Build, populated query proof, PR
publication, and fresh review/CI remain required. Decision retention and every
other pending inventory owner remain in scope.


Slice 13 final local verification also passes all 154 affected settings cases
(259 selected tests total), workspace typecheck, production build, migration
checks/replay, and a generic-plan query probe with 40,000 completed dispatches.
Both queries use the prepared-only partial index with six shared buffers,
including the routine join. Remote CI/review remain required.


Slice 13 normally integrates target parent `85ce6545bf`. Its Grok implementation
is unchanged; migration 0391 is regenerated after the current parent's history.
All 389 parent journal entries are preserved and five snapshots remain. All 273
cases across nine complete dispatch/qualification/startup/deadline/settings
suites, server types/build, schema drift, migration safety and fresh apply/replay
pass. Prior browser fixture-cleanup failure evidence remains in its owning audit.
Fresh current-head CI and Greptile/Ponytail are required before merge.


Slice 12 merged `e6dff4b06f` → `8dfed893d8` after exact-head Greptile/Ponytail 5/5
and all 58 checks passed or were neutral/skipped. One failed-job retry passed;
the original CLI startup/ZIP timeouts and local startup limitation remain in its
PR evidence. Slice 13 normally integrates that landed dependency and four
independent Runner E2E accounting files. All runtime and acceptance sources match
its tested/reviewed `679f523d78` tree; the 273-case, type/build and migration
receipts retain their original revisions. Migration 0391 and all parent journal
entries are unchanged. Fresh final-head CI and reviews required against master.


## Next owner audit: decision retention

Slice 13 is [#17490](https://github.com/paperclipai/paperclip/pull/17490), head
`706beb01f2`, based on the repaired target PR #17486 (`1bbfc69590`). It is
attached and review was requested. The target PR now has fresh Greptile 5/5
with its mixed-hint finding resolved; its fresh CI is still running. Grok's CI
and review are running. No new readiness or merge claim is made.

Branch `codex/sleep-14-decision-retention` starts from #17490. This section is
an audit, not an implemented retention migration. The original full inventory
remains the completion scope.

The existing startup/tick retention function selects every active company,
builds `attentionService.list({includeDismissed:true, all:true,
allowUnscopedAll:true})`, then calls `autoArchive`. Notification delivery was
already separated in slice 08. Retention itself is not just an expiry scan of
`decision_retention`: `attentionService` materializes those records via
`syncItems` while building the feed. An item never viewed in the UI still needs
retention coverage. Removing the periodic feed build and looking only at existing
retention rows would silently miss such sources.

The auto-archive policy uses 90 days since source activity, `keep = false`, and
no existing archive. The 30-day shelf default and per-queue shelf overrides are
UI classification, not the automatic archive deadline. Keep these concepts
separate. Preserve version CAS, actor columns, archiveVersion, notification
outbox creation, and audit in the owning transaction. Manual archive/revive,
keep/unkeep, and archive-proposal manifests are also producers of schedule
changes; they must not require another unrelated source write to take effect.

Current feed sources and eligibility dependencies observed in attention.ts:

| Source | Activity timestamp / eligibility dependencies to audit |
| --- | --- |
| approval | Approval updatedAt; pending status; issue approval links |
| issue_thread_interaction | Interaction updatedAt; pending status; issue and audience policy |
| decision | Decision updatedAt; open status; current feed selection has a default 500-row cap |
| join_request | Join updatedAt; pending_approval; matching company invite |
| recovery_action | Recovery updatedAt; active/escalated; human owner and visible source issue |
| blocker_attention | Prospective blockedTransitionAt or terminal blocker's updatedAt; dependency graph, liveness, monitor and unblock-owner state |
| review | Issue updatedAt; in_review; human participant/assignee, pending approval, or stalled review liveness |
| failed_run | finishedAt/updatedAt/createdAt; bounded-retry-exhaustion event; failed/timed_out; nonterminated agent; no newer run for that agent/task |
| budget_alert | Incident updatedAt; current budget overview/window; hard threshold or observed >=85% |
| agent_error_alert | Agent updatedAt; error status |

`productivity_review` remains in the source-kind contract and retention origin
resolver, but this inspected feed does not directly emit that kind. Do not invent
a new producer or assume all enum values imply live rows. Failed-run attention
has no simple age cutoff in `listAttentionExhaustedRuns`; old rows cannot be
excluded merely because they are old.

Review/blocker attention depends on more than issue status. The review liveness
input includes agents, queued/running runs, wake requests, pending interactions,
approvals, external-response waits, recovery paths, monitors, and `now`. Identify
any clock-driven eligibility transitions as well as source mutations before
removing the backstop. Company activation must discover old eligible sources,
while company deactivation must stop its passive work.

A company-scoped dirty signal can coalesce a source change into a finite feed
reconciliation, but it is only valid after every supported source writer and
transaction owner is accounted for. A live-event callback or activity-log hook
alone is not a proven durable producer contract. Do not hide provider/domain
policy in the shared scheduler or add blanket database-write interception.

Also avoid a notification feedback loop: syncItems currently attempts an
on-conflict insert for all items on every feed read, then updates changed activity
versions. Unconditionally signaling every such attempted insert would cause the
worker's own read/materialization to continually wake itself. Any notification
at this boundary must distinguish actual new/changed retention state and converge.

Required evidence must include an unseen source aging into retention, all audited
source classes and activation paths, exact archive deadline, activity moving a
deadline later, keep/unkeep and manual archive/revive, no repeated feed rebuild
with unchanged pending or completed history, failure/restart/drain, and a source
change during archive selection. The current version CAS protects retention-row
changes; it does not by itself prove that an underlying source did not change
between the feed read and archive. Preserve or strengthen that boundary explicitly
without silently archiving freshly active work. No retention code or PR is yet
claimed for this branch.


Latest remote verification: #17486 has fresh Greptile 5/5 at `1bbfc69590`,
all review findings resolved, and one live build job still pending in run
40132295156. #17490 has fresh Greptile 5/5 at `706beb01f2`, no review threads,
and active CI run 40132581543 (24 completed jobs, 22 still pending, no failures
at this snapshot). These are verified live waits, not completed checks. Do not
rerun them merely because a later observation times out. Continue inspecting
these runs while implementing retention, and propagate any required parent
repair into the later branch. No stack PR was merged.


## Approval retention implementation in progress

Remote verification on October 24: #17486 at `1bbfc69590` and #17490 at
`706beb01f2` each have 56 completed checks, all successful or accepted
neutral/skipped outcomes. Their PR bodies now record completion. Neither was
merged; this remains a stack.

The retention audit is now split by source owner. Slice 14 migrates **approval
retention only**. Decisions, interactions, join requests, recovery actions,
blocker attention, review, failed runs, budget alerts and agent errors remain
explicitly pending. The original full recurring-work inventory remains scope.

The implementation discovers pending approvals directly, including approvals
never materialized by an attention-feed read. It uses active-company status,
the feed's first linked issue, shared execution visibility, keep/archive state,
and the approval's updated timestamp. The next obligation is updated timestamp
plus 90 days. Each bounded pass rechecks and locks the approval before using
existing versioned retention, audit and notification-outbox writes. Other
retention sources still use the aggregate sweep; approval collection is excluded
from that maintenance feed before its query, while normal UI reads are unchanged.

Signals cover approval create/cancel/revision/resubmit/resolve, hard budget
approvals, formal tool approvals, link/unlink/bulk linking, issue visibility and
cascading deletion, company activation/pause/archive/deletion, and keep/archive/
revive/accepted archive manifests. Source comments do not alter approval activity
under the existing policy. Company portability imports no approval records;
offline restore is reconstructed at startup. Independent SQL writers still
require a wake integration. The Cloud sleep proof is unchanged.

Initial real-Postgres proof: 14 lifecycle cases passed, then 19 including actual
archive-write faults, page progress past a failed row, startup drain, first-link
ordering and shutdown. The first consumer run passed retention and startup but
failed five approval unit cases because its transaction stub omitted nested
transactions; the stub was repaired without weakening production behavior.
The budget suite initially skipped due to embedded-Postgres availability. Budget
and attention suites now accept validated disposable external test databases.
Expanded consumer verification, final index/migration proof, build and PR review
remain required. No slice-14 PR has been published yet.


Slice 14 expanded proof: all 20 worker lifecycle cases pass. The shared execution
visibility predicate is used directly, and a waiting Slack conversation with a
pending approval remains eligible with its archive notification persisted. The
repaired approval stub and attention/retention/startup suites pass. Of 96 consumer
cases, one budget case initially timed out during lazy lifecycle module loading
and raced teardown; moving the import into setup preserves the original timeout
and all five budget cases pass. No assertion or production behavior was weakened.
The initial index diagnostic failed to construct a Drizzle client around the
scoped raw driver; supplying its existing driver options fixed the diagnostic.
The actual deadline query with 40,000 resolved approvals uses the pending index,
four shared buffer hits and 0.314 ms execution; test data rolled back. Migration
replay and checks pass. Workspace types, build and tool-gateway tests remain live
in the current verification run. This is not final acceptance.


Slice 14 final local verification passes 317 selected tests: 20 new lifecycle,
96 approval/attention/retention/startup/budget consumers (including the repaired
budget case), and 201 tool-gateway cases. Workspace typecheck, production build,
migration numbering/safety, fresh replay and idempotent index replay pass. The
implementation is committed as `ea3dd40cdd`; remote publication, CI and review
remain required. The earlier failures remain recorded above.


## Slice 14 publication and precision review repair

Approval retention is [#17497](https://github.com/paperclipai/paperclip/pull/17497),
initial head `2f334c678b`, based on #17490. It is attached. Initial CI run
40135489716 completed without a failed CI job. Greptile gave 4/5 with one P2:
JavaScript Date truncation can repeat a full failed page whose source timestamp
contains microseconds (comment 4368633789, thread PRRT_kwDORclPyM6v79u7).

A database-generated timestamp regression failed before repair: all 100 failed
rows repeated and blocked row 101. The cursor now preserves the database text
timestamp. All 21 lifecycle cases pass afterward, and server typecheck passes.
During the full regression run, the earlier quiet-window test crossed its real
deadline after settlement. It now measures an explicit window before that
deadline; it still asserts no SQL and eventual archival. Total selected coverage
is now 318 unique tests. Fresh remote checks/review are required after this fix.

Related precision audit is required before final stack acceptance: the earlier
TTL worker (#17479) and effect-recovery worker (#17482) retain Date cursors too.
Add database-precision regressions and repair those owning PRs, then propagate
parent updates through the stack. The already-merged terminal-workspace sweep
also uses a Date keyset cursor; verify and address it as a focused follow-up if
confirmed. These are concrete remaining verification duties, not waived by the
earlier green checks.

Branch `codex/sleep-15-join-retention` exists at the initial slice-14 head, with
no implementation yet. Its producer audit found request writes in access routes
(accept, replay, auto-approve, approve, reject, key claim), Slack identity access
creation, and company deletion. Eligibility is pending_approval plus matching
invite/company and active company. Invite expiry/revocation do not remove the
existing feed item. Preserve that policy. Retention controls and company status
changes must notify this owner. Decision retention remains separately pending;
its visibility dependencies differ, and normal decisions already have a
maximum 30-day TTL before the 90-day archive threshold.


Slice 14 current review repairs: share first-linked-issue/execution visibility in
one owner used by the feed and worker; keep actor read filtering. Materialize
unseen approvals inside existing manual retention transactions, locking the
source before state mutation. Four real failures (three 404s and atomic keep
rollback) are repaired; the reverse visibility-order regression also passes.
All 26 lifecycle cases and all 311 cases across eight complete consumer suites,
server types/build, schema drift, migration safety and fresh apply/replay pass.
Index 0392 is generated after all 390 unchanged parent journal entries; five
snapshots remain. Current parent is `679f523d78`; fresh head gates remain required.


Slice 14 wake-amplification follow-up: ordinary approval/link/revision/resubmit
writes no longer notify tool reviews. Approve/reject/cancel retain their existing
terminal wake contract. Retention uses a thirty-second aggregate notification
budget, with known deadlines preempting and no idle recurring scan. Three real
regressions failed before repair. A broad run also caught a removed cancellation
producer (313 pass/1 fail); it is restored. All 315 cases in eight complete suites,
including 30 worker cases, and server types/build pass at `dd844f4e8c`. Prior
coalescing-fixture, security and Greptile service failures remain in the owning
audit. Fresh exact-head checks and reviews are required on publication.


Slice 13 merged `15cddfcb0c` → `2adcde162e` after exact-head Greptile/Ponytail
5/5 and all 58 check contexts passed or were neutral/skipped. Slice 14 normally
integrates that landed dependency, preserving four independent Runner E2E
accounting files. Its entire runtime and acceptance sources match the tested
and reviewed `3efda33812` tree (315 cases, server types/build). Migration 0392
and the parent journal prefix are unchanged. Fresh final-head CI/reviews are
required against master. The abandoned-import-spool inventory duty remains.

Latest slice-14 head is `a29ce265b0c00678ada3f29f533d79f80fe25654`.
The precision finding was replied to (4368650634) and its thread resolved.
Fresh Greptile review was requested (6390004743). CI run **40136197148** is
confirmed in progress on this head; commit review run 40136193928 succeeded.
The previous-head CI run 40135489716 succeeded. Do not treat that as evidence
for the new head. No local test/build process remains active.

Next actions: finish fresh #17497 CI/review; reproduce and repair precision
paging in the earlier TTL and effect-recovery owners, propagating parent changes
through later PRs; qualify the terminal-workspace cursor; then implement the
join-request retention audit on this branch. Every original inventory item and
remaining retention source remains required. No merge is authorized.

## Decision and workspace precision follow-up

Expiry #17479 now preserves the PostgreSQL timestamp in its cursor, head
`e89c682ba5`. Its regression failed before repair; all 15 expiry cases and server
typechecking pass. Fresh CI is green and Greptile is 5/5 at that head.
Effect recovery #17482 has the same verified repair at `cebcd9c427`: its invalid
legacy claim regression failed before repair, then all 18 cases and typechecking
passed. Both changes have been merged through #17486, #17490, and #17497.
The combined 33 expiry/effect cases pass on the latest stack. Fresh dependent
CI/review is running. Superseded runs on the Grok/retention heads were cancelled
when both base and head updated; replacement workflows exist. Do not rerun or
claim those heads green until their current runs finish.

Approval retention previously passed all checks and fresh 5/5 at `a29ce265b0`.
Its new head is `2c5babcabc`, with only parent paging repairs added. Join retention
still has no implementation; its branch now includes the current parents.

The terminal-workspace audit also reproduced starvation using real microsecond
source timestamps. The focused branch `codex/sleep-terminal-workspace-precision`
preserves cursor precision in the owning query. All 87 workspace service/worker
cases and server typechecking pass. See
[workspace pagination](../idle-terminal-workspace-pagination.md). Publication and
fresh CI/review are next. Join retention remains the next new migration duty.


Terminal workspace precision follow-up #17505 normally integrates approval wake
parent `3efda33812`. All 136 cases across four complete workspace/worker/rehome/
nested-clone suites, server types and build pass at `9d846c84e7`. The preceding
`f0f0de1f6f` run passed the same cases on three freshly created unmigrated fixtures;
the suites prepared their own schemas. Current reused-fixture evidence and old
starvation/clock/setup failures are distinguished in its owning audit. No new
schema or wake mechanism. Fresh head CI and reviews required; parent unmerged.


Slice 14 merged `a26d865c99` → `553a004926` after exact-head Greptile/Ponytail
5/5 and all 58 checks passed or were neutral/skipped. Terminal precision #17505
normally integrates that landed dependency and four independent Runner E2E
accounting files. Its entire runtime and acceptance sources match the tested/
reviewed `a34dc50de3` tree (136 cases, server types/build); migration metadata is
unchanged. No local checks were repeated on unchanged source. Fresh final-head
CI/reviews are required against master; all remaining checklist duties persist.

## Join request retention implementation

Terminal workspace pagination is [#17505](https://github.com/paperclipai/paperclip/pull/17505),
head `28a197cdfd`, stacked on #17497. It has fresh 5/5 review without unresolved
findings. The full CI matrix is running. Workspace typecheck/build and all 87
selected service/worker tests passed locally.

Join retention is implemented on `codex/sleep-15-join-retention`, based on #17505.
The worker preserves pending request/invite/company eligibility, manual controls,
transaction ownership, microsecond paging, and bounded recovery. All supported
writers are audited; approved-only API-key consumption is deliberately exempt.
See [join retention](../idle-join-request-retention.md). Seventeen new real-DB
lifecycle cases and 139 consumers pass (156 total). Initial fixture and command
failures are recorded in that document. Index generation, apply, replay, safety,
numbering, and an actual-query plan with 40,000 resolved requests pass. Workspace
typecheck/build and remote publication/CI/review remain in progress. No slice is
claimed ready based only on local tests, and no merge is authorized.

After join retention, migrate the remaining attention source owners separately:
decisions, interactions, recovery actions, reviews, and other source kinds. Keep
the full original server inventory and later aggregate-tick retirement in scope.


Slice 15 review repair: approval and join retention share the bounded archive
sweep; owners retain eligibility and source-row locks. SQL deadlines round up
from database precision. Unseen join controls materialize state atomically in
the existing retention boundary. Five real regressions failed then passed. The
initial timing-only concurrency test failed to detect a missing lock; it now
observes the actual database wait, passes normally and rejects lock removal.
Archive-first committed activity remains archived until explicit revival.

All 340 cases across nine complete suites (31 approval/22 join worker cases),
server types/build, migration checks and schema drift pass at `405c7dcdef`.
All six isolated database fixtures pass actual migration apply/replay. Index 0393
is generated after 391 unchanged parent entries; five snapshots remain. Parent
`0b0e844b77` adds only four Runner E2E accounting files and ledger changes; runtime
and acceptance sources are unchanged. Fresh publication checks/reviews required.


Slice 15 final master integration: #17505 merged as `d23dd19750` after both
final-head 5/5 reviews and all 58 accepted checks. Join retention now targets
master and integrates that landed parent without changing the tested source tree.
The shared retention scan saves a finite upper tuple so continuing arrivals cannot
starve failed rows; both real arrival regressions failed then passed. All 55 worker
cases pass. Eight consumer suites passed 311 cases; the ninth attention suite had
a cleanup-hook timeout and then passed all 31 after disposable-fixture vacuuming.
The unchanged expiry suite passes twenty local cases after a separate CI deadline
assertion failure; neither passing rerun is presented as a proven root cause.
Server types/build pass. See the join-retention document for the full audit.
Fresh exact-head reviews and CI remain required. All original duties remain open
until their own accepted merge, including native-harness backup expiration.

## Slice 16: approval PR-queue membership

The source audit found automatic seeded-queue materialization hidden inside the
attention retention scan. A PostgreSQL regression failed after approval exclusion:
queue API readers saw no PR queue despite a pending linked approval and PR work
product. This is a separate obligation from retention, not grounds to leave a
new permanent scan or to put queue policy into retention.

The new approval queue worker uses existing durable records and the queue service's
normalized seed writer. It gets committed signals from all approval/link producers,
issue/company visibility changes, work-product writes, and queue-rule changes.
Missing membership is recovery debt; existing membership and disabled rules are
quiet. Twenty real-database lifecycle cases and 115 existing consumer/startup
tests pass, as do workspace typechecks and the production build. See
[approval queue seeding](../idle-approval-queue-seeding.md). Fresh CI/review
remain required before readiness. This slice is a correctness dependency of
approval retention #17497; do not accept that migration as functionally complete
without preserving queue population. Other source seeding remains to be migrated.

#17505 now has all latest-head checks accepted at `28a197cdfdab7977eecf591df39612009d725e17`
(Paperclip Review skipped), with Greptile 5/5. #17508 at
`9c5c4fbf65628589b466ce5650e8969388213716` has Greptile 5/5 and no unresolved
threads. Its unchanged login-cleanup consume test failed in CI; all 16 local
login-cleanup tests pass. One justified retry of failed run 40139410144 was
requested. Do not mark that PR green until the retry completes successfully.


Slice 16 is [#17510](https://github.com/paperclipai/paperclip/pull/17510).
Greptile identified a queue/item lock-order inversion. A real PostgreSQL test
reproduced a deadlock; the common queue-before-item order repairs manual add/remove
and seeding. The worker and queue route suites pass 27 cases after the fix, with
server typecheck/build passing. Other selected consumers passed on the initial
head (136 unique local cases including the new regression). Fresh-head checks are
required; the initial head also hit an unchanged environment cleanup paging test.
Embedded PostgreSQL is unsupported on this host, so its first local run skipped;
this is not counted as a pass.

#17508 now has all checks accepted at `9c5c4fbf65628589b466ce5650e8969388213716`
after its single justified retry. The duplicate cancelled workflows for #17490
and #17497 were each rerun once to clear stale cancelled contexts. The #17490
retry has a new E2E shard 3 failure under investigation; do not call it green or
rerun again without a repair. #17497's retry was still running at this observation.

### Plugin scheduling implementation, 2026-10-24

The next slice replaces the plugin scheduler's private 30-second query loop with
shared deadlines and transaction-aware producer wakes. It uses existing job/run
rows, preserves overdue schedules, handles empty manifest sync, and tracks calls
through durable settlement and shutdown. See [the implementation contract](../idle-plugin-jobs.md)
and [producer audit](2026-10-24-plugin-job-sleep-audit.md).

The baseline empty-instance regression failed before the migration. The first
expanded local run passed 59 tests across plugin scheduling, warm standby, the
shared coordinator, and decision expiry. The consumer run exposed an incomplete
loader mock after empty-manifest synchronization became mandatory; that fixture
was corrected; all 14 loader recovery cases passed. Workspace typechecks and the
production build passed. Final server typecheck and build also passed after the
lifecycle wiring edits. Remote review/checks remain open.

Separate stack gates remain: #17490 E2E cleanup hit a cancellation lock timeout;
#17510 has a security finding about unscoped approval queue scans plus CI failures.
Neither PR is claimed green. Approval retention #17497 is green at `2c5babcabc`.
The complete original inventory remains in scope; this slice does not finish it.

Slice 16 security review reproduced cross-company work amplification from normal
producer writes. The repair carries company hints through all supported producers
and maintains separate pending scopes. Startup recovery remains instance-wide.
A generation comparison after the final awaited read preserves concurrent commits.
All 169 affected cases and server typechecking pass. CI fixture repairs move cold
route imports outside timed tests and replace random watchdog identifiers. The
initial rerun had timeouts and a cleanup failure; the final selected run passes
without relaxing timeouts. Fresh remote CI/review remains required.

Plugin scheduling is published as #17518 at 8b4f551dc2. Its Actions checks passed,
but review found retained completion writes missing from shutdown and a stale
deadline update race. Repair those and preserve independent job progress when
one completion write fails before treating the slice as ready.


Plugin review repair: real PostgreSQL cases reproduced lost shutdown settlement,
independent-job starvation after a completion write error, and restoration of an
old deadline by a concurrent registry update. Stop now flushes retained results
and reports remaining errors; refresh preserves independent dispatch; registry
updates take the job lock. All 62 focused lifecycle/consumer cases and server
typechecking pass. #17510 at 400f4c0fc8 cleared the security gate and previous CI
failures, but environment-cleanup pagination has a 32-versus-33 assertion race
in server shard 1. Diagnose and repair it before accepting the stack.


Plugin round-two review repair restores a 30-second minimum between requested
full refreshes without adding idle polling. A burst regression failed at 16
reads before repair and passes at at most one afterward. Failed plugin stop
no longer skips application/worker teardown; retained settlement is retried once
after cleanup while the pool is open, with persistent errors still reported.
The final 48 shutdown/plugin cases and earlier 75-case consumer selection pass
(76 unique cases), with server types/build passing. Fresh remote gates remain.
Approval #17510 has passing latest-head CI and Greptile 5/5 at 0c7109c103, but
Paperclip review identified persistent-failure backoff and duplicated PR matching
that still require repair. Tool health remains the next new migration after
these owning-PR repairs.


Approval queue follow-up: persistent projection failure reproduced 120 failed
transactions in two simulated minutes. Per-scope exponential backoff now caps
retries at one minute without discarding debt or letting repeated signals reset
the budget. A coordinator regression proves SQL silence during backoff and real
producer progress for another company. The candidate and seed writer share the
PR-product predicate. All 124 affected worker/queue/startup/retention/attention
cases pass, along with server types/build. One initial consumer command skipped
six queue tests because its DB variable was missing; the corrected run executes
and passes them. Fresh remote checks and review remain required after publication.


Slice 16 current parent: approval seeding integrates published join retention
`b41c51c70f`. Only the original 25 seeding paths differ from the tested parent;
all other files match it. The worker shares the first-linked-issue policy, and
generic writes preserve retention-plus-scoped-seeding signals while terminal
approval outcomes retain tool-review signals. All 522 cases in fifteen complete
suites, server types and production build pass at `4e725e2055`. An initial
integration typecheck caught incorrect gateway company references; those are
repaired with the existing session company. The final parent merge adds only
two documents. Fresh final-head CI/reviews and the parent's merge remain required.


Slice 16 now integrates landed join retention `8406047b4e` and targets master.
Its own diff is still the original 25 seeding paths; all database metadata matches
master. Continuing-arrival fairness, post-success backoff reset and outage backoff
through an empty rollover have real failed-then-passing regressions. External
seeding, queue and watchdog tests now migrate their own empty databases: all 55
cases passed on three fresh fixtures, and the final added guard passes all 56
cases on those migrated fixtures. Server types/build pass at `7948136ef8`.
The earlier cleanup-expectation failure and 522-case integration evidence retain
their own revisions. Fresh exact-head reviews and CI are the remaining merge gate.

Slice 17 current review repair: a retained plugin completion can no longer wait
indefinitely for a PostgreSQL statement/row lock. The transaction-local timeout
preserves the saved result for retry and allows existing shutdown cleanup to
continue; the provider is not called again. A real lock regression failed then
passed. All 34 scheduler cases and 247 cases in eleven complete lifecycle and
existing-worker suites pass at `36be0bd733`, plus server types/build. This is not
a guarantee about every network or shutdown operation. Final parent integration,
fresh remote review and all CI gates remain required.


Plugin slice 17 integrates final seeding parent `51668b8240`. Its original
seventeen-file boundary is preserved, and every plugin/runtime/shutdown source
is unchanged from the 247-case proof. All 63 cases across complete plugin,
seeding and scoped-deadline suites now pass at `56ce7c1d2a`, plus server
types/build. Hold its final publication for the parent's accepted merge, then
reconcile the landed master parent and require fresh exact-head review/CI.


Approval queue seeding #17510 merged as `4e27a82a42` after final-head 5/5
Greptile/Ponytail and all 58 accepted checks. Plugin scheduling now targets master
and integrates that accepted parent. Normal ancestry reconciliation preserves
its entire verified tree (`df78ca3b5e`) byte for byte; only publication docs change
subsequently. All original remaining duties remain in scope, beyond the 65
published numbered slices, including native backups and remaining aggregate owners.

## Slice 18: tool-connection health implementation

The health migration now reconstructs per-connection deadlines and reacts to
committed company changes instead of inventory scans on every maintenance tick.
See [health lifecycle and producer coverage](../idle-tool-connection-health.md).
Existing proactive health, provider policy, voice eligibility, transaction
uncertainty, drain, and shutdown behavior remain explicit. Seventeen lifecycle,
515 startup/tool-access, and 163 gateway/settings tests pass. Additional producer
consumers and publication gates remain open. This is not a completed PR yet.

Fresh remote inspection: approval queue #17510 at `0d3100665d` has no failed or
pending checks. Plugin #17518 at `ba0b6752cd` has no failed checks and one pending
Paperclip Review check. The full original inventory and #17490 E2E cancellation
failure remain required; no PR was merged.

Health consumer follow-up: 72 access/email/GitHub/smoke-lab cases pass using a
separate disposable DB per suite, and three selected chat cases pass. An initial
shared-DB attempt produced cleanup foreign-key failures after email; those are
recorded, not counted as passes. Total selected coverage is 770 cases. The server
build passes. The inventory SQL uses the existing company/enabled index with
40,000 retained rows (13 buffers, 0.022 ms). Full workspace and remote gates remain.

## Health publication and next chat boundary

Tool health is [#17554](https://github.com/paperclipai/paperclip/pull/17554), head
`2ca12f806399cfcef1a474453301534f4b96c1ef`, stacked on #17518. Local workspace
checks/build and 770 selected tests pass. CI run 40165710347 is confirmed live;
Greptile and security review are running. This is not final acceptance.

The next runtime-discovery audit found command-registration recovery hidden
inside `reconcileDiscordRuntime`. That is a separate durable reason and must get
its own PR before removing the runtime discovery backstop. Slice 19 audits that
owner in [Discord command registration](2026-10-25-discord-command-registration-sleep-audit.md).
Runtime discovery, active lease renewal, voice, Teams, and every original pending
inventory item remain in scope. No merges are authorized.


## Slice 19 foundation and health review status

Discord registration now has a normalized saved-deadline reader, scoped store
notifications, paged eligibility discovery, and a shared-coordinator worker.
Thirty-six real-DB protocol/lifecycle cases and server typechecking pass. See
[the audit and remaining integration](2026-10-25-discord-command-registration-sleep-audit.md).
It is not wired into startup, the old runtime call is not removed, and no PR is
published for this slice yet. Complete producer wiring and consumer verification
before removing the backstop.

Tool-health #17554 at `da4089960619d3da2112a4eed3cc7a3d97dbebf8` has passing
Actions checks and fresh Greptile 5/5 after the failed-probe warning repair.
Paperclip Review remains queued, so final acceptance is still open. Its PR body
now records 771 selected local tests and the outstanding gate. No PR was merged.


## Slice 19 integration

Discord registration now has complete producer wiring and a startup worker;
recurring runtime reconciliation no longer invokes its command protocol. The
[contract](../idle-discord-command-registration.md) records retained verification
policy, scoped producer coverage, supported writers and separate runtime duties.
Local selected coverage is 639 unique passing tests, with workspace types/build
passing before the final fair-batch addition. Final server typechecking and build
also pass. Remote publication/gates remain open.

The latest health Paperclip Review completed neutral, with a 4/5 assessment and
follow-ups for cross-company backlog fairness and direct service-producer tests.
These remain owning-PR work despite green Actions and Greptile 5/5. The same
fairness defect was reproduced and repaired in the Discord worker. Shared helper
commit `e77979d4fc` is ready to carry into #17554. No PR is newly accepted or merged.


## Discord publication and health fairness repair

Discord registration is [#17557](https://github.com/paperclipai/paperclip/pull/17557),
head `3755d7caced67589de474e0ca3e1b8b5b4e659c4`, based on #17554 and attached.
It has 639 selected passing tests, workspace typecheck/build, and final server
verification. CI run **40168371442** and review run **40168371311** are confirmed
live on that head. Fresh CI and review remain required; no merge is authorized.
The source and detailed producer audit are on the Discord child branch.

The health parent Paperclip Review completed neutral with 4/5 at `da40899606`.
It requests fair company batching and direct real-service producer coverage.
The existing probes are already scoped by connection ID, so the review's concern
about full inventory scans around each probe needs clarification rather than
removing current-state eligibility checks. Self-generated observation hints still
cause a bounded coalesced company refresh; avoid muting correctness signals merely
to reduce that bounded work without proving equivalent recovery.

Fairness was reproduced with 30 unchecked connections in one company and one due
connection in another. The quiet company was omitted from the first batch. The
shared selector from Discord commit `e77979d4fc` was applied to the health branch
as `097f5c8aff`; the health worker now rotates companies. All 22 health/selection
tests pass (`/tmp/sleep18-fairness-after.log`), after the recorded failing baseline
(`/tmp/sleep18-fairness-before.log`). The fix is local until the additional
AgentMail activation/pause, GitHub installation event, and access-removal producer
tests are complete. Then push the owning PR, request fresh review, and merge it
into the Discord branch. Full original inventory and earlier unresolved CI remain.


Health producer review coverage is now implemented and verified. The actual
AgentMail setup/health/pause, GitHub installation-event, and member-removal paths
move or cancel the live coordinator deadline. All 66 owner-suite cases pass on
isolated PostgreSQL databases, alongside the prior 22 fairness/health cases and
fresh server typecheck/build. Initial fixture expectations and the retained-user
DB setup failure are preserved in the health document. Publish these changes with
the fair company selector, request fresh review, and propagate to Discord #17557.
The Discord initial head has Greptile 5/5; its CI and Paperclip review were still
running when inspected. The remaining original inventory and #17490 failure
remain open; no stack PR is merged or declared fully accepted.


Discord's first Paperclip review (4/5) identified a dispatch-capacity issue shared
by health: 25 checks per 30 seconds delays a large already-due backlog. Health's
actual-probe timestamp regression failed with a 30.7-second gap, then passed when
only a remaining due batch receives a one-second continuation. All 22 health and
batching cases pass; server types pass. Propagate the parent and apply the same
bounded continuation to Discord, with its own regression. The Discord review also
requests preserving queued scopes after malformed hints and broader producer
coverage. Its initial head has Greptile 5/5 but these findings remain open.


Discord review repairs are in progress. Both new worker regressions failed before
repair: the 300-command backlog did not drain promptly, and an unknown hint lost
later scopes. Bounded backlog continuations and full reconstruction after malformed
scope parsing repair them; all 62 combined command/health/batching cases pass.
Real credential rotation also passes. The company-deletion producer test exposed
an existing dependency-order failure: agents are deleted before chat endpoints
whose assigned-agent foreign key is RESTRICT. Configuring the fixture lifecycle
removed the initial missing-worker failure but reproduced this actual SQL failure.
Keep the failing producer test; repair the deletion dependency in its own stack
PR before publishing the Discord follow-up. Current local changes are not final
acceptance. The original full inventory and remaining CI gates are still open.


Company deletion prerequisite is [#17561](https://github.com/paperclipai/paperclip/pull/17561),
head `4d721402d2`, based on #17554. Both new regressions failed first; all six
cleanup-removal tests and server types/build pass after the fix. The chat owner
removes company endpoints before agent purge in the same transaction. Other
companies and global namespace tombstones remain unchanged; a later failure rolls
back the deletion. Existing voice-history restrictions remain in force. Remote
CI/review are required; this is a focused correctness dependency, not a migration
of another inventory duty.

The prerequisite is merged into the local Discord branch at `2802c361f3`. The
company command signal precedes endpoint deletion. All seven real automatic
registration integration cases now pass, including rotation and deletion, plus
62 combined worker/batching cases and final server types/build. The earlier
missing lifecycle fixture, actual dependency-order failure, and merge-conflict
invocation are recorded in the Discord document. Update #17557's base to #17561
and publish the review repairs for fresh CI/review. Cumulative selected Discord
coverage is 643 cases. Health #17554 at `f8ad26f0ff` has no failures and one pending
check at the last observation; do not mark it fully accepted yet.

Next new owner remains chat runtime discovery/ownership, separate from command
registration, voice, and active transport renewals. The full original inventory,
#17490 E2E cancellation failure, final stack/master reconciliation, and all PR
acceptance gates remain required. No stack merge is authorized.


Prerequisite #17561 review found that retained chat conversations/publications
also restrict issue deletion. Expanded real-history fixtures reproduced that
failure, and cleanup now runs immediately after locking the company. All six
cleanup cases pass, including restoration of chat history on later failure. The
review thread is resolved at parent head `e7c29e4840`; fresh review/CI still apply.
Discord inherits that parent at `33954efd2e` and registers its company intent
before the earlier cleanup. Seven producer integrations and all six cleanup cases
pass on the merged branch. The 1,413 deselected broad chat cases are not passes.
Health `f8ad26f0ff` now has fresh Greptile 5/5 and no failed checks; Paperclip Review
was still queued at the last inspection. The full goal remains active.


Health security repair: five real connection API updates in a 205-connection
company reproduced 1,025 inventory rows. Individual writers now signal their
connection IDs; application writers signal their application IDs. Genuine broad
loads use 100-row UUID pages. The regression now reads exactly five rows, with
application invalidation and unrelated-deadline preservation verified. All 706
targeted health/producer/consumer cases and server typecheck/build pass. Publish
the repair to #17554, propagate through company-deletion #17561 into Discord
#17557, and require fresh remote gates. No PR in this stack is merged. The next
new owner remains chat runtime discovery; the full remaining ledger is unchanged.


Published health security repair is 9ef6e4f4c8; fresh security and Greptile checks
pass, with Actions still running at inspection. Company cleanup inherits it at
e8febb30eb; six cleanup tests pass. Discord inherits it at fe1c886a3d, preserving
both command and scoped health intents. Its previous-head CI exposed a flaky
quiet-window/spying fixture and review reproduced failure-path backlog throttling.
The repaired coordinator honors actual future deadlines without zero-delay error
loops or changing domain backoff. All 152 selected command/coordinator/health,
producer/Slack, delivery/standby/startup cases and server types/build pass. Publish
for fresh CI/review. The full inventory, #17490 CI failure, and stack/master
reconciliation remain open; no merge authority is implied.


## Slice 20 receiver implementation

Receiver discovery now uses scoped committed configuration changes, startup
reconstruction, foreign-lease deadlines, and listener-stop completion. Voice and
all other maintenance reasons remain separate. See
[the receiver audit](2026-10-25-chat-receiver-discovery-sleep-audit.md).
A failed-scope deadline regression and a real concurrent listener-stop race were
reproduced and repaired. All 218 selected receiver/startup, Discord, Photon,
command/delivery and standby cases pass, with workspace typechecking passing.
Workspace build also passes; publication and fresh remote gates remain open. This is not
completion of the slice or the full stack. Master is refreshed at 0d73505098;
final stack/master reconciliation remains required.

Parent Discord #17557 at d3187f76a4 and company cleanup #17561 at e8febb30eb now
have no failed or pending checks (Paperclip Review skipped). No merge was made.
The older #17490 E2E cancellation failure remains unresolved. The entire original
inventory stays in scope, with voice the next separate reason after receivers.


Receiver discovery is published and attached as [#17572](https://github.com/paperclipai/paperclip/pull/17572)
at 643f4766227e15006b684d2cc7bea7ddd5cc2147, based on #17557. Its live CI run is
40173962833; security and reviews are pending. All 218 selected local cases,
workspace types and build pass. The next audit splits voice into five separate
reasons: live-session recovery, reply push, inbound admission expiry/provider
cleanup, inbound history retention, and call reports. See
[the voice owner audit](2026-10-25-voice-maintenance-sleep-audit.md).
Branch codex/sleep-21-voice-session-recovery starts with the first reason; the
other four remain explicit required slices. No voice migration is implemented yet.
## Receiver review repair

The real company-removal producer regression reproduced two inventory reads for
one observed removal. Discovery-initiated stops now suppress their own completion
wake; independent token loss still wakes discovery after listener retirement.
A full reconstruction also covers its already-pending scoped hints. Hints that
arrive during the load remain dirty, and narrower writes cannot bypass a failed
full reconstruction's retry deadline.

Both redundant-load regressions failed before repair. All 45 selected receiver,
startup and real Discord producer tests pass after repair, including the added
full-refresh failure/backoff case. Server typecheck and build pass. Prior broad
consumer/workspace verification remains recorded above; these 45 overlap that
coverage and are not an additional unique total. Publication requires fresh
remote CI and review. The full migration inventory remains outstanding.


Voice recovery checkpoint: receiver repair `1604a9fcba` is published to #17572
and incorporated into the unpublished voice child. The complete 93-case voice
suite, eight new recovery lifecycle tests, and 16 startup wiring cases pass.
See the voice audit for precise coverage and remaining work. Receiver CI
40175242445 is live with no failures at inspection; no final acceptance or merge
is claimed. All remaining reasons, older #17490 failure, and final master
reconciliation stay in scope.


Live voice recovery is [#17576](https://github.com/paperclipai/paperclip/pull/17576),
head 8f5e861dbd, based on #17572. All 837 selected tests, workspace typecheck and
build pass; remote checks and review remain required. The full local test command
was stopped after repeated embedded PostgreSQL setup failures, not counted as a
pass. Slice 22 owns voice reply delivery and begins with the multipart/outcome
policy and publication-settlement producer audit. See
[reply delivery audit](2026-10-25-voice-reply-delivery-sleep-audit.md).

Slice 22 now implements voice reply delivery from committed changes and saved
retry/dispatch deadlines. The periodic reply scan and pre-publication direct push
are removed. Real normal/operator publication tests prove the final-commit wake;
turning that notification off reproduces zero delivered replies. The branch has
786 selected passing tests across isolated voice, recovery, startup, and shared
consumers, plus workspace typecheck/build. See the reply audit for retained
fixture failures and local full-suite infrastructure limitations. Publication and
latest-head review/check acceptance remain outstanding. Inbound admission cleanup,
inbound history retention, and call reports remain separate next slices.

Voice reply delivery is [#17578](https://github.com/paperclipai/paperclip/pull/17578),
head 439d0a86eb75c129c30742a8cc24bf18e2a6ebf3, stacked on #17576. Local selected
checks pass; remote acceptance is pending. Slice 23 starts the inbound admission
cleanup audit in `2026-10-25-voice-inbound-cleanup-sleep-audit.md`. It explicitly
separates retention and reports and requires proof of approval/cleanup handoff,
termination confirmation, and protection against deleting unfinished cleanup.


Voice reply review repairs are published at #17578 head `90caaf3fa9`: shared scoped
worker, actual authority-restoration wiring regression, 191 overlapping selected
consumer tests and workspace types/build passing. Removing the real notification
reproduces the lost reply. Both review threads are resolved; fresh CI/review remain.

Inbound cleanup slice 23 now makes approval/session handoff atomic, after a real
expiry regression reproduced termination of an already authorized call. All 110
voice integration cases and server typechecking pass. This slice is not published:
locked cleanup claims, legacy handoff recovery, bound-guest ownership, termination
confirmation, retention protection and scheduler/producer migration remain required.
The full original inventory, older #17490 E2E failure, and stack/master reconciliation
remain outstanding. No stack PR has been merged by this work.


Slice 23 inbound cleanup now uses committed admission/session changes and actual
expiry/retry deadlines. The admission row separately records physical confirmation
and saved provider account. Locked claims, legacy handoff repair, bound-call owner
handoff, retention/deletion protection and safe same-account rotation are verified.
All 205 selected tests, workspace types and build pass; publication and remote
acceptance remain pending. History retention and call reports remain separate next
slices. Parent #17578 at 90caaf3fa9 has no pending/failed checks and exact-head
Greptile 5/5; the second Paperclip reviewer stopped before completion. The original
remaining inventory, #17490 E2E failure and final reconciliation remain in scope.

## Acceptance follow-up after the plugin parent merged (October 27)

Eighteen preceding sleep PRs are merged through plugin scheduling #17518 at
`96727b3cfefb61f85ffe1fbc29a9b6dd6837efe8`. Health #17554 now includes that
actual master. It remains the next unmerged dependency, followed by company
chat deletion #17561 and Discord registration #17557. Later children cannot be
merged into their feature parents to bypass this order.

See [health acceptance](../idle-tool-connection-health.md#acceptance-follow-up-after-the-plugin-parent-merged-october-27)
for the remaining installer amplification and independent retry repairs, failing
baselines, real concurrency proof, and fresh-database verification. Older stack
status and test counts above are historical. The original remaining inventory
is still in scope beyond the 65 published numbered slices; native backups and
the remaining aggregate duties have not been migrated by this follow-up.

## Receiver follow-up with current Discord parent, October 27

Nineteen sleep PRs are merged through health #17554. Receiver discovery #17572
now includes current Discord parent `cedf2030c4`, retaining the original 27-file
scope. Its existing slow-failure and stop-wake repairs have guarded mutation
proofs, 131 targeted cases pass, and both newly supported external fixtures
self-migrate. See [the owning audit](2026-10-25-chat-receiver-discovery-sleep-audit.md#current-parent-and-review-acceptance-october-27)
for exact evidence and the older CI runner-loss failure. Fresh CI/reviews and
parent landing are still required. The original remaining-duty inventory is unchanged.


## Voice inventory amplification acceptance, October 27

The voice recovery slice keeps the original single-duty scope and adds the
normalized health-observation notification contract. Five real metadata writes
and one health check over 205 future calls previously selected 1,230 call rows;
they now select zero and preserve the saved deadline. Startup and changed-parent
reconstruction use bounded pages and retain concurrent wakes.

The updated [voice audit](2026-10-25-voice-maintenance-sleep-audit.md#voice-session-inventory-amplification-repair-october-27)
records all 725 distinct targeted passing cases, typecheck, build, failed attempts
and guarded regressions. This is worker acceptance, not deployed sleep proof.
Fresh exact-head review and CI remain required before the voice PR can merge.

## Discord registration landing compatibility, October 27

Company deletion has landed. The Discord command slice retains only its original
26-file delta against the landed parent and current master at `f8563d2507`. All
141 targeted cases, server typecheck and build pass. The [owning audit](2026-10-25-discord-command-registration-sleep-audit.md#acceptance-after-the-company-deletion-parent-landed-october-27)
records exact scope, fixture setup and remaining remote gates.


## Receiver integration with landed foundations, October 27

Receiver discovery keeps its 27-file scope on Discord parent `547fdf2139` and
preserves current master queue declarations. All 131 targeted cases, server
typecheck and build pass. See the [receiver audit](2026-10-25-chat-receiver-discovery-sleep-audit.md#landed-foundation-integration-acceptance-october-27).
Fresh exact-head review, CI and parent landing remain required.


## Voice integration with landed foundations, October 27

The bounded voice repair now includes receiver `6e88ca0201` and retains its
22-file scope. All 725 targeted cases, production typecheck and server build pass
again. The [voice audit](2026-10-25-voice-maintenance-sleep-audit.md#landed-foundation-acceptance-october-27)
records exact scope, database setup, the initial partial tool-access run and
remaining remote gates.


## Reply delivery preserves bounded parent reconstruction, October 27

The reply child includes voice recovery `712f3862b5`. Its existing shared-worker
extraction now supports the parent's paged result contract. The real inherited
205-call regression fails before repair and passes afterward; all 445 distinct
targeted cases, production typecheck and server build pass. The [reply audit](2026-10-25-voice-reply-delivery-sleep-audit.md#current-parent-paging-contract-acceptance-october-27)
records the 31-file scope and effects on the four existing shared consumers.
Current-head review, CI and parent landing remain required.

## Voice trusted-policy checkout repair, October 27

Receiver `ab39569250` supplies the landed policy checker now required by trusted
CI. Voice server/package code and tests remain identical to the 725-case tested
head. The policy checker and its Node tests pass. The [voice audit](2026-10-25-voice-maintenance-sleep-audit.md#trusted-policy-checkout-compatibility-october-27)
keeps the four old failed gates, including the independent runner shutdown,
separate from current local evidence. Fresh review and CI remain required.


## Voice review follow-up, October 28

Voice recovery isolates a failed broad inventory retry from ready exact hints
and cached due calls, while retaining on-use authority checks and exact-scope
fences. The generation test uses controlled scheduler turns instead of elapsed
SQL time. All 210 current targeted cases, production typecheck and server build
pass; guarded mutations catch both regressions. The [voice audit](2026-10-25-voice-maintenance-sleep-audit.md#wildcard-failure-and-deterministic-generation-acceptance-october-28)
keeps the actual CI assertion failure and earlier failed attempts separate.


## Reply publication inventory acceptance, October 28

Reply delivery now scopes final publication wakes to the actual conversation and
returns at most 100 identity rows per refresh. Five real publications previously
selected 1,065/1,060 rows across unrelated calls; both paths pass the same 125-row
budget after repair. The [reply audit](2026-10-25-voice-reply-delivery-sleep-audit.md#publication-inventory-and-paging-acceptance-october-28)
records restart, denial-cursor and guarded-mutation coverage. All 449 current
targeted cases, server typecheck/build and the policy check pass on parent
`ad79c7e805`. Fresh exact-head review, CI and parent landing remain required.


## Inbound cleanup current-parent acceptance, October 28

Inbound cleanup #17580 now includes reply parent `d2c0a7de8c` and uses its existing
paged worker contract. Startup yields after 100 rows per scope refresh, and a
same-owner restart reconstructs all 105 saved fixture deadlines. Migration 0395
was generated on the parent's 0394 lineage, preserves all historical SQL/journal
entries, and commits historical backfill in batches of at most 1,000. The
[inbound cleanup audit](2026-10-25-voice-inbound-cleanup-sleep-audit.md#current-parent-acceptance-and-bounded-discovery-october-28)
records 266 passing cases, negative probes, migration lineage, preserved failures,
and limits. Exact-head review, CI, and the preceding stack still must pass before
landing. History retention and call reports remain separate duties.
