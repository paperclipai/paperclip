# Run dispatch without idle retry scans

The run-dispatch module owns retry admission, its durable `scheduled_retry_at`
deadline, and atomic promotion. The heartbeat queue owns concurrency, current
execution authority, and dispatch. The shared coordinator owns notification
coalescing, nonoverlap, transaction uncertainty, drain/resume and shutdown.
The heartbeat facade and `index.ts` only connect these owners.

A scheduled retry is a future obligation. Startup reconstructs its next stored
deadline through the run-dispatch adapter. Writes that create, move, cancel or
invalidate retries notify the retry worker in their transaction. Promotion uses
the existing gate and compare-and-set, and its committed write wakes ordinary
queued dispatch. A queued run behind occupied capacity waits for the owning
run's lifecycle transition. Configuration and authority changes also wake it.
Retry-schedule notifications are separate from ordinary queue eligibility.
`notifyRunDispatch` wakes only queued dispatch; ordinary issue, agent, budget
and company edits cannot repeatedly scan the global retry schedule.
`notifyScheduledRetryDispatch` wakes retry reconciliation as well as dispatch
for actual retry creation, rescheduling and cancellation. Its producers include
bounded and operator-requested retries, recovery retries, native capacity and
safe-replacement successors, and the existing retry-cancellation transition
boundary. Shared runtime changes do not impose a spacing floor on a saved deadline.

An idle queue has no recurring read or timer-driven dispatch attempt. Notifications batch for one second and carry the changed company to queued dispatch. Known retry deadlines still preempt batching. Cancellation-owned retries stay with their cancellation worker and do not retain a promotion deadline.

The supported writer contract is service writes through the shared database
connection scope, including caller-owned and nested transactions. Existing
explicit domain notification boundaries cover lifecycle, issue review state,
agent configuration/status, company lifecycle and scheduling settings. Direct
SQL writers and independent replicas must provide an explicit ingress signal or
restart reconstruction; a process-local signal does not observe their commits.
This change adds no permanent database listener or write interception.

The remaining periodic recovery chain still owns deferred comment receipts,
execution-wait cancellation recovery, orphan/resource recovery, stranded issue
assignments, dependency wake repair, task watchdogs, silent active runs and stale
locks. Those duties retain their backstop until their separate producer/deadline
migrations are qualified. This slice removes only the periodic scheduled-retry
promotion call. Ordinary queued dispatch can still be reached by that backstop;
the existing atomic claim and per-agent start lock prevent duplicate execution.

These workers use internal process deadlines. They do not register Cloud wake
alarms and do not relax the durable idle-sleep safety proof.
