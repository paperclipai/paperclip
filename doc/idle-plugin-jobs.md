# Plugin job scheduling without idle polling

Plugin cron scheduling uses the instance delivery coordinator. It no longer
queries `plugin_jobs` every 30 seconds when there is no eligible work.

## Ownership and durable state

The plugin scheduler owns cron interpretation, dispatch eligibility, concurrency,
and run settlement. `plugin_jobs` stores schedules and their next deadlines;
`plugin_job_runs` records admitted calls and their outcomes. No table or migration
is added. The application passes its existing coordinator to `scheduler.start`.
The coordinator owns timer execution, transaction uncertainty, and drain gating.

The job store and registry signal before changes inside their transactions.
Definition sync, pause/resume, changed schedules, run creation/settlement, job
removal, and plugin removal invalidate the scheduler. Nested transactions wake
only after their outer transaction settles. An empty manifest is a real sync:
both the loader and lifecycle coordinator pause removed definitions.
Registration and worker status changes provide local lifecycle wakes. The shared
`registerDeadlineWork` helper retains explicit wakes received during drain,
including a worker becoming available without a database mutation.

## Idle and dispatch behavior

- Empty instances, manual-only jobs, invalid cron definitions, paused jobs, and
  unavailable workers have no recurring scheduler SQL after reconciliation.
- Configured future jobs arm their saved next deadline. No SQL is needed between
  reconciliation and that deadline unless a supported producer changes state.
- Startup reconstructs deadlines. An overdue saved timestamp is owed work and
  is not replaced merely because the plugin registered again. A missed schedule
  dispatches once, then computes its next cron time after completion.
- A missing timestamp is initialized from the current cron expression. A changed
  cron clears the old timestamp so the new schedule can be initialized. Registry
  updates lock the job before reading its current deadline, so a concurrent
  completion cannot have its newly advanced deadline replaced by a stale value.
- Claims recheck the definition under a job-row lock and reject outstanding
  queued, pending, or running records. Manual and scheduled dispatch share this
  boundary. Worker RPC calls run outside transactions.
- Active calls consume concurrency slots and remain tracked until settlement.
  Their completion requests a coalesced refresh for waiting work. Slow calls do not
  prevent other available slots from being used.
- Completion and the scheduled job's next timestamp commit together. Failed
  persistence retries the retained settlement, not the plugin side effect.
  A concurrent schedule edit is preserved by the settlement check. Failed
  settlements do not prevent independent jobs from using available capacity.
  The failed job stays excluded from admission until its exact result is saved.
- Stop rejects new admissions, detaches worker subscriptions, and waits for
  admitted work, then flushes retained completion results without another RPC.
  If persistence still fails, stop rejects and retains the result for another
  attempt; it does not report successful shutdown. Existing calls retain their
  RPC timeout. A failed stop still allows application and plugin-worker cleanup;
  teardown then retries the retained settlement once before reporting any remaining
  error, while the database pool is open.

Producer and lifecycle wakes share a 30-second minimum refresh spacing, matching
the former scan budget. Sequential run-status writes coalesce instead of each
causing a full inventory scan. This is a bound on requested refreshes, not a
recurring timer: settled workers without a future obligation remain disarmed.
Manual dispatch still uses its direct claim path. New schedules and completion-
released capacity can wait up to that spacing before scheduled dispatch.

## Limits

This is the existing single-process writer model. Independent SQL writers and
other app replicas do not emit these local signals. The row lock prevents an
overlapping claim, but does not establish a supported multi-replica wake protocol.

A process crash after a plugin call but before durable completion leaves an
unresolved run. The scheduler does not assume that an unknown external effect is
safe to repeat. Such a run remains outstanding until explicit lifecycle/operator
reconciliation. During a live process, failed completion writes retain their
exact result and retry. This does not invent exactly-once external execution.

Plugin definitions remain instance-scoped, as on the base branch. The separate
company-scoped job proposal is not implemented here. Plugin configuration and
worker authorization retain their existing owners.

The Cloud sleep proof remains conservative for plugin work. An internal cron
deadline cannot wake a stopped host; this PR does not add external alarm coverage,
allow configured plugins to bypass idle checks, or claim measured host sleep.

## Verification

`plugin-scheduled-work.test.ts` uses real PostgreSQL and controlled worker calls.
It checks idle SQL silence with no jobs and configured future/manual-only jobs;
first writes, pause/resume, worker availability, outer commit and rollback;
restart and overdue execution; removed schedules; concurrent claims; failed
completion persistence without repeated RPC; capacity refill; drain; and shutdown.
Worker responses are simulated. Existing startup, authorization, loader, shared
coordinator, decision-expiry, and warm-standby tests cover affected consumers.

## Review repair evidence

Real PostgreSQL regressions reproduced three failures: shutdown returned with a
known completed call still marked running; one unwritable completion prevented an
independent job from starting; and a concurrent unchanged registry update restored
an old deadline. All three pass after the repair. The shutdown test initially
expected an unresolved-work hold to disappear, which was incorrect. Its corrected
baseline stops the coordinator, then observes the actual running-row failure.
A further case verifies that persistent shutdown-write failure is reported and
a later stop attempt saves the retained result without repeating the RPC.

A permanent database outage followed by forced process termination still has the
process-loss limitation above. This change does not claim durable storage for an
external effect that the database has never acknowledged.

The final focused run passes 62 cases across plugin scheduling, loader recovery,
warm standby, and the delivery coordinator. Server typechecking passes. Remote
checks and a fresh review remain required for the repaired head.


A second review reproduced 16 full inventory reads during fifteen sequential run
lifecycles on forty manual jobs. Restoring the prior 30-second spacing bounds that
burst to one read, then reconciliation returns to zero SQL. Shutdown regressions
also reproduced skipped cleanup after a settlement error. The shared teardown
boundary now always attempts remaining cleanup and retries a failed stop once;
both application teardown and plugin-loader shutdown use it. A PostgreSQL trigger
case verifies the retained result is saved after cleanup removes the write fault,
without a second worker RPC. Persistent failures remain visible.

The first expanded timing run failed fifteen assertions because the test assumed
one second was sufficient to settle a coalesced wake. Tests now wait for the actual
null/future deadline before measuring three minutes of SQL silence. The corrected
run passed all 75 cases; the additional post-cleanup retry case is verified separately
below. No production timeout or quiet assertion was relaxed.

The post-cleanup retry run passes all 48 shutdown/plugin cases (28 plugin and
20 shutdown). Together with the unchanged consumer selection this covers 76
unique cases. Server typecheck and build pass on the final round-two repair.


## Reservation and unregister races

A scheduled refresh can yield after selecting eligible jobs while a manual trigger
reserves one of those jobs. Previously the stale scheduled attempt reused the
same set entry, found the manual run under its row lock, and removed that entry.
The manual provider call was still running but no longer consumed scheduler
capacity. Dispatch now performs the synchronous reservation check and insertion
at one boundary; callers cannot remove a reservation they did not create. Refresh
also rechecks active and retained-settlement state after its database read.

Unregister now preserves runs whose real result is retained for settlement. For
other unfinished runs, it locks and rereads the current run before cancelling, so
a completion committed since discovery cannot be overwritten. The existing job
store still owns mutation notifications. Provider calls stay outside transactions;
no new periodic work or durable storage is introduced.

Real PostgreSQL regressions first reproduced both incorrect cancellation of saved
success/failure results and loss of a manual reservation after a delayed query
result. The corrected suite also checks concurrent completion during unregister,
manual/scheduled capacity, retries without another provider call, drain/resume,
startup, shutdown and quiet states. All 33 complete scheduler cases and server
TypeScript checks pass on the owning slice. The first full run crossed the next
hourly cron boundary during a retry fixture and legitimately produced extra runs;
its fixed clock now isolates that test from wall-clock start time while preserving
its assertions. Stack integration and latest-head CI are separate gates.


## Bounded completion writes

A retained completion transaction now sets a PostgreSQL statement timeout local
to that transaction, thirty seconds by default. A database row lock cannot hold
the completion attempt forever. Both ordinary reconciliation and the final
shutdown flush use the same retained writer. On timeout, the result remains in
memory and the existing recovery owner can retry it without invoking the plugin
again. Shutdown reports the persistence failure and continues through the existing
cleanup/retry boundary. The timeout resets when the transaction ends; no shared
pool setting or polling loop is added.

The bound applies to PostgreSQL statement execution and lock waits. It is not a
new bound on the plugin RPC, every shutdown operation, or a network failure before
PostgreSQL receives a statement. A retained result is process-local; after process
loss, existing durable run rows and their existing orphan policy remain the source
of truth. This change does not make arbitrary plugin side effects replayable.

A real PostgreSQL regression first observed a completion waiting for a held run
row, then demonstrated that shutdown remained pending. With the repair, PostgreSQL
cancels the write, shutdown reports failure while the lock is still held, and the
saved completion commits after release without a second plugin call. All 34
scheduler cases pass. All 247 cases in eleven complete scheduler/shutdown/startup,
warm-standby, driver-readiness, coordinator, scoped-deadline, approval/join
retention, approval seeding and decision-expiry suites pass, along with server
typecheck and production build, at `36be0bd733`. Earlier failures and their stated
revisions remain above. Fresh final-parent integration and exact-head remote
checks/reviews remain required.


Final parent `51668b8240` changes only approval-seeding behavior/tests and two
documents relative to the 247-case candidate. All plugin implementation, plugin
tests, shared deadline/coordinator and shutdown sources remain identical to that
run. After normal integration, all 63 cases in complete plugin-scheduler,
approval-seeding and scoped-deadline suites pass at `56ce7c1d2a`, plus server
typecheck/build. The original seventeen-file plugin boundary and exact parent
migration metadata are preserved. Publication waits for the parent to land so
final master reconciliation and remote checks can run together.


Approval seeding #17510 merged as `4e27a82a42`, with both final-head 5/5 reviews
and all 58 accepted checks. Plugin scheduling now integrates that actual master
parent. The complete integrated tree is byte-identical to `df78ca3b5e`, so the
247-case and final 63-case verification above retain their exact source scope.
No local checks were repeated on unchanged code. Only final publication docs
change afterwards; fresh exact-head CI and reviews remain required against master.
