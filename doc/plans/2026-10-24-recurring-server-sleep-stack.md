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
| 01 | Custom-image setup expiry | Session writes, existing expiry, startup/retry/drain | [#17443](https://github.com/paperclipai/paperclip/pull/17443), all checks passed, Greptile 5/5 at `36844a458b` |
| 02 | Remaining chat maintenance | Provider runtime discovery; voice reconciliation; milestones; wake notices; interaction continuations; terminal confirmations; GitHub recovery; Teams maintenance, separately by owner | Pending |
| 03 | Run and task recovery | Orphan runs and active leases; shutdown workspace settlement; scheduled retries; queued runs; stranded assignments; resolved dependencies; task watchdogs; silent-run monitoring; stale locks | Pending |
| 04 | Decision retention and notifications | Retention deadlines and notification delivery are separate reasons | Pending |
| 05 | Decision expiry and interrupted effects | Expiry, effect recovery, continuation recovery | Pending |
| 06 | Tool connection health | Configuration/use activation and defined proactive health deadlines | Pending |
| 07 | Secret proposals, tool reviews, gateway tokens | Separate expiry/scrub/recovery owners | Secret proposals: [#17446](https://github.com/paperclipai/paperclip/pull/17446), checks passed at `d41590ac0e`; gateway credentials: [#17450](https://github.com/paperclipai/paperclip/pull/17450), Greptile 5/5 at `c5c53fc43f`, fresh CI running; pending tool-review expiry: [#17453](https://github.com/paperclipai/paperclip/pull/17453), local verification passed and CI/review running; other review duties pending |
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
