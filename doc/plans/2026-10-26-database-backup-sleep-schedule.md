# Automatic database backup scheduling

## Scope and ownership

Inventory item 15: automatic database backups. This is slice 60, based on the
import-spool cleanup branch (PR #17835). The server used an independent interval
for this duty. It neither exposed its next deadline through the shared work
scheduler nor joined the delivery coordinator's shutdown.

An enabled backup schedule is a real recurring obligation. This change does not
turn it off after an empty read, reduce its frequency, or claim that scheduled
backups become event-only work. No backup job table or database notification
producer is needed: startup configuration creates the obligation.

The new `database-backup-work.ts` owns cadence. The existing
`runServerDatabaseBackup` callback continues to own backup serialization,
settings reads, archive creation, retention, checkpoint verification, error
logging, and idle-work tracking. Manual and pre-sleep calls keep that same owner.
`index.ts` registers the schedule only when automatic backups are enabled.
The existing shared coordinator owns timers, admission gates, coalescing,
failure reporting, and stopping. Other workers' contracts are unchanged.

## Deadline and lifecycle contract

- The first ordinary backup is due one configured interval after registration,
  after any existing restart-marker backup. This preserves the previous
  startup-relative cadence. There is no new persisted wall-clock schedule.
- Discovery and early wakes perform no backup, settings query, filesystem read,
  or database transaction. `hasPending` reads no external state. The configured
  future deadline remains visible through the shared scheduler.
- A due callback invokes the existing backup owner once. It preserves the
  owner's `null` result when a manual or pre-sleep backup is already active.
- Success, failure, and a busy-owner skip all advance to the next future slot
  on the original cadence. A slow backup skips elapsed slots rather than
  creating a catch-up backlog. Failures remain logged and are attempted again
  at the next configured interval, as before.
- Drain and warm standby prevent dispatch. Passive waiting does not read the
  database or hold an idle receipt. The due obligation remains in memory;
  after admission reopens it runs on the next coordinator attempt, within one
  configured interval. It does not replay each missed slot.
- Shutdown stops the shared timer and waits for an already-running scheduled
  backup. The existing backup implementation has no AbortSignal contract, so
  this is a join, not cancellation. A stalled backup can delay graceful shutdown;
  adding bounded backup cancellation is separate work (see PR #11756).
- Restart retains the existing behavior: a fresh ordinary interval begins. A
  pre-sleep marker still requests the existing immediate verified startup backup.
  A failed startup backup leaves that marker for the scheduled retry. This slice
  does not add stale-backup catch-up (see PR #3549).

## Host sleep boundary

`markIdleStartupComplete({ scheduledBackups: ... })`, the backup checkpoint
opt-in, wake marker, `readIdleLocalWork` gate, and archive verification are
unchanged. Without the existing checkpoint proof, scheduled backups remain a
host-sleep blocker. With that proof, the existing restart-marker protocol still
owns wake recovery. A registered in-process deadline is not a persisted Cloud
alarm. This slice proves scheduling and lifecycle behavior, not host suspension,
external wake delivery, or fleet savings.

## Verification

The complete six-suite run passed 152 tests, without skips:

```sh
pnpm exec vitest run \
  server/src/__tests__/database-backup-work.test.ts \
  server/src/__tests__/server-startup-feedback-export.test.ts \
  server/src/__tests__/delivery-work-coordinator.test.ts \
  server/src/__tests__/work-scheduler.test.ts \
  server/src/__tests__/idle-local-work.test.ts \
  server/src/__tests__/instance-database-backups-routes.test.ts
pnpm -r typecheck
pnpm build
```

The nine new worker cases exercise the real coordinator and count both backup
calls and database-driver calls. They cover no early work, drain/standby and
startup during drain, failure before drain, busy-owner skips, slow work with
concurrent wakes, stop while active, and startup-relative restart behavior.
Startup integration covers enabled/disabled registration independently of the
heartbeat scheduler. Existing checkpoint tests now invoke the registered backup
deadline, retaining their assertions about marker persistence, startup readiness,
verification failures, and idle receipts.

A separate real PostgreSQL probe used two fresh disposable test databases. It
created a row, waited for the new worker to call the actual JavaScript backup
engine, verified the archive, restored it into the second database, and compared
the committed row. It also checked no early invocation and no invocation after
coordinator stop. The final probe passed. Its first launch referenced a nonexistent
cleanup export; the next probe restored the correct row but rejected the
PostgreSQL `Result` subclass when compared to a plain array. The harness was
corrected to compare row contents and rerun with fresh databases. Neither failure
required a production change. This probe does not qualify the pg_dump engine or
prove deployed shutdown latency.

Workspace typechecking and the full build passed. The repository-wide local
`test:run` remains unverified under the previously recorded embedded PostgreSQL
capacity limitation; targeted suites are not a substitute claim. Remote CI and
review acceptance are separate and remain pending until checked at the PR head.

## October 29 master reconciliation and current acceptance

The current merge campaign carries this existing backup slice through the
reviewed import-spool parent in #17835 and targets master after that parent lands.
The normal parent merge preserved the backup worker, production registration and
all four selected test files byte for byte. Parent changes since qualification
are the import-spool audit and its inherited tool-access concurrency test repair;
they do not change backup execution or scheduling. No packages, schema, backup
format, interval policy, or sleep gate are added by this reconciliation.

Qualification at source `11775eee7ed795b989cbb31052e69643c468c3cf` passed
**130 cases in four complete files**, without skips, in 7.24 seconds:
`database-backup-work`, `server-startup-feedback-export`, `scoped-deadline-work`
and `delivery-work-coordinator`. The tests cover deadline replacement, no work
before a deadline, drain and standby admission, retry after failure, busy-owner
skips, slow callbacks, coordinator stop and startup checkpoint-marker behavior.
Database package build, production server typechecking and build, module
boundaries, target migration order and Runner profile identity also passed.
The reviewed runtime and these four test sources remain identical to that
accepted source; a documentation-only publication does not claim another run.

The package tree remains the already qualified profile-80 parent tree. Historical
six-suite and real JavaScript backup/restore probe results above remain evidence
for their original revisions. This current four-file acceptance does not claim
a repeated physical backup/restore probe, a pg_dump qualification, a full local
repository-suite pass, live provider acceptance, measured host suspension or cost
savings. Fresh CI, security and review results must be checked on the final
published head separately.

Automatic backups remain a genuine scheduled obligation. The shared deadline is
visible internally, but it is not a persisted external Cloud wake alarm. Existing
checkpoint and host-sleep gates still govern whether an instance may suspend.
Shutdown still joins an active backup whose executor has no AbortSignal contract.
