# Agent timer deadlines

The agent timer worker reconstructs its next deadline from existing agent,
company, issue, run, and cost records. It no longer receives a wake from the
server's recurring heartbeat interval. The queue service owns timer policy and
admission; scheduling selects eligible agents and registers the earliest result
with the shared delivery coordinator. No table or independent scheduler is added.

## Deadline and quiet conditions

For an enabled timer with a positive interval, the ordinary deadline is
`(lastHeartbeatAt ?? createdAt) + intervalSec`. Reading it does not advance it.
A due timer retains the existing atomic timestamp claim and queue admission
checks. Successful finalization updates the last heartbeat and moves the next
deadline. An attempted admission still follows the existing claim semantics;
this change does not promise replay of every elapsed interval.

Only active companies and invokable agents with valid reporting chains qualify.
Worktree execution suppression and the worktree issue creation cutoff still
apply. A disabled timer or zero interval has no deadline. When
`skipTimerWhenNoActionableWork` is enabled, the queue's existing actionable-work
predicate must match an assigned, visible, non-conversation task in Todo or
In Progress without a user assignee. Completed history does not qualify.

A reached positive daily run or cost cap defers work until the next UTC day,
or the ordinary interval deadline if later. Either zero cap leaves no timed
obligation: only a policy change can make that timer runnable. An accounting
correction or released run claim can lower today's usage and bring a saved
midnight deadline forward. These producers notify the worker.

Enabled timers that do not require actionable work remain real periodic
obligations. This migration does not silently disable those timers. With no
eligible timer, unresolved transaction, or pending reconciliation, the worker
has no recurring SQL or network scan.

## Producer and transaction ownership

Every notification is registered before the relevant write in its existing
transaction. Nested transactions retain outer commit/rollback ownership through
`packages/db/src/work-signals.ts`. Durable records are the source of truth;
notifications request another read and are not an in-memory queue length.

| Changed facts | Owning producers |
| --- | --- |
| Timer configuration or reporting chain | Agent configuration service, including `updateAgentConfigurationInTransaction`; agent deletion's report reassignment |
| Agent eligibility | Lifecycle status transition hook, including rejection through a saved hire approval |
| Company eligibility | Company update/archive; company budget pause/resume |
| Last heartbeat and daily run claim | Queue timer claim/skip paths, suppression claim release, heartbeat finalization, active-run watchdog finalization |
| Actionable task creation/status/assignment/visibility | Issue create/update/checkout/release/admin release/delete, including checkout's second adoption transaction |
| Restored or reassigned tasks | Subtree cancellation restoration, member archival reassignment, native workspace reconstruction |
| Direct task disarm paths | Queue's invalid workspace block, unrecoverable execution disposition, expired skill harness hiding |
| Conversation/worktree eligibility | Agent conversation prepare/settle; external conversation resume/settle |
| Daily cost corrections | Accounting correction transaction |
| Worktree activation | Experimental settings owner; scheduling requests a fresh suppression read |

Agent creation/approval remains governed by lifecycle preparation and its eventual
status transition. Company deletion requires completed agent termination, which
already removes timer eligibility. Ordinary run insertion, execution-lock changes,
monitor metadata, nonnegative cost accumulation, and terminal run retention do
not create earlier timer eligibility by themselves. In particular, a conversation
cannot satisfy the actionable-task predicate, but its status can change the
separate worktree cutoff gate, so those status writers are still covered.

Supported live writers are the serving process's API and service boundaries.
Independent SQL writers and additional server replicas do not share process-local
notifications. Startup reconstructs their saved state, but there is no live
cross-process delivery promise or unconditional recovery polling fallback.
Such writers require an explicit ingress or durable notification contract.

## Lifecycle and failure behavior

Notifications coalesce for up to the configured heartbeat interval, normally
30 seconds; already-known deadlines can run sooner. Failed reconciliation keeps
bounded retries through the shared coordinator. Intent uncertainty is resolved
by the shared transaction protocol, never by assuming an empty query means a
write cannot commit later.

Idle and maintenance drains pause timer work. The worker retains its request
without passive database polling, then retries in memory until admission resumes.
The timer scan checks cancellation/admission between agents. A skipped candidate
keeps its unclaimed deadline; shutdown stops local scheduling, and restart
reconstructs deadlines from the database. This uses the shared `registerDeadlineWork`
generation protocol rather than a timer-specific recovery loop.

## Verification and limits

`agent-timer-deadlines.test.ts` exercises real PostgreSQL producers, the queue's
deadline policy and CAS, and the delivery coordinator. It measures no SQL after
settlement for empty, disabled, completed-history, capped, and disarmed states;
first-work reactivation; outer commit and rollback; restart; failed reads;
concurrent claims; both drain modes; and interruption between due agents.
Native reconstruction and external conversation suites separately verify outer
transaction visibility and timer notification at their realistic boundaries.
The timer scheduling fixture substitutes adapter enqueue, so these tests do not
prove provider execution or replace existing queue/admission regressions.

Worker quiet is not host sleep qualification. The Cloud alarm protocol still
covers only its explicitly supported durable schedules. Legacy agent timers
remain blocked by the existing sleep-safety proof; this change neither exports
them as Cloud alarms nor relaxes that proof. Deployed database suspension,
host suspension, and wake correctness require separate qualification.

## October 29 master reconciliation and current acceptance

The existing agent-timer slice was reconciled with the qualified issue-monitor
parent using normal merges. Four conflicts needed explicit composition. Startup
keeps both task-drain expiry registration and the timer worker's fresh drain read;
scheduled work keeps the new timer deadline owner; a comment-only conflict has
no runtime effect. The shared deadline helper retains the parent's explicit
continuation interval alongside the new per-worker minimum scan spacing. All
other paths match the automatic merge, and packages remain byte-identical to the
qualified profile-80 parent tree.

Source `32db86c1974dcbf794f01a8c5e42024e2ad071fc` passed **1,710 cases in 49
complete files**, without skips, in 653.08 seconds. This includes the 35 previously
qualified monitor/deadline-consumer files plus real timer policy, CAS and producer
coverage, stale-queue invalidation, native workspace reconstruction, Slack
conversation lifecycle, skill/settings/configuration producers, claim isolation,
five agent-lifecycle module suites, and the new deadline composition regression.
Database build, production server typechecking/build, module boundaries, migration
order and Runner profile identity pass. Twenty-nine fresh PostgreSQL 17 schemas
plus per-file fixtures applied all 412 journal entries through index 413. Every
selected source hash and temporary fixture import was restored exactly.

Four new deadline cases check future and overdue work with and without an explicit
minimum spacing, no dispatch before the selected time, and complete disarming
after settlement. A controlled mutation discarded only the inherited continuation
option while retaining timer spacing: the regression failed. Restoring the
composed source made all four cases pass with the same assertions and timers.
This guards against fixing the timer floor by restoring a 30-second delay for
other workers that deliberately use shorter bounded continuations.

The final monitor-parent publication changed only its audit. All production trees
and 49 selected test hashes remain identical to this accepted source. Final
publication must also adopt the actual merged prerequisite and receive fresh
exact-head CI, security and reviews. No full local repository-suite, live provider,
external alarm delivery, measured instance/database suspension or fleet-cost claim
is made. Existing Cloud alarm coverage and timer sleep-safety gates remain intact.
