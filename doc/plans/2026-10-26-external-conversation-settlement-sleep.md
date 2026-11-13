# External conversation settlement from committed work

This is slice 56 of the recurring server work stack. Its base is slice 55,
`13f37eef91edce7ee424ec5424c66fc0e6154f4e`. The parent PR is
[#17758](https://github.com/paperclipai/paperclip/pull/17758).

## Obligation and owner

An answered external conversation must move from active to waiting when its
published response is complete and no supported work remains. The existing owner
is `slack-conversation-lifecycle.ts`. Despite the compatibility name, it supports
Slack and Speko-owned tasks. This change does not add other providers or change
which conversations may settle.

Existing conversation, issue, run, publication, wake, interaction, approval,
dependency, and session rows remain authoritative. There is no new table or
migration. A notification means that a predicate may have changed; it does not
establish completion or hold an in-memory queue count as truth.

The owner now shares one readiness reader between discovery and locked execution.
Execution keeps the endpoint-before-issue lock order and rechecks all evidence:
current binding and assignee; visible external task; successful latest run;
authorized published response to the selected wake; committed native result where
required; no newer user input; and no outstanding execution, monitor, goal,
interaction, approval, dependency, wake, or publication. A waiting binding exits
without a redundant update. Provider policy stays in this owner.

## Trigger and recovery

`external-conversation-settlement-work.ts` registers with the existing delivery
coordinator and shared deadline scheduler. Startup and resume reconstruct work
from rows. Narrow issue-ID pages contain at most 100 candidates. A candidate is
not an obligation: discovery applies the full readiness predicate before adding
it to the worker. Execution batches contain at most 25 entries. The worker
rechecks readiness after settlement. Only still-ready work gets a 30-second
retry. Errors use the existing bounded failure backoff.

Empty, configured-but-ineligible, and retained waiting history leave this worker
without a deadline or recurring SQL. Its discovery cost is not zero: startup and
committed changes can inspect multiple rows and make several readiness queries
per candidate. Issue-scoped hints narrow that work. Run-only or company-wide
changes can conservatively invalidate a company. The shared coordinator coalesces
these hints. This is a process-local supported-writer contract, not independent
SQL or multiple-replica change capture.

The heartbeat facade preserves restore and worktree suppression and task drain.
Startup registers only when the heartbeat scheduler is enabled, and also gates
stopped scheduling and warm standby. The existing settings writer wakes the
worker when worktree execution is enabled. Drain retains an unserved wake;
shutdown joins active work; restart reconstructs any remaining obligation.

## Producer audit

| Source or boundary | Relevant transition and notification |
| --- | --- |
| Chat admission, endpoint configuration, resource reopening | Existing chat-run milestones cover new/reactivated bindings and current authority. Repeated inventory and setup metadata are not new settlement work. |
| Run lifecycle, committed native projection and finalization | Existing milestone/finalization fanout covers run completion and committed-result proof. Live finalization can still settle directly. |
| Publication resolution, delivery and cancellation | Scoped publication changes reach milestones. Payload preparation and transport leases alone do not authorize settlement. Both run-first and publication-first completion orders are tested. |
| Issue update, release and deletion | Status, assignment, execution, monitor, visibility, origin and dependency changes signal before the write. Completion/reopening of a blocker and issue deletion invalidate dependents through company scope. |
| Approval links, interaction completion and connection intents | Shared review-state notification now includes external settlement. Pending interaction insertion blocks work; partial verdicts remain pending. Complete verdicts use the shared notification. |
| Comment deletion and tombstoning | Signal before removing newer input. Admission and publication own ordinary message/response changes. |
| Wake queue release, cancellation and retirement | Execution release signals in the adapter transaction. Inbound wake-notice fanout covers company archive, tree cancellation, budget cancellation and rejected chat retry. Wake-status updates retain cancellation fencing. Native status-wake retirement owns an explicit transaction. |
| Task retry receipts | Superseded retry writers already receive their caller transaction. Chat-receipt reconciliation now opens a transaction only for status-changing writes; diagnostic timestamp updates remain ordinary writes. |
| Goal/session changes | Goal status changes and deletion of unfinished goal sessions signal. Agent configuration/deletion and harness-backup session expiry cover alternate deletion paths. Agent Chat reset is outside this owner's applicability; company deletion removes the candidates. |
| Monitor consumption | The monitor owner signals its terminal clear in the transaction. The handoff ordering and restart receipt rules below prevent premature settlement. |

Additional classifications: stopped-comment recovery only updates wait diagnostics
before re-entering ordinary queue admission. Retry coalescing changes counters;
retry run creation and promotion retain a nonterminal run blocker. Dot and Muse
follow-up consumption requires a current running owned assignment, whose eventual
terminal writer supplies the wake. Preserved-result recovery signals finalization
and remains blocked until commit. Native cancellation removes issue eligibility.
Company portability creates fresh issue IDs, does not import live chat/run bindings,
and intentionally imports monitors unarmed; its relation inserts do not unblock
an existing eligible conversation.

## Monitor handoff correction

The old exhausted-monitor path cleared its schedule before it queued recovery.
This exposed an interval in which the conversation looked complete. A failed or
deferred admission also left no monitor to retry. The regression tests reproduce
all three cases through the real monitor owner and database.

For owner recovery, the existing schedule remains until queue admission succeeds.
The ordinary queue receives its existing monitor claim guard, including the saved
schedule and claim timestamp. Deferred or failed admission releases that claim
but retains the obligation. A successful clear uses the same compare-and-set and
monitor-only JSON patch, preserving a replacement monitor and review state.

A saved idempotency key alone does not deduplicate this queue path. Before another
admission, recovery reads the exact saved receipt and its admitted run, with
company, agent, issue, reason and recovery-key binding. This handles restart after
admission but before monitor consumption. A skipped receipt is not acceptance.
Competing admissions still pass the queue's current monitor-claim guard.

Board escalation is different: its existing comment remains unfinished input.
The comment, escalation audit and monitor clear now commit together, with live
audit publication after commit. Settlement cannot observe the clear without the
comment. The separate recovery-child policy keeps its existing child-task path;
this PR does not redesign child creation or claim that it is atomic with clearing
the parent monitor. Terminal client-error clears also notify in their transaction.

## Periodic delegation and remaining work

The periodic native reconciliation call passes
`skipExternalConversationSettlement`; both finalizer branches honor it. Resource
cleanup and Muse callbacks remain enabled. Direct, live and manual finalizer calls
retain default settlement behavior.

Generic stranded-task recovery used to settle before deciding whether to dispatch
another run. Its delegated path must preserve that order. It checks shared pending
readiness and leaves an eligible answered conversation to this worker. Default
manual recovery retains inline settlement. This read-only guard is still executed
by the existing generic recovery scan: that scan is a separate remaining migration.
This PR does not claim that the whole heartbeat loop or server is idle.

The internal scheduler is not an external wake certificate. This PR does not
relax Cloud sleep safety, change durable alarm coverage, prove DB suspension, or
measure host sleep or fleet savings. Other stack duties and master integration
remain in the central inventory.

## Verification and failure record

Local coverage includes existing owner policy, first real producers, outer commit
and rollback, configured-but-ineligible and retained-history quiet, both response
completion orders, restore/worktree gates, drain/failure/restart, joined shutdown,
independent goal/comment/approval/dependency/wake releases, monitor handoff and
receipt reconstruction, pagination beyond 100 ineligible candidates, generic
recovery ordering, and preserved native resource settlement. Owner and publication
paths use PostgreSQL. Monitor handoff delay/failure tests control admission;
separate existing monitor tests exercise the actual heartbeat queue. They are not
proof of a successful external provider run. Native resource tests observe the
real reconciler with its original settlement function, not a replacement policy.

Material failures were retained during development:

- Initial producer regressions exposed missing execution-release and approval
  wakes. A later flush assertion was too early; it now waits for active work too.
- The readiness reader originally required a root DB type; it now accepts its
  actual select/execute capability, including transactions.
- The real retry-receipt test exposed a root notification without a transaction.
  Work signals require transaction ownership; they do not wrap autocommit writes.
- Startup expected options needed the new delegation flag. A generic recovery
  test needed its existing created-at cutoff to exclude retained test fixtures.
- Monitor regressions exposed premature readiness and lost deferred/failed
  handoffs. Restart testing then exposed the lack of automatic key deduplication.
- Review caught a restart edge case: the monitor limit reason can change from
  attempts exhausted to timeout after admission but before clear. Two regression
  cases failed before the fix. Recovery now uses the monitor schedule as identity
  and recognizes both legacy reason-bearing receipt keys, retaining company,
  assignee, issue, and admitted-run binding. A different schedule is not reused.
- CI shard 1 exposed a stale cancellation fault injection: spying on root
  `db.update` no longer fails writes owned by transactions. The failure reproduced
  locally. The test now injects a PostgreSQL failure at the target run's cancelled
  transition and checks that the process stops even though the row stays running.
- The first CI serialized shard 5 run timed out on the first agent live-run route
  history test (15 seconds). Its unchanged 92-test suite passed locally; that does
  not establish a root cause. Fresh CI after the recovery fix remains required.
- A board escalation expectation incorrectly treated its new comment as finished.
  The test now preserves the existing policy; comment and clear are atomic.
- Additional verification caught a nullable guard type, an extra query parenthesis,
  and a pagination fixture missing its required external label. These were fixed
  before acceptance. The latter failed during fixture insertion, not execution.
- Test DB setup first used a missing root TypeScript executable; the database
  package's installed runtime creates and migrates the isolated test databases.

The PR verification section records final commands and results. The host has
already exhausted embedded PostgreSQL semaphore capacity during earlier full-suite
runs. The specifically approved 11 orphan sets were removed once; this slice uses
validated dedicated external test database overrides, not more shared-OS cleanup.
Fresh CI must run the complete suite. No local full-suite success is claimed.

## Coalesced monitor recovery receipts (October 27 follow-up)

Review identified a second accepted receipt form. The ordinary queue admission
writer can join recovery to an existing execution and persist the same monitor
schedule key with reason `issue_execution_same_name` and status `coalesced`.
The monitor's acceptance query previously required `issue_monitor_recovery`.
After a restart between admission and monitor consumption, it could miss the
receipt and enqueue recovery again after the joined run finished.

A new real PostgreSQL regression calls `createWakeAdmissionWriter` inside its
transaction scope, checks the persisted coalesced receipt, finishes the joined
run, and retries the monitor. Before the fix, the enqueue spy was called once,
contrary to the no-duplicate expectation. The fix accepts both receipt reasons.
It preserves the company, agent, issue payload, admitted-run join, exact current
or legacy schedule key, and non-skipped status checks. A receipt for a different
schedule remains ineligible for either reason. No new timer, table, or wrapper
is added.

At owner source based on `cd618c6effd8d071f61c28a8f55121d36bc081b0`, both complete
`slack-conversation-lifecycle` and `issue-monitor-scheduler` suites pass all 96
cases with no skips, using separate disposable PostgreSQL databases. Server
typechecking passes. The failed pre-fix regression remains in the verification
record; this is a deterministic query correction, not a flaky-test retry. Remote
checks still must pass on the published follow-up head. No additional provider
execution or deployed sleep qualification is claimed.

## Startup readiness follow-up (2026-10-27)

External conversation settlement can wait on endpoint or task locks. A held-worker
regression reproduced HTTP startup waiting for that recovery. Registration now
tracks its readiness promise through the existing heartbeat shutdown owner rather
than awaiting it before HTTP becomes ready. Coordinator cancellation and shutdown
joining remain intact; no polling, timer, or durable state is added. All 89 startup
cases pass on the master-integrated branch, including the failing-before-fix case.
Full integrated typechecking and current-head CI remain separate gates.

## Current master integration and indirect wake audit (2026-10-29)

Production and regression source `50f4432ed88537b8d522cf1dce24c33588db0bac` contains the reviewed slice 55
parent `2a8777bbed8b1e10810e3d6d99aae3f25b4854ef`. That prerequisite merged as `8ac5a128e66fb672e88106412f76cf278599bfc4`.
A normal merge adopted the actual squash after proving that the reviewed parent
and squash have identical complete trees. The complete accepted child tree stayed
unchanged. This publication adds only this audit to that source.

The parent composition proof retains 1,203 parent-only paths, 20 owned-only paths,
11,512 identical paths, and 19 shared automatic merge results. Five explicit
resolutions preserve the source-generation checks for accepted chat handoff,
task-before-comment locks, issue-specific decision invalidation, and current
conversation event columns. The explicit company-authority notification remains
active. Runner packages equal the parent byte for byte. Current profile 80 and
its historical profile fixtures are preserved; this slice does not requalify a
live provider.

A database regression exposed recurring candidate SQL after routine company-only
maintenance hints. Restoring the original unconditional fanout failed both the
native and chat cases. Adding only the ordinary issue/run guards fixed the native
case, but the chat case still made three candidate queries. That failed attempt
remains part of the evidence. The indirect path was through the shared inbound
wake-notice and response-availability helpers.

Both shared helpers now keep settlement notification enabled by default. Their
existing callers include valid company-wide producers, so dropping broad scopes
globally would lose work. Only the milestone dispatcher disables their duplicate
settlement fanout. Its scoped issue-review notification already signals real
work. The explicit company-authority helper still signals company changes. No
new table, polling loop, or producer wrappers were added.

Four database cases cover both directions: coarse native/chat hints cause zero
settlement candidate SQL after quiet, while real inbound-notice and response
changes at company scope still settle an answered conversation. A controlled
indirect baseline fails one of these cases and passes three; the repaired source
passes all four. The test hash is identical across that final red/green pair.
All temporary production changes restore byte for byte.

Local acceptance covers 3,129 distinct cases across 37 complete server test
files, plus 18 selected committed-chat-response cases (3,147 selected cases
in total). The other 1,796 chat integration cases were outside the local
selection. Coverage includes the full settlement, queue, monitor scheduling,
run-state, goal, decision-target, interaction, task Retry, projection, result
commit, workspace, process recovery, and review consumers. The 38 selected test
files restore to their exact committed hashes after temporary fixture imports.
Prepared fixtures use PostgreSQL 17 and 412 migration receipts through journal tag
0413_tired_kronos; helpers create
additional fresh per-call fixtures where required.

Failure accounting: the initial 35-file command passed 2,445 cases and timed out
one restored-work handoff case at its existing 15-second limit. It is not a
passing aggregate command. The complete unchanged 89-case recovery-actions file
then passed on a fresh fixture; that case took 22 ms. The timeout's root cause was
not established. The earlier 34 passing files and the fresh full-file result
provide distinct-case coverage without counting the other 88 actions cases
twice. No assertion, timeout, or test selection was weakened to hide the failure.
The remaining complete process and review files and the targeted chat selection
also pass. Fresh publication-head CI is still required.

Database build, server production typechecking and build, module boundaries,
migration order, and current Copilot profile identity pass on this source.
The entire packages tree equals the parent that already qualified the current
profile-80 runtime. This is not full local repository acceptance, full chat-suite
acceptance, deployed sleep, database suspension, external alarm coverage, or a
fleet cost claim. Supported writers remain in-process; independent SQL and other
replicas need their own ingress contract. Existing Cloud sleep blockers remain.
