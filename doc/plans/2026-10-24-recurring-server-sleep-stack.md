# Recurring server work migration stack

Baseline: `785d54636e1c8513ee5503d602daf6a5ee1970d6` (2026-10-24).

Current integration baseline: master `507dc70be26c191e372f09e58dc0965e73bf8f57`
(October 26). Earlier gate results below are historical; current acceptance is
pending. See the final integration/review-repair section for the current state.

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
| 13 | Routine, agent-timer and issue-monitor scheduling | Remove periodic wake backstops after complete producer coverage; routine execution-status reconciliation separately | Routine schedules implemented in slice 61; issue/agent timers still pending |
| 14 | Skill-version retention and native-harness backup expiration | Separate retention owners and existing retention guarantees | Pending |
| 15 | Automatic database backups | Shared scheduling, actual backup deadlines, existing checkpoint contract | Slice 60 implemented; remote acceptance pending; see `2026-10-26-database-backup-sleep-schedule.md` |
| 16 | Aggregate maintenance tick | Retire enabled and disabled branches after all constituent owners migrate | Pending |
| 17 | Grok routine dispatch | Committed reservations and feature changes; prepared-only recovery | [#17490](https://github.com/paperclipai/paperclip/pull/17490) merged after exact-head 5/5 reviews and passing CI |
| 18 | Abandoned import transfer spools | Creation/completion events, existing retention deadline, startup recovery | [#17835](https://github.com/paperclipai/paperclip/pull/17835), implemented; remote acceptance pending |

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


Inbound cleanup is [#17580](https://github.com/paperclipai/paperclip/pull/17580),
head 4b4bf2d8af6e08d3859ada4b720e7fbd3ea27e24, stacked on #17578. It is
mergeable; CI 40181994295 and review 40181994134 are live with no initial failure.
The final migration applies/replays and its backfill is tested twice. Slice 24
starts the separate inbound-history retention audit. Its deadline preserves both
seven-day age conditions and requires confirmed cleanup plus no task/session
binding. Call reports follow separately. No original remaining scope is removed.

## Slice 24: inbound voice history retention

Branch `codex/sleep-24-voice-inbound-retention` follows inbound cleanup #17580
including its migration runner repair `4f0364d269`. It removes only periodic
history pruning. The existing admission row owns the seven-day deadline and
confirmation/binding conditions. The existing notification helper wakes retention
on outer transaction settlement; no new table or caller wrapper is added.

218 selected tests pass: 131 full voice/app wiring, 24 retention/cleanup lifecycle,
52 deletion/startup, and 11 parent recovery. Workspace typecheck/build and final
server typecheck pass. Tests prove real signed-callback and provider-cleanup
reactivation, pre-deadline quiet, exact deadlines, concurrent binding protection,
restart, drain, rollback, failure and shutdown. Initial fixture failures remain
recorded in the slice audit. Remote checks and review are pending publication.

Next separate owner: voice call-report reconciliation. Preserve the existing
24-hour post-call refresh obligation, transcript ordering, task projection and
provider diagnostics while removing scans with no eligible calls. Inspect
completion semantics before treating a report marked available as fully settled.

Slice 24 is published as [#17583](https://github.com/paperclipai/paperclip/pull/17583)
at `9c38ddfe53`, based on #17580 `4f0364d269`. It is attached to this chat.
CI/review are running; no merge. The next branch is
`codex/sleep-25-voice-call-reports`, with its owner audit recorded separately.

## Slice 25: voice call reports

Report refresh now owns a scoped deadline worker. Terminal transitions, signed
callbacks, and reply call-ended responses activate existing report/session rows.
Attempts save the next retry before provider I/O, and callback/new-attempt fences
prevent stale settlement. The existing 24-hour refresh obligation is preserved,
including available reports. Empty/configured-idle/live/old history is quiet.
This removes the last voice duty from recurring chat maintenance.

Acceptance: 174 selected real-database/wiring cases, workspace typecheck and build
pass. A new integration case exposed missing baseRevisionId on an existing guest
transcript; the fix uses the document revision contract and preserves lock
behavior. Full failure history and external-wake limits are in
`2026-10-25-voice-call-report-sleep-audit.md`. Publication and remote checks follow.
Parent #17583 has a Discord rollback/drain test failure to repair at its owner;
parent #17580 has two new cleanup review findings. Neither is marked complete.
The remaining chat duties, original ledger, #17490 E2E failure, and final
master/stack reconciliation remain required. No stack merge is authorized.

Slice 25 published as [#17586](https://github.com/paperclipai/paperclip/pull/17586).
Parent Discord test settlement and denial-latency repairs are propagated. At the
report tip, 41 Discord tests and 138 full voice/app tests pass; unchanged report,
cleanup and retention workers had 37 passing cases. CI/reviews remain required.
Next owner audit splits Teams unused-consent expiry from abandoned send/upload
attempt recovery, preserving one reason per PR. Company deletion cleanup policy
and the earlier E2E failure remain unresolved completion duties.
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


## Inbound history retention current-parent acceptance, October 28

Retention #17583 includes cleanup parent `b8b12199b9` and preserves its generated
0395 migration. The existing shared page contract now yields after 100 history
rows per scope refresh and resets on same-owner restart. All 280 distinct cases,
server types/build and module boundaries pass. The [retention audit](2026-10-25-voice-inbound-retention-sleep-audit.md#current-parent-paging-and-restart-acceptance-october-28)
records the 13-path scope, real 105-row reconstruction, negative probe, setup and
merge failures, and limits. Latest-head review, CI and parent landing remain
required. Call-report reconciliation follows as a separate duty.


## Retention notification review follow-up, October 28

The current retention review found repeated configuration-driven history scans.
Five real connection saves selected 1,025 rows across 205 retained admissions.
Retention now wakes only for admission writes and startup; cleanup retains all
of its broader scopes. The same writes select zero history rows and preserve the
saved deadline. Confirmed deletes also avoid a redundant reload. The
[retention review ledger](2026-10-25-voice-inbound-retention-sleep-audit.md#configuration-rescan-review-repair-october-28)
records 282 passing cases, types/build, failures, writer coverage and limits.
Current-head review/CI and the earlier stack remain required.


## Report current-parent acceptance, October 28

Report scheduling #17586 integrates retention `68b62b6d13` and uses the existing
shared paged result contract. It yields after 100 headers per scope refresh,
resets same-owner partial scans and retains the finite 24-hour report obligation.
Officially generated migration 0396 preserves the preceding 394 SQL files and
retains the five newest snapshots. The [report acceptance ledger](2026-10-25-voice-call-report-sleep-audit.md#current-parent-reconstruction-and-migration-acceptance-october-28)
records 302 passing cases, types/build, migration/plan checks, guarded restart and
fairness probes, failures and limits. Current-head review, all CI and parent
landing still gate this slice. The full remaining stack stays in scope.


## Report notification review follow-up, October 28

Report reconstruction also received configuration hints that could not alter
its eligibility or saved retry. Five real connection saves over 205 saved
reports selected 1,025 session rows. The report owner now accepts exact session
notifications and startup; those saves select zero rows and preserve the deadline.
The [report notification ledger](2026-10-25-voice-call-report-sleep-audit.md#configuration-scope-review-repair-october-28)
records 303 passing cases, types/build, the narrower contract and limits. Fresh
exact-head review and CI are required after the repair.


## Slice 26: Teams unused-consent expiry

The Teams owner now selects existing unused-consent phases and their saved expiry
through scoped deadline work. Production maintenance retains only abandoned
attempts; these are the next distinct reason. No new table or Cloud alarm policy
is included. The [audit](2026-10-25-teams-consent-expiry-sleep-audit.md) records
222 unique selected passing cases, workspace types/build, and initial fixture
failures. Publication and fresh remote checks/review remain required.
Parent #17586 Actions/security/Greptile pass at 250fca6cff; Paperclip Review is
still running. The original full inventory, older E2E failure, deletion-policy
finding and master reconciliation remain outstanding. No stack PR is merged.


Slice 26 is published as [#17590](https://github.com/paperclipai/paperclip/pull/17590)
at 5ddb4543ed, based on #17586. It is attached; remote gates remain required.
Slice 27 begins the separate Teams abandoned transport-attempt audit. The full
original inventory, older findings and final master reconciliation remain open.


## Slice 27: Teams abandoned transport attempts

Attempt recovery now follows committed claims and saved 90-second deadlines.
It preserves unknown outcomes and performs no provider I/O. This removes the last
Teams periodic maintenance callback; unused consent remains the separate parent
owner. The [audit](2026-10-25-teams-attempt-recovery-sleep-audit.md) records 235
unique selected passing cases and preserved initial test failures. Workspace
typecheck and build pass; publication and remote acceptance remain open.
#17590 has Greptile 5/5; CI is running. #17586 has new review findings for writer
support and report-query indexing. Fix at that parent and propagate before
acceptance. All original remaining work and previous unresolved findings remain.


Teams attempts are published as [#17592](https://github.com/paperclipai/paperclip/pull/17592).
Voice report review repair 94c60683b8 adds the bounded report-window index and
precise keyset pagination, with the single-active-writer contract explicit. The
20,001-old-row cost regression failed before repair, then all 14 report tests,
138 full voice/wiring cases and workspace types/build passed. Both review threads
are resolved. Consent #17590 incorporates it at e501d6c99d; both combined Teams
children pass 30 report/startup tests after propagation. Fresh remote gates still
apply. The next new reason is chat run-milestone projection, separate from wake
notices, terminal confirmations, interaction continuations and GitHub recovery.
The entire original inventory and older unresolved findings remain open.


Slice 28 native finalization checkpoint: existing native finalizer transactions
now signal milestone projection; governed review metadata restoration avoids
unchanged writes and signals only actual changes. Both missing wake and repeated
rewrite were reproduced before repair. All 16 milestone worker cases, nine
selected native chat recovery integrations, and server production types pass.
See the slice audit for failure logs and coverage limits. The production scan
remains until status-decision/effect, admission, lineage, publication, and remaining
producer coverage is complete. This is local progress, not a published migration
or completion of the full stack.


Slice 28 now also covers new native status-decision commits and pending-effect
receipts, after their no-op exits. Two regressions failed first; all 18 milestone
worker cases, nine native chat recovery integrations, and server production types
pass after repair. Real late continuation receipts now reactivate projection.
Next is heartbeat queue/admission/recovery producer coverage. Periodic projection
and all remaining inventory/remote acceptance duties remain outstanding.


Slice 28 queue checkpoint: issue admission, ordinary/comment claims, drain
release, coalesced lineage and native review claims now notify from their owning
transactions. Real missing-wake regressions were reproduced for admission,
coalescence and all ordinary/comment claim/release paths. The 24 milestone worker
cases and 92 existing queue/policy cases pass, as does server production typecheck.
The audit records the initial fixture FK failure, exact logs, remaining raw
cancellation/promotion/receipt writers, and native reviewer acceptance gap.
Periodic projection remains until producer coverage is complete; no new PR or
full-goal completion is claimed.


Slice 28 retry/recovery checkpoint: due retry promotion, suppressed retry and
stale-run cancellation, deferred wake promotion and immediate recovery admission
now signal from their existing transactions. Five real missing-notice regressions
were reproduced before repair; all 166 selected worker/module/policy cases and
server production types pass. The slice audit preserves the initial invalid
staleness fixture and corrected causal evidence. Periodic projection remains
until all supported producers are covered. Remaining original inventory, open
PR gates/findings and final master reconciliation are unchanged.


Slice 28 native wake receipt checkpoint: interrupted recovery, same-scope
coalescence and fresh admission receipt writes now notify from narrow database
transactions. Both missed-recovery and admission-before-receipt races were
reproduced. All 56 milestone/queue cases, 13 existing dependency cases and server
production types pass; four native cases were rerun after fixing external-test
fixture cleanup. The audit preserves setup failures and provider-acceptance
limits. No periodic projector has been removed yet. Fresh remote inspection
still finds #17590 Paperclip Review queued, #17592 neutral, and #17490 E2E shard
3 plus aggregate failing. Those gates and all remaining original scope stay open.


Slice 28 raw queue cancellation checkpoint: general chat-control recovery,
superseded case handoffs, stale scheduled retries and reassigned execution owners
now signal before terminal writes. Missing notices were reproduced for the first
two; replacement-admission tests cover the latter two and their early intent
placement is audited. All 60 milestone/queue tests and server production types
pass. Queued-comment/lineage and remaining dependency producers still prevent
removing periodic projection. No new PR, merge, or full-goal completion is claimed.


Slice 28 lineage checkpoint: queued-comment run-context rewrites, deletion and
cancellation signal through their existing adapter transaction. Real queue
reconstruction and caller-owned discard regressions failed before repair. The
native reviewer claim now has real database integration and causal signal-removal
coverage. All 74 selected worker/adapter/policy cases and server production types
pass. Remaining publication, interaction, configuration, question and monitor
producer coverage still gates periodic-projector removal. Original inventory,
remote gates/findings and final master reconciliation remain open.

## Slice 28 draft and publication/interaction coverage

[Draft #17606](https://github.com/paperclipai/paperclip/pull/17606) is stacked on
#17592. It adds the lifecycle projector worker and covered producer signals;
production registration and polling removal remain intentionally unfinished until
the remaining producer audit is complete. Native progress stays a separate slice.

The latest local checkpoint covers real publication success/failure/operator
resolution and question answer/cancel/withdraw/skip/terminal-expiry paths,
including historical answers that enqueue no continuation. All 160 milestone and
interaction-service cases pass on fresh isolated PostgreSQL databases. Four
existing chat acceptance cases, publication policy cases, and server production
typecheck passed at their recorded checkpoints. See the detailed milestone audit
for retained regression/setup failures, controlled ports and remaining coverage.
The initial draft CI was running; no final green-check or readiness claim is made.


Slice 28 now also wakes lifecycle projection from confirmation accept/reject and
live/historical comment invalidation of questions and confirmations. Six real
producer regressions failed before the added intent signals. All 169 cases across
the worker and interaction-service suites pass, as does production server
typechecking. The draft remains incomplete: other producers and production
registration/polling removal are still pending. See the milestone audit for logs.


Slice 28 creation/sibling replacement now registers intent before the first
interaction write. Both question and confirmation replacement failed before the
fix; all 184 milestone/integration/unit interaction cases and production server
typechecking pass. Remaining terminal-interaction writers are document-target
expiry, deleted-addressee cancellation and startup supersession; other producer
audits and production migration remain pending.


Slice 28 covers the remaining direct terminal-interaction writers in the
interaction service: document-target expiry, deleted addressees and startup
supersession. Seven real-producer regressions failed before the fix; all 191
worker/integration/unit cases and production server typechecking pass. Database
fixture setup/cleanup moved to a cohesive helper, keeping the worker test file
below 1,000 lines. The broader raw-writer audit still includes external services
(secret proposals, tool reviews, conversation reset and native review retirement),
plus the previously listed publication/configuration/recovery dependencies.


Slice 28 now covers binding-proposal terminal reflection and tool-review human
verdict/expiry reflection. Nine governed-producer cases (including outer rollback
and dependent rejection) pass with the lifecycle/interaction suites, 200 total;
all 109 existing tool-gateway cases and server production typechecking pass.
The audit retains the initial invalid tool-publication fixture assertion and
corrected before-fix failures. Native external-review supersession is already
covered by its status-decision outer transaction. Other external interaction and
lineage producers remain under audit; the draft is not production-wired yet.


Slice 28 covers native automatic/obsolete review retirement and conversation
reset with seven additional governed cases, including retained-history and
explicit-request controls. Three missing wakes were reproduced before repair;
207 lifecycle/governed/interaction cases pass. The draft CI chat-shard failure
was reproduced as a test subscribing to unrelated unresolved transaction intent;
isolating that test's DB owner preserves the production protocol and passes three
native review acceptance cases. Server production types pass. The slice audit
retains the invalid fixture and missed test-file selection. Polling removal,
remaining producers, fresh CI/review, older findings and the full inventory remain
unfinished; no stack merge or whole-goal completion is claimed.


Slice 28 also covers interactive callback recovery of an unknown prompt receipt.
Its existing Slack acceptance test failed before the answer-write barrier without
the receipt signal, then five Slack/Discord/Telegram cases and server production
types passed after the one-line integration. File transport and ordinary tool
receipt ordering were audited without adding unnecessary notifications. Remaining
configuration/recovery producers and production wiring still gate polling removal.


## Drain review repair and fresh stack gates

The first broad stack refresh found #17576 Greptile finding 4370544173: dirty
in-memory hints kept the coordinator's settled-write activity hold alive during
drain. SQL silence alone had missed it. It failed a new real-PostgreSQL counter
assertion before repair. The owning parent is fixed at 1b43332c74; all checks now
pass and that review thread is resolved. Slice 22 carries the repair into its
shared dispatcher at b2af095de2. Open/uncertain writes remain fenced centrally;
settled hints and their next deadlines survive resume without holding idle active.

The fix is propagated through #17580 (0aab051900), #17583 (c46bcbf9ff), #17586
(6d99318a8d), #17590 (0bb6de2343), #17592 (6e40ac2570) and #17606 (71a84ee0c0).
Report and retention resume tests initially returned early because their flush
helper checked only the active counter. Those parent-owned tests now advance the
actual retained nextWakeAt and prove the durable result, plus unchanged idle
snapshots while paused. See 2026-10-25-voice-drain-repair.md for all retained
failure logs, including one invalid intermediate report-field assertion.

Verified selection at the combined tip:
- 99 chat lifecycle/governed/voice recovery cases pass.
- 24 Teams consent/abandoned-attempt scheduler cases pass.
- 38 inbound cleanup, retention and call-report cases pass after test repairs.
- Production server typecheck passes. The 108-case full voice integration suite
  passed at the shared-dispatch parent; strengthened reply drain passed separately.

Fresh current-head rollup is saved at
/tmp/sleep-stack-checks-after-drain-20261025.json. #17490 still fails E2E shard 3
and aggregate at 31bcd19888. #17518 Paperclip Review remains pending. #17578 and
newer propagated heads have pending checks, with no failures in that snapshot.
The inbound cleanup/company-deletion review and security finding is NOT repaired
by this drain change; current pending checks do not discharge that finding.
No blind reruns or merges into master occurred.

Next actionable parent audit: tool health (#17554), Discord command registration
(#17557), and receiver discovery (#17572) still contain the same unconditional
hasPending dirty-scope predicate. Reproduce their idle-hold behavior, repair at
their owning branches, and propagate. Their currently passing CI is not evidence
against that missing idle-counter assertion. Then continue milestone configuration
and alternate-receipt coverage, production registration/poll removal, the entire
original inventory, older E2E/cleanup findings and final master reconciliation.

## Configuration drain propagation and resource milestone producers

Discord #17557 at 954a0faa75 and receiver #17572 at 8815dfad38 now carry the
confirmed drain-hold repairs, following tool health #17554 at e685a0e7ef.
The prerequisite #17561 inherited health at 05ac7835fc. Propagation reached
#17576 a4bc3ea50e, #17578 05797e2b9f, #17580 82d023a3a0, #17583 f4f7e14f7a,
#17586 920a951505, #17590 d626ff4b13, #17592 33ffff8a12, and #17606 9775b2bc4a.
All 109 configuration lifecycle/protocol cases pass together after applying the
tip schema to their disposable databases. See the configuration-worker drain
repair document for individual causal failures and parent evidence.

Slice 28 adds real inventory/lifecycle resource reactivation wakes. The two
regressions fail before repair; all 90 milestone lifecycle/governed/resource cases
and six selected provider acceptance cases pass after it. The owning resource
module only wakes reopened issue scopes, never unchanged inventory or completed
history. See the milestone audit for full commands/results and remaining producers.

Fresh gate snapshot /tmp/sleep-stack-gates-configuration-drain-20261025.json has
no failures for slices 1–12 and 14–16, plus #17505; #17490 still fails E2E shard 3
and its aggregate. #17518/#17554 have pending review and later updated heads have
pending checks. New #17576 security finding 4371283330 concerns repeated
connection writes loading every live voice session in that connection. Inspect
and address it without dropping future deadlines or configuration revocation.
The existing #17580 cleanup/company-deletion denial finding remains open. No
review blocker is resolved merely by pushing inherited changes. No PRs merged.

Origin/master refreshed to e335265568 (task-run UI polling removal #17608).
Full base reconciliation, remaining recurring-work slices, milestone startup
wiring, fresh reviews, and all latest-head CI gates remain required.


Slice 28 Telegram migration now registers affected issue intents in its owning
transaction before reactivating/rebinding conversations. The missing wake was
reproduced first. All 92 milestone/resource/governed tests, eight existing
Telegram migration cases, server typecheck and server build pass. Duplicate
migration and unchanged inventory remain quiet. See the milestone audit for
failure and verification logs. Inbound activation and remaining producer audits
still gate production wiring; no recurring projector has been removed yet.

Fresh pre-push gates: #17606 at b634353059 has passing checks; #17572 at
8815dfad38 and #17490 at 31bcd19888 still fail E2E shard 3 and aggregate.
Three local cancellation diagnostic runs passed, including full projects coverage
and a database-only delay, without proving the CI deadlock's competing owner.
Those failures, parent security/deletion findings, all other original slices,
fresh remote review and reconciliation with master 7ebf98eafd remain open.


Slice 28 ordinary ingress now wakes existing milestone debt before reactivating
conversation bindings and writing inbound links. A real Slack ingress regression
failed before repair and passes without depending on a new run being created.
All 12 selected ingress/revocation/Telegram migration cases and server types/build
pass. The milestone audit records evidence, isolated DB, and remaining authority/
lineage producers. This is another producer checkpoint in draft #17606, not
production polling removal or completion of the full requested stack.


Slice 28 now signals successful inbound action settlement and repaired delivery
acceptance for already-admitted runs. Both post-close missing notices reproduced
before repair. All 41 selected post-close/ingress/revocation/migration cases and
server types/build pass; recovery proves it does not admit a second wake. The
audit retains the initial contention-sensitive assertion and its correction to
honor the existing retry. Identity activation and remaining authority/lineage
producers still gate production polling removal. All original slices and older
parent CI/review findings remain required.


Slice 28 identity activation now signals the bound issue before changing the
responsible user. Two before-fix failures now pass with outer commit/rollback,
pending steering, replay and settled quiet checks. All 43 existing identity and
GitHub credential tests pass after repairing their external-DB fixture URL;
server types/build pass. Recovery terminalization/classification writers are the
next audit. Master 34409a92c4 was fetched without disturbing this draft. The
worker is still not production-registered and all original stack duties remain.


Slice 28 now covers orphan-run terminalization in stale-lock recovery. Both
real-producer missing-notice cases failed before repair and pass afterward;
all 40 existing stale-lock ownership/race cases and server types/build pass.
The conditional update and provider/process authority retain their existing
owners. Adapter-failure classification and remaining producer audits still gate
production registration; this does not migrate the stale-lock polling duty itself.


Slice 28 now covers the late adapter-failure classification write, which can
return an old failed run to the existing publication window after the issue's
earlier wake. The missing notice reproduced before repair; all three recovery
milestone cases, 89 recovery-action cases and server types/build pass. Four
classification callers reuse their issue identity, with no new queue table or
provider policy in shared code. Authority/configuration audit and production
wiring remain next; the original full stack and remote gates remain incomplete.


Slice 28 now covers nine real authority-restoration owners: connection/resource
reach, unlinked policy, identity confirmation, four membership paths and task
visibility. Seven initial causal failures plus connection/resource reproductions
now pass; the invalid Discord group-reach fixture is explicitly retained in the
failure record. Final local selection: 50 chat integrations, 18 access tests,
six action-worker tests, server typecheck/build. No provider authorization was
relaxed. Cloud trusted-header membership sync and board claim remain alternate
writers to cover before production registration/poll removal. Older parent
findings and the complete original stack remain open.


Slice 28 now covers Cloud trusted-header sync and board claim. The missing
Cloud notice and absent board-claim intents were reproduced before repair.
All 39 post-close cases plus 30 provisioning/auth/claim cases pass; server types
and build pass. Unchanged Cloud profile synchronization and active board membership
stay silent. See the milestone audit for transaction boundaries and retained logs.
The previous pushed head 0f38d1079d has the recurring E2E shard-3 cancellation
failure; process-identity event append deadlock evidence is retained for diagnosis.
Production registration/poll removal and the entire remaining stack are still open.


Slice 28 production milestone migration: the app now registers the scoped
lifecycle worker and the periodic coordinator invokes only native progress.
The final GitHub guest/sponsor settings owner signals actual authority changes
inside its existing transaction; its missing intent reproduced before repair.
159 worker/startup/coordinator cases, four GitHub acceptance cases and all 16
assembled-app project-chat E2Es pass; server typecheck passes. The milestone
audit has a consolidated alternate-writer disposition table. Native progress
remains the next separate reason. Remote gates, parent findings and the rest of
the original stack are not complete; local cancellation success does not repair
the recorded CI deadlock.


Slice 28 review repair: cover GitHub observed-identity linking, suppress
unchanged native-finalization recovery wakes, and repair the voice callback and
Cloud-auth test contracts. Restore shared user profile after the Cloud authority
test so downstream Slack publication tests see their original identity. Local
40 stale-lock, 122 voice, 38 auth/session and 28 combined chat cases pass; server
typecheck/build pass. See the milestone audit for failed-run dispositions.
Latest-head remote gates and parent failures remain open.

## Slice 29: native chat progress implementation

PR [#17639](https://github.com/paperclipai/paperclip/pull/17639), branch
`codex/sleep-29-native-chat-progress`, parent #17606 at `ed76256b97`.
Native event producers and existing eligibility notifications now wake a scoped
worker. Progress leaves the chat timer; retained history becomes quiet. The
worker retains only unfinished batches, concrete lock contention and failures.
See [the owner audit](2026-10-25-native-chat-progress-sleep-audit.md) for producer
coverage, cursor precision repair, authorization boundaries and retained failures.

Forty-four focused native-progress cases pass, as do 13 app coordinator cases and
the server build/typecheck. All 16 browser chat cases pass before the final
base-publication hook. The hook fixes a reproduced commit-order wake gap; its
19 worker and 13 coordinator cases pass. A second fresh browser run passes all
16 cases at `bcf2f38ff5`; final typecheck passes too. Remote checks/review are pending.
Parent #17606 now has passing checks and Greptile 5/5 on `ed76256b97`; all three
review threads are resolved. This is not completion of the broader stack.

## Current gate update: native progress and inbound notices (2026-10-25)

#17639 at `6c40618ec1bb098e1c7fe4098133d1de71d287ee` now has all checks
passing (CI run 40218349023), a fresh Greptile 5/5 review of that commit, and
zero review threads. The circular signal-payload and over-wide atomic-event
selection failures were repaired, not bypassed by rerunning unchanged failures.
The PR remains unmerged.

Slice 30 now registers its scoped notice worker and removes normal inbound
notices from periodic publication maintenance. Focused acceptance passes 42
cases. Its full verification and new PR are still pending. See the dated inbound
wake notice audit for the producer inventory, regressions and fixture corrections.
This update does not clear the older Grok/runtime-discovery CI failures, voice
session recovery review, or inbound voice cleanup ownership findings, and it does
not shrink the remaining original checklist.


## Slice 30 gate and slice 31 projection checkpoint (2026-10-25)

[#17647](https://github.com/paperclipai/paperclip/pull/17647) at
`fee07f3fa8cbc489cb9bbf657a6065c6e00748c3` has all 53 checks passing,
a fresh Greptile 5/5 review, and its fairness finding resolved. The pre-repair
full chat/startup acceptance passed 1,486 cases; the bounded-candidate repair
passes 44 selected integration cases and server typecheck/build. No merge occurred.

The next separate branch, `codex/sleep-31-failed-retry-notices`, fixes a reproduced
manual-cursor starvation defect and adds scoped, bounded retry-notice projection.
Its normal periodic pass remains until producer/lifecycle migration is complete.
See [the retry notice audit](2026-10-25-failed-retry-notices-sleep-audit.md).

Fresh older-parent audit still shows #17490 at `31bcd19888` and #17572 at
`8815dfad38` failing E2E shard 3 and its aggregate. #17576 still has unresolved
voice inventory amplification findings 4371283330/4371307607, and #17580 still
has unresolved company-offboarding/cleanup findings 4370459800/4370543984. These
are required repairs, not exemptions. The full original migration scope,
master reconciliation, and all latest-head gates remain required.


## Slice 31 worker and producer checkpoint (2026-10-25)

Failed-retry notices now register a scoped worker and leave periodic publication
maintenance. Real missed wakes were reproduced for admission, agent/tree
cancellation, resumed-admission denial, early admission refusal, and requester
restoration. Their owning transactions now notify through the existing shared
boundary. Fourteen selected lifecycle cases and all 1,503 chat/startup acceptance
cases pass. Workspace typecheck and build pass. See the retry audit for retained
failures, exact commands/logs, and native source-cleanup qualification still open.
This is a draft checkpoint, not a merge-ready claim. Older parent gates and every
remaining original recurring-server duty stay in scope. No merge occurred.


## Slice 31 native producer repairs

Draft [#17649](https://github.com/paperclipai/paperclip/pull/17649) now covers
source lease cleanup and reusable-lease retirement, each with a reproduced
missing notice and real writer transaction tests. All 36 selected native/notice
cases pass. The owning audit distinguishes notice authority from the stronger
filesystem execution proof, and retains the fake-clock connection failure and
Runner CI receipt timeout. Existing lease acceptance, updated full acceptance,
remote gates, older parent findings, and every remaining original duty are still
required. No stack PR has been merged.


## Slice 31 accepted checkpoint and slice 32 owner audit

[#17649](https://github.com/paperclipai/paperclip/pull/17649) at
`2384384eeec4f32d073242ebf597b81df2df1ccb` has all 53 checks passing,
fresh Greptile 5/5, and no inline review findings. Full chat/startup acceptance
passes all 1,505 cases on fresh `paperclip_sleep31_native_full_20261025_test`
(`/tmp/sleep31-native-full-chat.log`, 446.10 seconds, exit 0). The lease service
passes 51 tests; focused native/notice acceptance passes 36; final server
typecheck and build pass. This supersedes the earlier slice-31 pending statuses.
The initial Runner receipt timeout did not reproduce after building debug Rust
binaries (10 local tests pass), nor in a controlled 500ms event-loop-delay
experiment. The updated-head remote Runner gate passes without an unchanged-job
retry. Its exact initial cause remains unproven.

The next branch is `codex/sleep-32-terminal-confirmations`, based on the accepted
slice-31 commit. See the terminal confirmation owner audit. There is no slice-32
implementation or PR yet. Older #17490/#17572 CI failures, #17576 inventory
amplification findings, #17580 offboarding/cleanup ownership findings, the entire
remaining original list, final master reconciliation and all final-head checks
remain required. All stack PRs remain unmerged.


## Slice 32 implementation checkpoint

`codex/sleep-32-terminal-confirmations` implements terminal-confirmation recovery
on committed signals and the shared scoped coordinator. Its Telegram owner keeps
payload validation, settlement, continuation staging and activity attribution.
The audit is `2026-10-25-terminal-confirmation-sleep-audit.md`. Nine distinct focused
cases pass across the recorded commands, including real callback failure, outer
commit/rollback, historical waiting/invalid prefixes, and a write during an active
settlement. The new source guard excludes this duty from periodic maintenance.
Full local acceptance, remote review/checks and publication are pending here.
This supersedes the audit-only slice-32 status above. All older stack gates and
every remaining original obligation remain required; no PR is merged.

Slice 32 is now draft [#17651](https://github.com/paperclipai/paperclip/pull/17651).
Initial workspace types/build pass; full chat/startup acceptance passes 1,511 of
1,512, with a prior retry-notice test fake-clock CONNECT_TIMEOUT retained and
corrected. Initial CI passes 51 gates but fails a plugin test at a cron boundary
and its aggregate. A controlled timestamp diagnostic establishes an additional
owed cron occurrence; fixing that fixture clock passes all 28 plugin tests.
Thirteen selected chat lifecycle cases pass after the retry-notice wait fix.
Initial Greptile is 5/5 without findings. Fresh full acceptance and corrected-head
remote gates remain required; see the slice-32 audit for all retained failures.

## Slice 32 accepted-head verification and slice 33 start

At `8b43e6222706491f2d8044af3bf86358085069af`, #17651 passes all
53 remote checks and fresh Greptile 5/5, with no review threads. The corrected
full chat/startup run passed all 1,512 tests on a fresh database in 463.63 seconds;
final server typecheck also passed. Prior failed runs remain documented above.
The PR remains unmerged. Latest fetched master is `67aa87a93b`; final stack
reconciliation and older unresolved gates/reviews remain outstanding.

Slice 33 starts from that accepted head and owns interaction continuation
recovery only. The owner audit is in
`2026-10-25-interaction-continuation-sleep-audit.md`. GitHub history maintenance
and host-sleep eligibility remain separate work.

Slice 33 now implements interaction continuation recovery with committed action
signals, saved retry/claim deadlines, and a scoped call into the existing
publication dispatcher before claiming continuation work. It preserves paused
and future-retry publication behavior. Eleven new real-database cases pass,
including outer rollback/commit, historical prefixes, and concurrent response
commit. Existing Telegram acceptance also passes. Broad acceptance and fresh
PR gates remain pending; no merge or full-stack completion is claimed.

Slice 33 is [#17653](https://github.com/paperclipai/paperclip/pull/17653), draft
and unmerged. Initial broad acceptance passed 1,523 tests with 14 skipped;
workspace types/build passed. Review found that publication preparation could
start another send after drain/standby/shutdown. Three regressions reproduced
it. Per-send admission/abort checks now pass all 14 new lifecycle cases, and the
previously skipped publication suite plus startup guards pass 27 cases with the
external test database. Fresh corrected-head verification remains required.

## Slice 33 accepted verification and GitHub owner split

#17653 at `276ef23d2a0b01b15e6bfb8ff31ab13495741b19` passes all 53
remote checks, fresh Greptile 5/5, and has no unresolved review threads. Workspace
typecheck/build pass. All 1,540 tests across chat integration, standalone
interaction publication, and startup guards passed on a fresh database with no
skips in 473.47 seconds. The initial skipped suite and the stop-boundary failure
remain documented. The PR is unmerged.

Slice 34 starts from that verified head and owns initial GitHub response-comment
acknowledgement delivery. The same maintenance helper also contains terminal
response reconciliation, review-check publication, and late stale-head review
projection repair. Those are separate reasons and remain separate planned PRs.
See `2026-10-25-github-chat-maintenance-sleep-audit.md` for the inspected owners,
producer boundaries, and response-slot dependencies. No GitHub migration is yet
claimed implemented or verified.

## Slice 34: initial GitHub acknowledgement delivery

Based on accepted slice 33 (`276ef23d2a0b01b15e6bfb8ff31ab13495741b19`).
The implementation moves only initial response-comment acknowledgement out of
recurring GitHub maintenance. The existing response actions, fast-response
records, and publication leases own durability. Committed response-slot changes
and actual saved deadlines drive recovery. Terminal responses, review checks,
and stale-head projection remain separate upcoming reasons.

Fourteen new real-PostgreSQL lifecycle cases and the existing startup guard pass.
The producer-removal regression fails as expected when fast-response settlement
has no notification. Migration application/replay pass after adding the generated
concurrent-index migration to the existing top-level execution registry. Broader
local and remote acceptance is pending. See the detailed
[GitHub owner audit](2026-10-25-github-chat-maintenance-sleep-audit.md).

All earlier failing CI, review findings, stack/master reconciliation, and remaining
inventory duties retain their existing requirements. This slice does not claim
that the stack is ready or authorize a merge.

Slice-34 final focused acceptance passes 17 new cases plus the startup guard.
Workspace typecheck/build pass again after the receipt-lifecycle correction.
The fast-response suites pass 69 tests. The initial complete chat run passed
1,554 tests; a fresh complete run with the three added lifecycle regressions
is in progress. No remote gate or full-stack readiness claim is made yet.

## Slice 34 accepted head and slice 35 checkpoint

[#17656](https://github.com/paperclipai/paperclip/pull/17656) at
`43900c1f94500af4c4de1987f9608ac4e12feae6` passes all 53 remote checks,
fresh Greptile 5/5, and has zero review threads. Final chat/publication/startup
acceptance passes all 1,557 tests with no skips in 514.70 seconds. Workspace
types/build and 69 fast-response cases pass. The PR remains draft and unmerged.

Branch `codex/sleep-35-github-terminal-responses` starts from that head.
It extracts provider-owned terminal-state decisions, records successful paused
presentation versions in existing receipts, and adds a scoped worker plus
committed issue/run/response-slot notifications. Eight new real-database
lifecycle cases and nine existing owner cases pass; server types/build pass.
The broader GitHub workflow suite is running. Startup registration and polling
removal wait for the three identified direct issue writers and remaining audit
and acceptance requirements in the terminal-response audit. No slice-35 PR or
full-stack readiness is claimed yet. Earlier parent CI/review findings, all other
inventory duties, and reconciliation with current master remain required.

Slice 35 now covers the reproduced direct tree-restoration, workspace-admission
and exhausted-recovery producers. Real publication-owner tests preserve both
known-unsent cancellation and ambiguous outcome parking. Startup registers the
new terminal worker and recurring GitHub maintenance no longer invokes that duty.
Fourteen new worker cases plus one existing case pass; workspace types/build and
migration application/replay/safety pass. The partial candidate index excludes
10,000 completed rows in a rollback-only query-plan experiment. Fresh full
chat/publication/startup acceptance is running; remote gates remain required.
See the terminal-response audit for all retained failures and scoped evidence.

## Slice 35 accepted; slice 36 wired

Slice 35 is [#17661](https://github.com/paperclipai/paperclip/pull/17661), head
`3d7c79c262f92563555b278d101de8240e6f011b`. Complete local chat/publication/startup
acceptance passed all 1,571 tests in 517.41 seconds. All 53 remote checks passed,
and fresh Greptile is 5/5 with no findings. The PR remains draft and unmerged.

Slice 36, `codex/sleep-36-github-review-checks`, owns GitHub review-check publication.
It uses existing actions and scoped scheduling. Received nonterminal checks retain
the existing five-second remote-head reconciliation deadline because webhook
receipt is not a reliable proof of all future pushes. Completed history and
configuration alone do not schedule work. Current authority, assessment ownership,
provider identity, check replacement, lease fencing, and failure backoff remain
with the GitHub owner. Late stale-head projection repair is the separate next duty.

Eleven new worker tests cover real enqueue and nested transaction settlement,
run-identity wake before a saved deadline, missed-head recovery, lifecycle states,
retry reconstruction, lease contention, a full revoked prefix, retained history,
and HTTP shutdown recovery. The fresh targeted selection passed 36 tests including
existing maintenance/startup cases. Workspace typecheck/build, migration/replay,
and candidate-index evidence passed. Full local acceptance and remote PR gates
remain required. See `2026-10-25-github-review-check-sleep-audit.md` for the failed
attempts, repairs, exact boundary, and external reconciliation limitation.

Slice 36 is draft [#17662](https://github.com/paperclipai/paperclip/pull/17662).
Its initial full local run had 13 failures and 1,569 passes, and CI failed an
inherited login-cleanup fixture. The quiet observation and fake-clock settlement
repairs are documented in its owner audit. The corrected selections passed 23
chat cases and all 16 login-cleanup tests; full/new-head verification is required.
The earlier cancellation browser failures were not reproduced in six local
replays. #17490 and #17572 remain unresolved gates, not inferred green from that
negative result. The next untouched duty remains late stale-head projection repair.

Slice 36 follow-up: all 53 remote checks and fresh 5/5 review passed on
`59f8c8b3e5`. The second local full run had one startup-quiescence assertion
failure and 1,581 passes. Waiting for the actual quiet condition fixes that
fixture; all 211 GitHub workflow tests pass after the change. Fresh remote gates
for the fixture-only commit remain required. The next slice may build on this
commit while those independent gates run; no stack merge is authorized.

Slice 37, codex/sleep-37-github-review-projection, separates late stale-head
review projection repair from periodic chat maintenance. Existing cancellation
receipts and exact admitted deliveries authorize the repair. Committed receipt,
cancellation, and relevant review-state writes wake the provider-owned worker;
assessment ownership is rechecked atomically. The obsolete provider maintenance
wrapper is removed. Explicit manual recovery and the independent missed-webhook
lane remain. No table or Cloud wake contract is added. Ten new real-database
cases plus legacy/startup coverage pass; final scalar-query acceptance and remote
gates remain pending. See the owner audit for fixture failures, repairs, index
plan evidence, and lifecycle limits. Other original inventory items and earlier
stack gates remain open.

Slice 36 final remote gates: all 53 checks passed on 01efd3f4f7, with fresh
Greptile 5/5 and no review threads. Slice 37 final scalar-query selection passed
20 tests; workspace typecheck and build passed. Full local acceptance and remote
PR gates are still pending. No PR in this stack was merged.

## Slice 37 accepted; slice 38 direct webhook recovery

[#17664](https://github.com/paperclipai/paperclip/pull/17664), head
`0a25cae9ef10a8714801d72ac798823de335e050`, has all 53 remote checks
passing and fresh Greptile 5/5 without actionable findings. Complete local
chat/publication/startup acceptance passed 1,592 tests in 556.33 seconds.
The PR remains draft and unmerged.

Slice 38 now routes direct GitHub missed-webhook recovery through saved checkpoint
deadlines and removes the last production chat reconciliation interval. The
required external-source cadence remains only for eligible direct integrations;
Cloud relay registrations and disabled/unconfigured states are quiet. A real
signed installation-deletion regression exposed and fixed a missing producer
notification. Forty-one selected cases pass, including 106-endpoint pagination,
five-item company-fair batches, and an existing default-batch consumer. Complete
acceptance and remote gates remain required. See
[the provider audit](2026-10-25-github-webhook-recovery-sleep-audit.md).

Earlier #17490/#17572 CI failures, #17576/#17580 review findings, the entire
remaining original list, and final reconciliation with master stay open. The
current inspected master is `5a28f7acf8`; no stack PR has been merged.


## Slice 38 review repair and corrected acceptance

Initial #17666 at `936e132c01` has 52 passing checks and a valid Greptile P1:
a receipt committed immediately before drain/stop could suppress a POST that
never started. Four regressions reproduced the loss. The owner now restores a
known-unsent claim with an exact attempt predicate while retaining uncertainty
after transport starts. Fifty-nine selected tests pass; six stop-boundary cases
also cover preservation of a newer receipt. Final verification is running.

The initial broad command passed 1,586 tests in two files but misspelled the
standalone publication filename. The corrected three-file command is running
on a fresh database; the earlier result is not full publication acceptance.
Earlier stack CI/review issues, all remaining migrations, and master reconciliation
remain outstanding. No stack PR is merged or claimed ready as a whole.


Slice 38 production repair is pushed at `491a7e1eef`; fresh review is 5/5 and
the P1 thread is resolved. Workspace types/build passed. The corrected complete
three-suite run passed 1,605 tests and failed one assertion that read the timer
before worker settlement. The assertion now waits for settled idle tracking and
the actual future deadline; all 37 affected lifecycle/publication/startup cases
pass. The full failure remains in the audit; latest-head remote gates are required.
No full-run success or stack completion is inferred from that focused repair.


## Slice 38 accepted; slice 39 retry cancellation

[#17666](https://github.com/paperclipai/paperclip/pull/17666) at
`d8e1bd97f530fc7a5119549a35b871b7b3d9f737` has all 53 remote checks
passing, fresh Greptile 5/5, and its review finding resolved. The PR remains
draft and unmerged. Its earlier local failure and focused repair remain recorded.

Slice 39 separates interrupted scheduled-retry cancellation from the periodic
orphan reaper. Existing run rows and transaction notifications drive bounded
recovery through the existing cancellation owner. No table or external alarm is
added. The producer audit includes dispatch deferral, budget fences, correlated
Stop, lifecycle transitions, settings, and deletion. See
[the owner audit](2026-10-25-scheduled-retry-cancellation-sleep-audit.md).
Thirty route tests and all 34 recovery tests pass. Shared-helper consumers pass
20 tests. Final combined owner acceptance and remote gates remain required.
Earlier #17490/#17572 CI failures, #17576/#17580 review findings, master
reconciliation, and every other original inventory duty remain outstanding.

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

Slice 39 is draft [#17667](https://github.com/paperclipai/paperclip/pull/17667),
initial head `bd490ee50b303187f0ae6f8fe2aa95477d66a40f`, targeting slice 38.
Its initial review was 5/5. The startup repair is now pushed at `ecef7776a4`;
fresh CI and review are required. No merge or full-stack acceptance is claimed.

The instruction-copy audit splits the apparent two reaper calls into three
reasons: stopped collection, captured-byte commit, and post-save directory release.
Slice 40 will own captured-byte commit only. See
[instruction recovery audit](2026-10-25-instruction-recovery-sleep-audit.md).
Existing instruction-copy and directory suites pass 20 and 87 tests respectively
on separate external PostgreSQL databases before any production behavior changes.


## Slice 39 accepted; slice 40 captured instruction commits

[#17667](https://github.com/paperclipai/paperclip/pull/17667), head
`ecef7776a4b38e0c7e0b86d7009fcd01ed7658e5`, has all 53 checks passing,
fresh Greptile 5/5, and no unresolved threads. The startup fixture failure and
repair remain recorded. This PR is still draft and unmerged.

Slice 40 migrates only captured instruction commits. Existing saved bytes,
attempt counts, and retry deadlines drive a bounded worker. Local writes signal
the existing transaction boundary; the revision service still owns authorization,
conflicts, file replacement, and exact-byte replay. A race test exposed a newer
retry deadline being ignored; the attempt claim now checks that it is still due.
Manual/startup recovery shares the guarded owner. Stopped collection and post-save
directory release remain separate duties. No schema migration is needed.

Final instruction acceptance passes 33 tests, directory/startup passes 137, and
startup/instruction-release wiring passes 64 (184 distinct tests across these
selections). Workspace types/build pass. Fresh remote gates remain required.
See the instruction recovery audit for producer coverage and all failed attempts.
Earlier stack CI/review findings and final master reconciliation remain outstanding.

## Slice 40 remote acceptance and slice 41 directory cleanup

Captured instruction commits (#17670) at
`03e1b3cd7270c7438a47562b170b3a9b2dbf112e` now have all 53 checks successful,
fresh Greptile 5/5, and zero unresolved threads. The PR remains unmerged.

Slice 41 owns post-save directory release only. It reconstructs existing cleanup
receipts, signals relevant copy writes and invalidations, and delegates deletion
to the existing directory owner. It schedules saved retry times and leaves
settled history quiet. See [directory cleanup audit](2026-10-25-directory-cleanup-sleep-audit.md)
for producer coverage, lifecycle, index plan, failure history and local tests.
Local verification currently has 200 passing cases across directory, startup,
captured instruction and heartbeat release suites, plus workspace typecheck/build.
Remote acceptance is pending. Stopped collection and the remaining
original inventory and older stack review/CI gates remain outstanding.

## Slice 41 acceptance and slice 42 collection

Parent directory cleanup PR #17671 at
`854244092a993b621ab8efd2ca9f80a0e3b0b9d4` has all 53 checks successful,
Greptile 5/5 at that head, and no unresolved review findings. It remains open.

Slice 42 migrates stopped instruction collection, including terminal-run writers
that make unchanged copy rows eligible. The producer, lifecycle, partial-index,
and verification audit is in
[the stopped collection audit](2026-10-25-stopped-instruction-collection-sleep-audit.md).
The initial eight-suite acceptance selection passed 269 tests; directory-owner
coverage passed 101 separately. Exact-head remote acceptance is still required.
Other native recovery, dispatch, retention, integration and aggregate-tick duties
remain in scope. The older CI/review gates recorded above are not discharged by
this slice's local tests.

## Slice 42 acceptance and slice 43 cancelled workspace preservation

Stopped instruction collection PR #17674 at
`6dc58115cdebb988a63bb45dce4521f5bb5013f6` has all 53 checks successful,
Greptile 5/5 at that head and zero unresolved threads. It remains draft and open.

Slice 43 moves cancelled native workspace preservation out of periodic reaping.
Its owner and producer contract is recorded in
[the preservation audit](2026-10-25-cancelled-workspace-preservation-sleep-audit.md).
It preserves known file debt separately from coordinator/lease readiness and
keeps teardown with the existing stop-only worker. Exact-head remote acceptance
is still required. The full remaining stack and older unresolved gates remain
in scope.

Slice 43 final local acceptance: 120 owner/startup cases plus 209 affected consumer cases pass, without skips. Workspace typecheck/build, final server types, migration application/replay and index-plan checks passed. The negative fixture FK rejection and its correction remain in the owner audit. Remote CI and review are still required.

## Slice 43 accepted; slice 44 obsolete policy reviews

Cancelled workspace preservation is draft [#17677](https://github.com/paperclipai/paperclip/pull/17677) at `33567f91551d60053722c013f0d9b402c1db29e6`. All 53 checks passed, Greptile reviewed that head at 5/5, and there are no unresolved review threads. It remains unmerged.

The native finalization audit found separate historical unsafe-export recovery, obsolete policy-review cleanup, automatic completion-review cleanup, effect delivery, committed response repair, evidence reassessment and workspace/result finalization. Slice 44 owns obsolete policy-review cleanup only. See [its audit](2026-10-25-obsolete-policy-review-sleep-audit.md). The owner/startup selection passes 116 tests after repairing a reproduced notification serialization bug. Consumer and final workspace verification remain pending. Older stack gates and final master reconciliation remain outstanding.

## Slice 44 accepted; slice 45 automatic completion reviews

Obsolete policy-review cleanup is draft [#17679](https://github.com/paperclipai/paperclip/pull/17679) at `e671c66bba6e9a42aa570826e6f3420dba199399`. All 53 checks pass, Greptile reviewed that head at 5/5, and no unresolved threads remain. It is mergeable and unmerged.

Slice 45 owns automatic completion-review retirement only. It preserves direct finalizer ordering and the durable withdrawal trigger for reassessment. The worker's raw lookup propagates failures so failed discovery cannot look empty. See [the audit](2026-10-25-automatic-completion-review-sleep-audit.md). All 370 local owner/startup/consumer tests pass, as do workspace types/build. Exact-head remote gates remain required. Older stack CI/review gaps, master reconciliation and the remaining original duties are still outstanding.

## Slice 45 accepted; slice 46 unsafe-export audit

[#17680](https://github.com/paperclipai/paperclip/pull/17680) at
`be668fb975f119efeb4830405d4bb1ab65791f87` has 53 successful remote gates,
Greptile 5/5 at that head, and no unresolved review threads. It remains draft
and unmerged. The unsafe-export baseline passed all 51 tests on a fresh external
PostgreSQL database (`/tmp/sleep46-baseline.log`). Slice 46 must distinguish
action retirement and eligible result recovery from dormant historical failure.
The periodic backstop remains until all reactivation producers are covered.

Slice 46 now has a scoped worker and initial producer coverage, with the periodic
backstop deliberately retained until the direct-writer audit is complete. See
[the unsafe-export audit](2026-10-25-unsafe-workspace-export-sleep-audit.md) for
work predicates, remaining producers, test evidence, and preserved failures.


## Slice 46 producer wiring and verification

The unsafe-export worker now registers through heartbeat/startup and the periodic
reaper skips its historical scan. Direct task/run/action producers signal their
existing transaction boundaries. Physical-owner contention, real admin/stale-lock
release, queued-run cancellation, cancellation during ownership contention,
shutdown/restart, and multiple discovery pages are tested. The owner/startup and
consumer selections establish 626 distinct passing cases across 13 files after
running the initially skipped lifecycle cases against an explicit database.

A measured retained-history scan justified partial index migration 0398; fresh
application, replay, and validity checks passed. The owner audit records timings,
producer coverage, fixture failures, and the supported writer boundary. Workspace
typechecks and build passed; remote acceptance remains outstanding. Origin/master was fetched at
`6336c34041`; the full stack still needs final reconciliation with master. No PR
in this stack has been merged, and the original remaining scope is unchanged.

## Slice 46 published; slice 47 pending-effects audit

Unsafe-export recovery is draft [#17687](https://github.com/paperclipai/paperclip/pull/17687)
at `b9fe9e2e40ab48104cf18822b5302a740d1957a7`, stacked on #17680. Workspace types
and build passed. Greptile reviewed that exact head at 5/5 with no actionable
findings; full remote CI remains active. This is not acceptance or merge proof.
The attempted full local `pnpm test:run` hit embedded PostgreSQL initialization
failures (15 native-session failures plus database-suite skips) and was stopped
with its log preserved at `/tmp/sleep46-full-tests.log`. It did not pass. The
626 focused external-database cases remain the local acceptance evidence.

Slice 47 begins with native pending status effects. The current writer already
materializes targets and records delivered effects atomically; historical pending
or failed rows still require recovery. The existing owner validates targets and
settles the ledger without recreating effects. The audit and open producer/
ordering questions are in [the pending-effects audit](2026-10-25-native-pending-effects-sleep-audit.md).
Its 72-case status-arbiter baseline passed. No source migration is implemented yet.

Older gates were revalidated: #17490 and #17572 still have E2E shard 3 and aggregate
failures at their recorded heads. #17576 additionally reports an action-required
check. #17580 has successful/neutral CI, but its recorded review findings still
require resolution. These remain part of the full requested stack finish line.


## Slice 46 accepted; slice 47 locally verified

#17687 at `b9fe9e2e40ab48104cf18822b5302a740d1957a7` has all 53 checks passing,
Greptile 5/5, no unresolved review threads, and a mergeable base. It remains
unmerged. Its full-local-suite PostgreSQL failure above remains part of the record.

Slice 47 implements native pending-effect recovery with exact coordinator binding,
commit-aware producers, saved lease/retry deadlines, lock-time eligibility checks,
and pending-only indexed discovery. Periodic finalization skips this duty and
preserves ordering; explicit/startup recovery remains compatible. No provider turn,
new queue table, or host-sleep exemption is introduced. See the
[pending-effects audit](2026-10-25-native-pending-effects-sleep-audit.md).

The expanded consumer run passed 680 tests across 15 files. The final producer
audit found a lease-shortening wake gap; its new real-store regression failed
before the fix and passed afterward. Final owner/startup tests pass 158 cases;
the finalizer rerun passes 29 on a fresh database (683 distinct local cases across
these runs). The initial finalizer rerun reused a fixed company prefix and failed
setup; that failure is preserved. Index discovery was measured with 10,000 delivered
effects and 10,000 completed coordinators. Migration replay and valid/ready checks
pass. Final workspace and remote gates must be recorded before acceptance.

The remaining original scope, older CI/review issues, full master reconciliation,
and all final-head PR gates remain open. No PR has been merged by this stack work.

Final slice 47 source passes workspace typecheck/build and 158 worker/startup
cases, including exact near-term concurrent deadlines. Remote publication and
acceptance are the next gates; local success does not satisfy the full stack.

## Slice 47 published; slice 48 response-owner audit

Slice 47 is draft [#17690](https://github.com/paperclipai/paperclip/pull/17690),
head `56c3601ea605b333141e86e0a810ed790fb6ce48`, based on #17687. Its final local
checks passed; remote CI and Greptile are running. No merge or remote acceptance
is claimed yet.

Slice 48 starts accepted-response presentation recovery, excluding governed-review
presentation. Its current helper conflates dormant/settled work and transient
failures as false; resolve that owner contract before removing its backstop.
The exact null-lease, digest, selected-answer, and publication-authority fences
must remain intact. The existing external-chat baseline passed 33 selected cases;
1,551 others were not selected. See the
[response-presentation audit](2026-10-25-native-response-presentation-sleep-audit.md).

The old action-required check on #17576 is Superagent Security Scan. Its existing
voice-review findings and the older E2E failures remain outstanding. Work on the
rest of the original stack continues; none of these gates are waived.

Slice 48's first owner-contract change now passes the same 33 real-PostgreSQL
response cases plus server typecheck. The strict recovery entry point propagates
operational errors; existing callers keep their logging/boolean contract. No
response worker has been wired and no response polling is removed yet.

The Superagent action-required gate on #17576 was traced to review 5643793631,
inline finding 4371283330: repeated connection/health writes reload the full live
voice-session inventory. This is the already-recorded bounded-discovery issue,
not a missing credential or permission. It still needs a code/test repair and
fresh review; the gate must not be bypassed.

## Slice 47 accepted

[#17690](https://github.com/paperclipai/paperclip/pull/17690) at exact head
`56c3601ea605b333141e86e0a810ed790fb6ce48` has all 53 checks passing, Greptile 5/5
with no actionable findings or review threads, and a mergeable parent. Its PR body
records those gates. It remains draft and unmerged. Evidence is retained in
`/tmp/sleep47-checks-accepted.json`, `/tmp/sleep47-final-gates.json`,
`/tmp/sleep47-review-accepted.json`, and `/tmp/sleep47-review-threads.json`.

Slice 48 remains local and incomplete: owner error separation and the 33-case
baseline pass; candidate discovery, producer coverage, lifecycle wiring, and
periodic removal remain. Older unresolved stack gates and every other original
recurring-server duty still require completion. The active goal is not complete.


## Slice 48 local worker progress

Accepted-response recovery now has a local scoped worker, locked retry/effect
fences, milestone-topic notifications, and live authority registration invalidation.
The final selected real-PostgreSQL/lifecycle run passes 45 cases, and server types
pass. An elapsed-deadline race was reproduced before repair. A generated concurrent
partial index plus expression statistics avoids selected-history scans in the
10,000-row fixture; fresh migration and replay pass. See the
[response audit](2026-10-25-native-response-presentation-sleep-audit.md) for exact
scope and preserved failures.

The worker is not wired into startup and periodic response recovery remains.
Producer coverage, remaining variants/failure tests, large dormant-backlog cost,
full local/remote acceptance, and PR publication are still required. Master was
refreshed to `7703220d38`; the complete stack has not yet been reconciled with it.
No merge, complete migration, whole-instance sleep, or full-goal completion is
claimed.

## Slice 48 producer and lifecycle checkpoint

Response recovery now shares the finalization notification boundary, receives
run-scoped late evidence, and wakes when a paused agent resumes or retry admission
settles. The resume gap was reproduced before fixing it at lifecycle's transaction
boundary. The existing lifecycle suite, both response variants' supporting suites,
and the combined acceptance selection cover 175 distinct passing cases across
runs; server types pass. A real source-row lock verifies retry across drain.
Earlier harness/test failures and the 10,000-unpresented-row discovery measurements
are preserved in the response audit. No startup wiring, periodic removal, PR
publication, remote acceptance, or whole-instance sleep is claimed yet.


## Slice 48 startup integration, 2026-10-26

The response worker now registers under enabled maintenance and releases its
subscription during shutdown. Periodic recovery skips both its direct repair and
already-committed finalizer replay; fresh finalization and explicit recovery stay
active. The startup suite passes 66 cases, and two database regressions confirm
periodic calls defer to the new worker. Workspace types pass. Full local tests
remain in progress with embedded-database initialization failures; build and
remote checks remain pending. The stack goal is still incomplete.


## Slice 48 review repair, 2026-10-26

Draft #17696 is open and attached. Review identified company-wide response reloads
from routine run-status notifications; three real database regressions reproduced
it. Status/claim/release wakes now retain task or exact-run scope while task
lineage remains task-wide. All 34 heartbeat lifecycle and 63 response/authority/
admission tests pass, as do server types and the workspace build. The full local
suite was stopped after repeated embedded PostgreSQL startup failures and remains
unproven. Remote failures at `79bf36cbf8` include an early startup-settlement test
assertion (repaired), a workspace staging timeout, and an E2E runner shutdown.
See the response audit for logs. Fresh-head CI/review, earlier stack findings,
master reconciliation, and all remaining original duties stay open. Nothing merged.


## Slice 48 full-history acceptance repair

Fresh review of `c4beddad1e` is 5/5 with its scope finding resolved. Remote CI
exposed a second early startup assertion. Full local chat verification finished
1,595 passed / seven failed; all seven were new worker tests observing a transient
null deadline or unfinished startup batch. Their settlement predicate now includes
zero active work. All 18 affected cases pass against the full suite's retained
history. Fresh remote acceptance remains pending; these are recorded test repairs,
not a waiver of failed gates or a change to production batch behavior.

## Slice 48 accepted; slice 49 approval producer checkpoint

#17696 at `fad35f2d7ae6bdbb85e709f1bab4633d197fd108` has all 53 checks
passing, Greptile 5/5 at that commit, and zero unresolved review threads. Its PR
body now records those results and preserves the earlier local/remote failures.
It remains draft and unmerged. Evidence is in /tmp/sleep48-final-gates.json,
/tmp/sleep48-final-comments.json and /tmp/sleep48-final-review-threads.json.

Slice 49 has a guarded recovery owner and scoped worker, plus verified approval
producer wakes. The 171-case owner suite and 70 existing approval/budget/queue/
retention consumer cases pass, as does server typecheck. See its audit for the
reproduced missed-wake failures and repaired test stub. Interaction producer
coverage, discovery cost, startup wiring, periodic removal and full acceptance
remain outstanding. No slice 49 PR or whole-instance sleep is claimed. Earlier
stack gates, master reconciliation and every remaining original duty stay in scope.

Slice 49 lifecycle checkpoint: the real agent-resume missed wake was reproduced
and repaired through the existing lifecycle hook. Milestone/finalization scopes
now feed review recovery, and pending-effect settlement supplies its task identity.
The 172-case owner suite and 162 lifecycle/milestone/finalization consumer cases
pass, with server types passing. The owner audit lists remaining interaction, task
authority and coordinator producer evidence. Registration, periodic removal, query
cost, full verification and publication remain outstanding; the full stack scope
and older unresolved gates remain unchanged.

Slice 49 interaction checkpoint: five interaction misses plus task-status and
OAuth-denial misses are reproduced and fixed. Task-scoped notifications cover
existing resolution transactions and direct OAuth/connection cleanup writers.
The complete owner suite passes 180 cases; interaction/telemetry/satisfied-connection/
generic-OAuth consumers pass 249 cases, and server types pass. Skipped telemetry,
external pool-fixture and callback-narrowing failures and repairs are preserved
in the owner audit. Execution-state-only restoration, real coordinator release,
query cost, registration/periodic removal and final acceptance remain. No PR yet,
no merge, and the full original stack scope remains open.


## Slice 49 startup and cost checkpoint

Governed-review response recovery now owns both periodic repair entrances and
registers through heartbeat maintenance. All 255 owner/startup cases, workspace
typecheck and build pass. Pending-policy release, real coordinator retry, SQL-quiet
drain, contention/resume and shutdown/restart are covered. A run-first concurrent
receipt index removes the measured quadratic history lookup (about 3,000 ms to
45 ms on 10,000 selected historical responses). The 10,000 outstanding-item
fixture remains proportional: 101 queries, 2.25 seconds, about 2.05 MB; it stops
between pages on drain. Fresh migration and interrupted/concurrent replay pass.
The audit preserves the initial query, migration and test-clock failures. Full
local tests are running; remote acceptance, older stack findings, master
reconciliation and every remaining original duty are still open. Nothing merged.


## Slice 49 publication; slice 50 owner audit

Draft #17702 at `be6ca6151b` is open on #17696. Greptile reviewed that head
at 5/5 with zero unresolved threads. CI remains in progress. The full local
suite was stopped after repeated embedded PostgreSQL bootstrap failures and
many skipped DB suites. One isolated native-session-executor failure reproduces
in startEmbeddedPostgresTestDatabase before recovery behavior runs; logs are
/tmp/sleep49-full-tests.log and /tmp/sleep49-full-failure-isolated.log. The
255-case real-PostgreSQL owner/startup selection, workspace types/build and
migration replay remain passing. This does not make full local acceptance green.

Slice 50 audits native status reassessment: changed evidence, authoritative task
state and retired automatic reviews all feed the existing append-only assessment
and decision owner. Its producer/guard inventory is in the dated reassessment
audit. No implementation or periodic removal is claimed for slice 50 yet. Earlier
stack gates, master reconciliation and the full remaining scope remain open.


Slice 49 remote acceptance: #17702 at
`be6ca6151bb04e25f691a830734ddb5856701d27` now has all 53 checks passing,
Greptile 5/5 at that exact head and zero unresolved review threads. It remains
draft and unmerged. /tmp/sleep49-final-gates.json, /tmp/sleep49-comments.json
and /tmp/sleep49-review-threads.json preserve the observations. The PR body
records the passing remote gates and keeps the local embedded-database failure
visible. Slice 50 and all other remaining original obligations are incomplete.


Slice 50 extraction checkpoint: reassessment and its pure policy now have native
runtime owners, with the original reconciler delegating to them. All 94 status
corpus cases pass before and after extraction; all 187 governed-response cases
and server types pass afterward. No polling duty has been removed. The audit
records the critical transaction boundary: scheduled guards belong inside the
status committer, which publishes after its own transaction. Producer coverage,
worker selection, lifecycle/cost proof and a new PR remain outstanding.

Slice 50 scheduled-commit checkpoint: nine competing source/lease/deadline/effect/
ownership cases reproduce unsafe scheduled reassessment before the new guard.
The final 103-case status corpus and server types pass. The audit preserves two
initial invalid fixtures and the before-fix constraint rejection. The guard is
opt-in at the existing committer transaction; no outer transaction or early
publication is added. Worker discovery, producer/lifecycle/cost evidence and
periodic removal remain outstanding. No new PR or merge is claimed; all original
remaining duties and older stack gates remain open.

Slice 50 scoped-worker checkpoint: discovery/check/register now use the shared
scheduler, with distinct dormant and retryable outcomes and exact saved deadlines.
A real retirement missed wake and a near-term deadline delay were reproduced and
fixed. Final local verification passes 116 status/worker cases plus 187 governed
response consumer cases; server types pass. Driver SQL capture proves quiet after
settlement and during drain for the tested path. Initial history cost measurements
and their synthetic-fixture limits are recorded in the owner audit. The worker is
not registered in startup and periodic reassessment remains. Producer coverage,
concurrent authority audit, selected-current/backlog cost and full acceptance are
still pending; no slice 50 PR or merge, and the full original scope stays open.

Slice 50 producer checkpoint: six real work-product/attachment transaction misses
and three task mutation misses were reproduced and repaired. The real promotion
HTTP route also wakes reassessment. All 13 owner lifecycle tests, 79 affected
consumer cases across their documented runs, and server types pass. Initial
embedded-PostgreSQL failures and the external-database test repairs are preserved
in the owner audit. Approval/interaction/run evidence and workspace producers,
concurrent authority, backlog cost, startup wiring and periodic removal remain.
Master remains 1fbbef45a8; older stack gates and the full original scope stay open.

Slice 50 authority checkpoint: two real commit-boundary regressions reproduced
stale completion after the source run failed or another run took task execution.
The scheduled retired-review path now rechecks both facts under existing locks.
All 115 status-corpus cases pass. A retained-history startup assertion failed in
the combined run; after waiting for bounded startup batches while enforcing the
saved retry deadline, all 28 lifecycle cases and server types pass. The owner
audit preserves failures and handoff/contract producer findings. Remaining
business-fact races, producer coverage, cost, wiring, periodic removal and PR
acceptance are still open. Nothing merged; the full stack goal is incomplete.

Slice 50 contract checkpoint: a newer committed completion contract reproduced
stale completion; a real uncommitted writer reproduced blocking on the task lock.
The contract owner now exposes a nonblocking current-revision guard, acquired
before status row locks and held through commit. All 145 corpus/lifecycle tests
and server types pass. Failure logs and the lock-order rationale are recorded in
the owner audit. Workspace/governance races, producer coverage, cost, startup
integration, periodic removal, remote acceptance and the rest of the full stack
remain open. Nothing merged.

Slice 50 workspace-barrier checkpoint: three stale-completion regressions now
pass after checking and share-locking the current barrier inside status commit.
The check uses existing row/FK serialization and NOWAIT contention handling.
All 148 status/lifecycle cases and server types pass. The owner audit preserves
before-fix failures and distinguishes barrier receipts from physical workspace
ownership, which still needs audit. Governance/dependencies, remaining producers,
cost, wiring, periodic removal and PR acceptance remain open; nothing merged.

Slice 50 physical-owner checkpoint: four unsafe-completion regressions and a
subsequent release missed wake were reproduced and repaired. Scheduled retired-
review reassessment respects the existing physical lock and durable owner receipt;
normal/verified owner release wakes it through committed intent. All 217 status,
lifecycle and workspace-owner consumer cases and server types pass. Existing
orphan/stop-proof safeguards remain verified. Governance/dependencies, remaining
producers, cost, integration and remote gates remain open, along with all other
original duties and earlier stack findings. Nothing merged.

Slice 50 governance checkpoint: seven stale-completion races reproduced changed
execution policy, approvals, interactions and question history. The governance
owner now supplies nonblocking source locks; status commit verifies the gate
used by the selected decision. All 159 status/lifecycle cases pass, the valid
question-history fixture passes on recheck, and server types pass. Dependency and
remaining authority/producer audits, task-history/query costs, wiring, periodic
removal and remote gates remain outstanding. The full stack remains incomplete;
nothing merged.


Slice 50 dependency checkpoint: seven stale-completion races are reproduced and
fixed through the existing dependency-readiness owner. Scheduled status commit
locks/rechecks prerequisite and workspace-finalization sources with nonblocking
contention handling; ordinary readers retain their behavior. All 181 distinct
status/lifecycle/dependency consumer cases and server types pass. The audit keeps
the initial unordered assertion and misconfigured embedded-test invocation
failures and their repairs. Remaining authority/producer coverage, cost, startup
integration, periodic removal, remote gates, earlier stack findings and the full
original scope remain open. Nothing merged.


Slice 50 evidence checkpoint: seven races reproduced completion using revoked,
removed or concurrently edited evidence. The assessment owner now reclassifies
and locks referenced evidence inside scheduled status commit; changed facts and
contention defer through existing retry handling. All 177 status/lifecycle/
classifier consumer cases and server types pass. The audit preserves before-fix
failures and the remaining identity/producer and cost limits. Startup wiring,
periodic removal, remote gates, older stack findings and all remaining recurring
work are still incomplete. Nothing merged.


Slice 50 OAuth producer checkpoint: authorization-card creation/reopening now
signals both native review workers from the same short transaction as its card
and state link. Three missing-settlement-signal regressions were reproduced;
all 472 tool-access and 30 worker lifecycle tests plus server typecheck pass.
The audit retains before/after evidence and the remaining handoff/authority
coverage limits. Master is freshly verified at 1fbbef45a8. Discovery/cost proof,
startup wiring, periodic removal, remote acceptance, earlier stack findings and
the full original recurring-work scope remain incomplete. Nothing merged.


Slice 50 scale checkpoint: 10,000 separate selected completed task/run histories
produce zero company candidates (~35 ms); 10,000 actual candidates reconstruct
in 101 bounded queries (~1.56 seconds/2.05 MB), with verified drain/abort behavior.
A retired-review task with large review/comment/approval/dependency/workspace
history settles in ~126 ms and disappears from discovery. The audit preserves
two invalid benchmark-fixture attempts and the corrected fresh-task evidence.
A permanent 103-item backlog test proves real settlement and SQL quiet; all 31
lifecycle cases and server types pass. Remaining producer/authority audit,
startup integration, periodic removal, remote gates and the full original stack
scope remain open. Nothing merged.


Slice 50 startup checkpoint: enabled maintenance now registers the reassessment
worker and periodic recovery skips its classification/decision path. The separate
historical supersession guard is preserved before workspace recovery. Two missing
integration regressions fail before the change; all 246 corpus/startup/lifecycle
cases, 32 existing finalization/cleanup consumer cases, and server types pass after.
The owner audit records the intentional separation of reassessment from independent
workspace settlement and the retained failure evidence. Remaining producer/authority
audit, full acceptance, publication, remote gates and all other original duties
remain incomplete. Nothing merged; the goal remains active.


Slice 50 is draft [#17709](https://github.com/paperclipai/paperclip/pull/17709),
based on #17702. Initial head 91a6c14170 passed all 52 CI checks; Greptile 4/5
found direct claim-release writers missing reassessment notifications. Six real
regressions reproduced the gap. Task-scoped signals now cover their existing
transactions; the repaired selection passes 978 cases and server types, with
15 embedded-DB runtime cases excluded for the diagnosed host semaphore exhaustion.
The owner audit preserves the wrong initial ordinary-release completion assertion
and its authority-preserving correction. Fresh-head gates remain pending; nothing
merged. Earlier E2E failures on #17490/#17572 and voice findings on #17576/#17580
were revalidated and remain unresolved. All original remaining duties stay in scope.


Slice 50 repaired-head acceptance: #17709 at
`9a9e4262bb9beb39d67d26320c14e99651b6d6bd` now has all 53 checks passing,
Greptile 5/5 at that exact head and zero unresolved review threads. Its PR body
records the result and retains the local embedded-database limitation. It remains
draft and unmerged. `/tmp/sleep50-release-latest-gates.json` records fresh CI.
Older stack findings and master reconciliation remain outstanding.

Slice 51 is now `codex/sleep-51-retained-native-session-cleanup`, based on that
repaired head. The existing joined discovery has a cohesive native cleanup owner;
scoped reconstruction preserves future lease deadlines. All 35 database discovery/
finalization cases, 72 exact physical-cleanup cases and server types pass. See
[the audit](2026-10-26-retained-native-session-cleanup-sleep-audit.md) for producer,
physical-owner, shutdown and outcome gaps. No scheduled cleanup worker is wired
and periodic cleanup remains enabled. The full scope remains incomplete.


Slice 51 outcome checkpoint: pre-claim database/commit failures now propagate
instead of being discarded as ineligible history. Typed waiting outcomes preserve
process/session/environment/maintenance ownership and the actual coordinator lease
expiry. Four injected failures, a real PostgreSQL row-lock regression and six
waiting-state regressions reproduced the old behavior. The repaired source passes
798 executor cases (15 embedded-DB cases excluded), 36 database cases and server
types; strengthened physical reactivation tests pass all 80 selected cases again.
The owner audit preserves the reused-fixture failure and initial fixture type error.
Worker registration, producer/release notifications, quiet/lifecycle/cost proof,
periodic removal and a slice 51 PR remain outstanding. No polling duty is claimed
removed by this checkpoint; all original stack scope stays active and unmerged.


Slice 51 worker checkpoint: retained cleanup now has scoped shared-scheduler
reconstruction, exact lease deadlines, a concrete process-exit probe and event
waiting for other owners. Startup/manual/scheduled attempts join duplicates and
serialize different inspections. A real finalization-notification missed wake was
reproduced and repaired through the existing transaction fanout. All 19 worker
lifecycle cases, 36 existing cleanup/finalization cases, 37 reassessment consumer
cases and server types pass. The 103-item backlog becomes SQL-quiet after settlement.
Actual local/environment/process/maintenance producer coverage, physical callback
drain ownership, large-history costs, startup wiring, periodic removal, publication
and remote acceptance remain open. Periodic cleanup is still enabled; no new PR
or merge is claimed and the full original stack scope stays active.


Slice 51 durable release checkpoint: six real-producer missed wakes were
reproduced and repaired: single/run-wide lease release, settled process release,
stop-only cleanup, export-resume settlement and confirmed sandbox absence.
Notifications remain run/company-scoped and tied to outer transaction ownership.
All 208 selected worker/environment/workspace consumer cases and server types pass.
The owner audit retains the asynchronous rollback-test failure and correction,
and distinguishes controlled stop evidence from actual physical/provider proof.
Local session and maintenance releases, remaining finalization producers, callback
ownership, startup wiring, cost proof, periodic removal and PR gates remain open.
Periodic cleanup remains enabled. No PR or merge; all original scope stays open.


Slice 51 local owner checkpoint: session execution/initialization releases and
all warm-session retirement paths now emit local scoped hints. Warm removal checks
the expected owner; the existing close/retention decisions remain authoritative.
Three lifecycle regressions reproduced missing release notifications. Final
executor verification passes 798 cases (15 embedded-DB cases excluded), the real
PostgreSQL worker suite passes 26 cases, and server types pass. Retained maintenance
completion and physical callback ownership are next; the audit records the exact
boundary gap. Startup registration, periodic removal, cost proof, remaining
producers and PR acceptance remain incomplete. Nothing published or merged;
all original recurring-server duties and older stack gates remain open.


Slice 51 maintenance and terminal-producer checkpoint: cleanup now owns original
Runner maintenance attempts/callbacks through settlement, using Runner's existing
drain boundary. Finalizer projection and heartbeat terminal writes now notify
cleanup in their transactions. Three reproduced producer regressions include the
real separate-commit decision/projection race. All 64 worker/lifecycle cases,
146 finalizer corpus cases, 799 selected executor cases, 19 Runner settlement
cases and server types pass; 15 embedded-DB cases remain excluded for the recorded
host limitation. The audit records earlier failures and fixture corrections.
Startup wiring, query cost, periodic removal, full gates and publication remain.
No PR or merge; the complete recurring-server scope and older stack gates stay open.


Slice 51 startup integration: the enabled server now registers retained cleanup
and its shutdown subscription. The periodic orphan pass skips this duty; explicit
and startup recovery retain their bounded joined sweep. Heartbeat joins original
scheduled physical operations through shutdown. All 100 startup/worker cases and
server types pass. After the user's explicitly approved cleanup of 11 orphaned
semaphore sets, the full executor suite passes all 814 cases with no exclusions,
including strengthened initialization-release coverage. A 10,000-completed-session
probe measures broad discovery at 28–30 ms locally and run-scoped discovery at
0.030 ms; broad discovery remains linear in history and no deployed claim is made.
Full workspace acceptance, PR publication/review, older gates and every remaining
duty stay open. No merge has occurred.


Slice 51 publication: [#17717](https://github.com/paperclipai/paperclip/pull/17717)
is draft on #17709. Published head `8c62a6b0c0` passed workspace types/build and
received Greptile 5/5, but three CI gates failed: two tests retained the old
heartbeat-owned maintenance drain, and the Copilot transport identity was stale.
The repair follows the cleanup-owned lifetime and creates a new attestation while
preserving old profile history. Full affected recovery/process suites (34 + 408)
and profile tests (69) pass. The local whole-suite OAuth timeout is retained in
the audit alongside a passing complete 472-case isolated rerun. Latest-head CI
and review acceptance are still pending; no stack PR is merged.

The next native finalization audit identifies three distinct remaining duties:
workspace copy-back/validation; accepted-result commit/projection; and resource
settlement after finalization. Current committed-history upkeep repeatedly calls
finalization and best-effort cleanup, including swallowed resource-release
failures. A completed result cannot be used as proof that those residual duties
are finished. Audit first-result publication in `paperclip-control-plane-port.ts`,
workspace operation writes, durable workspace-owner release, retry updates and
cleanup completion before disabling their existing recovery paths. No migration
of these next duties is claimed by slice 51.

## 2026-10-26: verified slice 51 and workspace-finalization migration

[#17717](https://github.com/paperclipai/paperclip/pull/17717) is verified at
`d0036fce3e039e91ab2bf2602e3e6a87a4476491`: all 56 remote check/status entries
passed or intentionally skipped, Greptile 5/5 on that head, and no unresolved
review threads. It remains draft/open and unmerged. The older local full-suite
run was interrupted with exit 130 after current-head CI passed; do not count it
as a local full-suite pass. The separate local resource-limit failure remains
recorded. The explicitly approved 11 semaphore sets were removed once.

Slice 52 is `codex/sleep-52-native-workspace-finalization` on that parent.
[Its audit](2026-10-26-native-workspace-finalization-sleep-audit.md) records the
copy-back obligation, exact owner/proof outcomes, commit/release producers,
shared-scheduler integration, and 12 passing real-database lifecycle cases.
The periodic orphan pass skips only this physical-copyback duty. Result projection
and resource settlement retain existing recovery and are the next separate slices.
Final full verification, publication and review are pending for slice 52. Inspected
master is `a1f77821b9cd5c9c846fdf7a0fa5cc620ad2b6bb`; stack-base propagation is
still outstanding. Older gates (#17490, #17572, #17576, #17580) and the rest of the
requested recurring-server inventory remain active. No merge is authorized.

Slice 52 publication: [#17734](https://github.com/paperclipai/paperclip/pull/17734)
is draft on #17717. Workspace types/build passed. The initial broad command had
582 passes and 88 board-action failures from incorrectly shared external test
fixtures; it is not a pass. Separate databases then pass all 203 cases in four
complete follow-up suites. A reproduced stale-success-barrier regression is
fixed: result reconciliation prefers the existing successful scoped receipt even
when a stale controller later writes failure, without repeating copy-back.
The worker lifecycle now passes all 13 cases. Full-command disposition and
repaired-head remote gates remain pending. No merge; all older gates and later
recurring duties remain in scope.

Slice 52 review repair: initial Greptile 3/5 identified the already-reproduced
stale barrier and missing heartbeat execution-suppression checks. Restore/worktree
regressions both failed red through public heartbeat registration. The worker now
consults the owning suppression policy before discovery/execution, and worktree
activation publishes a reconstruction signal. All 15 lifecycle cases pass,
including real settings activation after quiet. Latest validation/review are still
pending; the scope remains active with no merge.


Slice 52 startup repair: Greptile reached 5/5 at `020ccbc66d` with both threads
resolved, but CI server shard 4/12 found a missing startup fixture method. Added
that method and enabled/disabled lifecycle coverage, then corrected the exact
periodic skip expectation. All 74 startup cases pass. The old-head default local
full run was deliberately interrupted (Vitest 130, wrapper 1) before editing;
it is not a pass. Remote gates and review on the repaired head remain pending.

Follow-up audit: eight earlier native worker registrations gate task drain but
lack the new worker's restore/worktree suppression boundary: retained session
cleanup, status reassessment, governed response, response presentation, pending
effects, unsafe exports, automatic completion review and obsolete policy review.
Verify each duty's prior suppression contract and its settings activation wake
before declaring it safe. This is outstanding stack acceptance work, not a claim
that every listed duty has the same defect. All remaining duties and older gates
remain active; no merge is authorized.


Slice 52 producer audit correction: the hidden PRP coordinator has a second
accepted-result writer. Added its missing transaction-aware workspace hint after
two red real-producer regressions. The complete lifecycle suite passes all 18
cases, covering first result plus outer commit/rollback for both writer paths.
The previous head's startup gate passed, with Greptile 5/5. A separate CI import
hook timeout (118 agent-skills cases skipped) passed all 118 locally and received
one justified job retry. New producer-fix acceptance remains pending. No merge;
all prior gate, suppression-audit and remaining-duty obligations remain open.

## Slice 52 accepted; slice 53 implementation checkpoint

Slice 52 [#17734](https://github.com/paperclipai/paperclip/pull/17734) is verified
at `d5c540b1c0df9aba35262ba121c651806bbca161`: all current checks/statuses pass or
intentionally skip, Greptile 5/5, both review threads resolved. The preceding
startup timeout received one justified retry which passed. The interrupted local
full-suite run remains an interruption, not a local pass. The PR is draft/open.

Slice 53, `codex/sleep-53-native-result-commit`, moves accepted-result commit after
a successful workspace barrier to scoped transaction wakes and saved deadlines.
[Its audit](2026-10-26-native-result-commit-sleep-audit.md) records both real writers,
pending-effect/cancellation handoffs, atomic claim deferrals and 96 focused
passing cases. Committed projection and resource settlement retain existing
recovery. Publication and final local/remote gates remain pending.

Master refreshed to `49bd7a4ba6`; subsequent finalization changes must be reconciled
through the stack before final acceptance. All earlier gate failures, suppression
audits and remaining inventory duties stay open. Nothing was merged.

## Slice 53 accepted; slice 54 projection repair

Slice 53 [#17748](https://github.com/paperclipai/paperclip/pull/17748) is verified at
`1fc2e8c5b61173203abbd50b1b03346abc629218`: all 53 remote checks/status entries
passed, Greptile 5/5 and zero unresolved threads. Local evidence includes 250
passing tests, workspace typechecking and build. The embedded-cluster executor
command was interrupted after PostgreSQL semaphore exhaustion; that run is not
counted as passing. The full local test command was not claimed. The PR remains
draft/open and unmerged.

Slice 54, `codex/sleep-54-native-run-projection`, moves the existing committed run
projection predicate and write into their owner and drives repair from scoped
committed changes. [Its audit](2026-10-26-native-run-projection-sleep-audit.md)
records the reproduced duplicate-event/stale-time/cleanup-ordering races, 400
passing local cases, producer coverage and the retained post-commit/resource
obligations. Workspace typechecking passes; the full local suite remains limited
by embedded PostgreSQL startup capacity. Final local
and remote acceptance is pending. Master refreshed to `ad861a7f94`; stack integration,
prior failed gates, suppression audits and all remaining duties stay in scope.

## Slice 54 accepted; slice 55 recovery-notice resolution

Slice 54 [#17752](https://github.com/paperclipai/paperclip/pull/17752) is verified at
`f98e6b5b57558c78ba111170ab3d8d19ff667827`: all 53 checks/status entries passed,
Greptile 5/5, zero unresolved threads, 400 passing local cases, workspace types
and build. The PR remains draft/open and unmerged. Intermediate failures and the
full-local-suite limitation remain recorded in its audit and PR body.

Slice 55, `codex/sleep-55-native-recovery-notices`, moves only committed native
finalization recovery-notice resolution to scoped transaction wakes. The existing
action rows remain truth; the owner rechecks reused action identities under
lifecycle locks. [Its audit](2026-10-26-native-recovery-notice-sleep-audit.md)
records producer coverage, 102 passing worker/startup cases and 340 passing
affected cases (442 total), plus workspace typechecking. Build and remote
acceptance remain pending. All other inventory, prior gate failures,
suppression audits and master propagation remain active obligations.


## Slice 56: external conversation settlement

This slice moves eligible answered-conversation settlement to committed wakes and
the shared deadline worker. See [the owner, producer, handoff and verification
audit](2026-10-26-external-conversation-settlement-sleep.md). The existing durable
rows remain truth; no table or migration is added. The monitor owner preserves
its recovery handoff, including restart receipts and atomic board escalation.
Periodic native replay delegates only settlement, and generic stranded-task
recovery preserves ordering with a read-only eligibility guard. That generic
scan, Muse completion and resource duties remain separate inventory items.

Based on slice 55 / #17758 at `13f37eef91edce7ee424ec5424c66fc0e6154f4e`.
Master was fetched at `a67a18c171816b097f46eae78fc58c7e55c9c565`; this slice remains
stacked on its parent. Full-stack master propagation and fresh acceptance remain
required. No merge or deployed host-sleep claim is made. See the PR for final
verification and review evidence; a local test pass does not close earlier stack
gate or suppression debts.


## Slice 56 gates; slice 57 Muse terminal settlement

Slice 56 [#17772](https://github.com/paperclipai/paperclip/pull/17772), at
`4d1bc93840ae4bd238814d73249325246f69d76e`, has a successful authoritative Actions
run and Greptile 5/5 with zero unresolved threads. Its external Entire Gates
check still requires trail approval and draft assessment. The superseded run's
cancelled checks are not a new code failure. Do not call all gates green.

Slice 57, `codex/sleep-57-muse-terminal-settlement`, extends the existing Muse
maintenance worker with original-binding terminal debt and scoped transaction
wakes. No new table or independent timer is added. The
[producer and lifecycle audit](2026-10-26-muse-terminal-settlement-sleep.md)
records 433 passing affected cases and workspace typechecking, including the
real finalization serialization regression and its fix. Periodic finalization
delegates only this duty; default live/manual and resource callbacks remain.
Build, publication and remote acceptance are still pending.

Master was fetched again at `a67a18c171816b097f46eae78fc58c7e55c9c565`.
Whole-stack master integration, older failed gates and suppression audits, and
all remaining inventory reasons remain active. Nothing was merged. Existing
active-transport replay polling remains a separate reason to inventory and
migrate, rather than a false claim of whole-instance quiet.

## Slice 57 acceptance and slice 58 environment settlement

Slice 57 [#17793](https://github.com/paperclipai/paperclip/pull/17793) is published
at `be8f3284c2c8a05903f2eca000ad86d046780fec`. Latest-head checks show 53 success
and one neutral result, and the PR is mergeable. Greptile is 5/5 with no unresolved
threads. One failed-job rerun recovered initial runner shutdowns and missing or
truncated logs. The latter individual causes remain unknown. No source change
was needed for that rerun. Nothing was merged.

Slice 58, `codex/sleep-58-native-environment-settlement`, moves the environment
release duty out of periodic native finalization replay. Existing lease records
and the existing release owner's predicate supply debt. Existing native and lease
transactions wake the shared coordinator. Saved cleanup deadlines, workspace
preservation, provider stop evidence, and warm-retention policy keep their owners.
See the [owner and lifecycle audit](2026-10-26-native-environment-settlement-sleep.md).
The initial combined run passed 127 affected tests. Final workspace checks and
remote acceptance remain required before this slice is accepted.

The compound callback's runtime-service release and agent-status projection are
still outstanding. Workspace descriptor cleanup remains separate. All earlier
inventory reasons, master propagation, older failed gates, and suppression debts
remain active; this section does not narrow the original goal.

## October 26 master integration and review repairs

All 60 published branches (58 numbered duties and two auxiliary slices) now
contain master `507dc70be26c191e372f09e58dc0965e73bf8f57` through normal parent
merges. Earlier acceptance entries in this document describe their recorded
historical heads; they do not certify these new integrated heads. The current
stack still requires fresh CI, fresh review, and resolution of outstanding
findings. Nothing has been merged into master.

Three review/compatibility repairs were made at their owning stack boundaries:

- Slice 01 / [#17443](https://github.com/paperclipai/paperclip/pull/17443):
  a successfully read future custom-image expiry now runs at its saved deadline.
  A five-second deadline and an earlier committed replacement previously waited
  for the 30-second retry floor. Failure and unfinished-overdue work retain
  backoff. Slice 02 carries the same correction into the shared deadline helper.
  The new unit and real-producer regressions failed first; root verification
  passed 47 custom-image cases and 39 startup cases. Slice 02 passed 122
  custom-image, secret-proposal and startup cases.
- Slice 17 / [#17518](https://github.com/paperclipai/paperclip/pull/17518):
  plugin inventory notification batching is now an explicit, optional shared
  deadline contract. Only the plugin scheduler opts into its existing bounded
  batching latency; consumers without the option reconcile notifications
  immediately. Known saved deadlines preempt batching, including a ten-second
  job deadline. This preserves bounded full-inventory reads for bursts of
  job-status writes without making every successful expiry pass a cooldown.
  Newly changed plugin configuration retains bounded batching latency. Idle
  queues still disarm. The focused owner run passed 76 cases.
- Slice 51 / [#17717](https://github.com/paperclipai/paperclip/pull/17717):
  HTTP readiness and later worker registration no longer wait for retained
  physical-session cleanup. The existing scheduler-work and delivery owners
  retain the original cleanup promise through idle drain and shutdown. A held
  cleanup regression failed before the fix; 73 startup cases and 28 real-DB
  retained-cleanup cases passed after it.

Combined source revision `6a5ff3683614d8f954986157f158d74b1f653d22` passed
workspace typechecking, the full build, and 246 focused cases across seven
suites. The first combined run exposed the plugin batching dependency: 244
passed and one failed. The explicit batching repair fixed that failure. This
ledger-only follow-up does not alter the tested code. Earlier integrated-tip
validation also covered 470 cases; that remains evidence for its recorded
revision, not a substitute for fresh checks. Full local `test:run` was not
repeated because of the previously recorded embedded PostgreSQL capacity
limitation. Full remote CI remains required.

Known acceptance debt still includes approved-tool rate-limit admission and
permanent recovery classification, native recovery-notice lock ordering,
workspace-export scheduling and plugin completion-persistence CI failures,
cancellation lock failures, several retention/backlog/producer review findings,
and the native-worker scheduling-suppression audit. Passing focused tests does
not close those investigations. The remaining original inventory also remains
in scope; the next native duty audit is agent-status projection. An empty local
runtime-service map is already SQL/network quiet and does not by itself justify
another queue. No deployed host suspension, external alarm coverage, or fleet
savings are claimed by these repairs.

## October 26 approved-review and interrupted-outcome repairs

Slice 05 now retains the originally admitted rate slot through human review,
reconciles durable request/invocation history before dispatch, and settles
permanently invalid records without recurring recovery. Formal approvals still
awaiting human input remain quiet until a committed decision/cancellation; startup
rediscovers them. Configuration/dependency failures retain retry debt, and saved
or unknown provider outcomes are never replayed. The originating branch passed
208 gateway/policy/approval/signature cases and server typechecking.

Propagation preserved each existing owner boundary. Slice 06 retains its shared
Test-tab fixture with optional rate admission. Slice 14 folds formal-review wakes
into the existing approval write transaction; slice 16 carries that signal through
the company-scoped approval notification owner; slice 49 also retains native task
scopes. Eight affected suites passed 506 cases at source
`d4ff4b9c04cbaa3739d1b62f7c29a3bff670c901`, including retention, seeding, and native
review consumers. This is evidence for those integration changes, not separate
certification of each intermediate branch.

Slice 06 additionally preserves saved `cancelled` invocation status, completion
time, and error while repairing a stranded executing request. Its new regression
reproduced the unwanted overwrite; all 14 interrupted-review worker cases passed
at that branch. Final combined source `b91de5102faf548217ea489667fe51de98c9071a`
passes all 129 gateway tests, workspace typechecking, and the full build. This
ledger-only follow-up leaves the tested source unchanged. Full local test:run was
not repeated because of the previously documented embedded PostgreSQL capacity
limitation. Fresh remote CI is still required.

No stack PR was merged. Earlier CI debts, other review findings (including native
notice lock order), the eight native facade suppression audits, the next native
agent-status projection duty, and the rest of the original inventory remain in
scope. These repairs do not establish deployed instance/database suspension.

Slice 58 readiness follow-up: fresh review found its first physical provider
release could block HTTP readiness, just as retained-session cleanup had done.
The startup/shutdown regression reproduced that blockage. Registration now tracks
the worker's ready promise through the existing heartbeat work owner without
awaiting provider cleanup inline. All 84 startup and 20 real-database environment
settlement cases pass, plus workspace typechecking and the full build. This
changes only the last PR; earlier stack qualification and unresolved scope remain
as recorded above. Fresh CI is required and nothing is merged.

## Slice 59: import spool cleanup

Branch `codex/sleep-59-import-spool-cleanup` follows slice 58 at
`929c86e32e00d219b329741dd2c89c40b1a5f826`. Replace the hourly abandoned-upload
scan with root/run-scoped filesystem hints, transaction-aware ledger changes,
and saved 24-hour deadlines. Keep failed/applying files quiet and preserve the
atomic cancellation claim. Database failures no longer count as missing rows
that permit orphan deletion. No new table or external-wake exemption.

The owning three complete suites pass 50 tests with real PostgreSQL and files;
server typechecking passes. The initial outage regression reproduced deletion,
and fixture failures during lifecycle testing are recorded in
[the producer and lifecycle audit](2026-10-26-import-spool-cleanup-sleep.md).
Workspace and remote checks remain separate acceptance gates. This is one
remaining original duty, not a declaration that the inventory or stack is done.

## Slice 60: automatic database backup scheduling

The ordinary backup interval now registers its real deadline with the shared
delivery coordinator. Backup execution, serialization, retention, manual calls,
and the pre-sleep/restart-marker protocol remain with their existing owner.
The coordinator prevents overlap, leaves passive drain/standby waits without
SQL, and joins a scheduled backup during shutdown. Enabled backups still owe
periodic work; this does not claim they become event-only or that Cloud persists
this deadline. Existing host-sleep gates remain unchanged.

Nine worker lifecycle cases and the complete affected six-suite set passed
(152 cases), as did workspace typechecking and the full build. A real PostgreSQL
backup/restore probe also passed after correcting two harness-only errors.
Full local test:run and remote acceptance remain outstanding. See the dedicated
[backup scheduling audit](2026-10-26-database-backup-sleep-schedule.md) for limits.
Skill retention, native harness expiration, and the other original inventory
duties remain open; this is not completion of the full stack request.


## Slice 61: routine schedules

Routine schedules now use their actual saved next-run timestamp and committed
producer changes without the periodic heartbeat wake. The owner includes overdue
catch-up debt, shares eligibility between dispatch and deadline reads, and stops
between claimed trigger batches on drain/shutdown. Added producer coverage includes
manual invocation of a schedule, company lifecycle and deletion, and budget-driven
company pause/resume. Existing cron behavior and Cloud sleep proofs stay with their
owners. Issue-monitor and legacy-agent-timer polling remain separate pending duties.

Two original regressions and two budget-producer regressions failed before their
fixes. Final acceptance passed 224 tests in eight complete suites, workspace
typechecking, and the full build. Embedded PostgreSQL setup timed out, and the old
external disposable cluster later lost a catalog file; a fresh isolated PostgreSQL
cluster ran the same acceptance suites. No further IPC cleanup was performed.
Remote checks/review and full-stack acceptance remain pending. See the
[routine scheduling audit](2026-10-27-routine-schedule-sleep.md) for producer coverage,
lifecycle evidence, harness corrections and the supported single-process writer model.


## Slice 64 — skill-version cache retention (2026-10-27)

The hourly cache scan now reconstructs once and wakes from cache changes,
transaction-owned version/pin changes, and saved grace or terminal-controller
lease deadlines. The existing prune service retains all deletion safety checks.
One active company iterator prevents the 16-cursor cap from restarting a large
multi-company backlog. Unknown pins and failed inspections retain scoped retries;
permanent pins and fully settled history become quiet. This reason is separate
from the still-pending native-harness backup retention duty. See
[the slice audit](2026-10-27-skill-version-retention-sleep-audit.md) for the full
writer inventory, module contracts, local acceptance, and limitations. Remote
review and checks remain pending. The user's October 27 instruction now authorizes
merging qualifying sleep PRs in dependency order after Greptile 5/5 and any
present Ponytail review passes, with all required CI checks passing.

## Slice 65 — archived runner evidence retention (2026-10-27)

Split evidence retention from native-harness backup eligibility in their shared
legacy service. Evidence now reconstructs once, wakes from the existing archive/
quarantine publication signal, and uses saved retention timestamps. Busy or failed
items retain recovery and bounded continuation. The backup timer selects only its
own duty and remains for the next slice. See the
[evidence audit](2026-10-27-runner-evidence-retention-sleep-audit.md) for producer,
clock-boundary, interrupted-cursor, writer-model, and verification evidence.
Local acceptance passes 158 cases plus server typechecking/build. Remote review
and CI are pending; this is not a deployed sleep claim.
