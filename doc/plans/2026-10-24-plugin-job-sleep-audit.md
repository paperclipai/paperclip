# Plugin job scheduling migration audit

Baseline: approval queue slice `e04a0375dc` (#17510), with fetched master
`a3675ddcdf`. This is the next independent recurring-server obligation; it does
not replace the other outstanding inventory items.

## Current owner and behavior

`plugin-job-scheduler.ts` starts a private 30-second interval from `app.ts`.
Each tick selects active jobs with a due `nextRunAt`, even on an empty instance.
Cron calculation and dispatch already belong to this service; the migration
should retain that ownership and register deadlines with the existing delivery
coordinator. It must not create a second shared scheduler or one table per job.

Saved job definitions and run records are the durable truth. Plugin lifecycle
registration initializes next-run timestamps. Job pause/resume, manifest sync,
job deletion, and run completion can all change the next eligible obligation.
The scheduler currently catches tick errors; its scheduled entry point must not
swallow errors that the shared coordinator needs for recovery.

## Producer and lifecycle audit

- `plugin-job-store.ts`: declaration sync, definition status changes, timestamp
  updates, and deletion. These are the primary persistence boundary.
- `plugin-registry.ts`: its separate declaration synchronization also directly
  inserts/updates jobs. Do not assume the job store covers all writers.
- `plugin-job-coordinator.ts`: loaded/disabled/unloaded events connect the store
  and scheduler. The loaded handler skips declaration sync when the new manifest
  has no jobs, which can leave old definitions. Preserve or explicitly repair
  that behavior before claiming removed schedules are quiet.
- `plugin-loader.ts`: also registers/unregisters jobs and stops the scheduler.
  Inspect actual worker start/restart events; a worker becoming available must
  wake overdue jobs without relying on periodic discovery.
- `app.ts`: creates the scheduler before the delivery coordinator and starts it
  just before coordinator creation. Wiring must pass the existing coordinator
  after creation and retain correct shutdown ordering.

## Correctness questions to settle before implementation

1. Registration currently advances overdue timestamps as well as missing ones.
   An observation must not silently move a real due deadline. Establish and test
   startup/catch-up behavior rather than copying this as deadline discovery.
2. Scheduled dispatch tracks jobs in memory, while manual dispatch also checks
   saved running records. Replacing polling must not replay an unknown prior
   provider effect or lose delivery; audit interrupted run recovery separately.
3. Concurrency limits and a temporarily unavailable worker defer actual work.
   Completion/availability signals should wake it. They are not permission for
   an empty recurring scan.
4. Invalid or missing cron expressions and disabled definitions must not cause
   an endless past-due deadline. Preserve manual trigger behavior.
5. Shutdown currently stops its timer while in-flight jobs finish naturally.
   The shared owner must still track and await those admitted operations, with
   durable results and schedule advancement preserved.
6. The current status update and declaration-sync methods need outer-commit
   signals. Never put worker RPC calls inside a database transaction.

Prove empty, configured/manual-only, paused, and completed-history quiet;
first actual declaration/status changes; future deadlines; restart/catch-up;
worker unavailability and recovery; failures; drain/resume; concurrent writes;
and shutdown. Cloud alarm coverage for plugin jobs remains unsupported and
conservative sleep admission must stay intact.

## Other audit observations retained for later slices

Tool connection health checks have a distinct 15-minute proactive policy in
`tool-access/catalog/health.ts`; the aggregate tick repeatedly discovers its due
rows. About 94 direct tool-connection write sites exist, many for excluded chat
or AI transports. Classify those writers instead of adding wrappers indiscriminately.
The current health checker returns immediately for AI-purpose connections, while
the sweep does not explicitly exclude that purpose. Audit inert due rows and
pre-probe setup failures before deriving deadlines from `healthCheckedAt`.
No tool-health migration is claimed by this plugin-job slice.

## Implementation decisions

The migration now uses existing job/run rows and the shared deadline worker.
Local lifecycle wakes needed the helper to retain an explicit wake across drain;
the plugin tests exercise that condition through a real status event. The worker
handle already exposes status subscriptions, so no new worker-manager API is
needed. The job store accepts the query/transaction subset shared by root clients
and transactions instead of casting transaction handles to full pools.

Claims recheck current state with a job-row lock. Worker calls stay outside the
transaction. Completion and schedule advancement commit atomically; failed
persistence retries only settlement. Unresolved old runs are not blindly replayed.
This preserves the conservative Cloud sleep blocker for unknown external effects.

Related proposals: #7905 covers empty manifest sync; this migration needs that
behavior on both activation paths. #11571 proposes company-scoped jobs; this
migration retains the current instance-scoped contract and does not implement it.

## Refresh/manual-dispatch test ordering (2026-10-27)

CI job 122104710882 timed out in the manual-reservation concurrency case. Its
setup created due work before installing the outstanding-run snapshot barrier.
The creation notification could start dispatch first, leaving no runnable job
for the later refresh to query and no read-barrier arrival. An isolated local
run passed, so that retry alone did not establish the cause of the CI failure.

The test now pauses background admission during setup and resumes it only after
the barrier is installed. It still holds a real database snapshot across the
manual dispatch, verifies the active reservation and concurrency bound, and
checks that all three jobs finish. All 33 plugin scheduling cases pass with
this ordering. Production scheduling, assertions, and test timeouts are unchanged.


## October 28 review repair

The final retained completion transaction uses a local thirty-second PostgreSQL
statement timeout (configurable through the internal constructor for tests). It
bounds lock/query execution in both refresh and stop, preserves pending results
on error and never repeats the plugin RPC to repair persistence. A two-connection
lock regression failed before this repair, then passed. All 34 scheduler cases and
247 cases across eleven complete affected/lifecycle suites pass at `36be0bd733`;
server types/build pass. No schema change or new periodic activity is introduced.
See `doc/idle-plugin-jobs.md` for the exact scope and network/process-loss limits.
