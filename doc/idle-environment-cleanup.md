# Idle environment cleanup

Pending lease cleanup and historical resource verification use the existing
transaction signals, delivery coordinator, and in-process scheduler. They no
longer run unconditionally from the server maintenance tick. The run reaper
performs its inline pending-cleanup sweep only after actually recovering a run
or an orphaned active lease. Explicit user retry keeps its existing direct path.

## Work and ownership

| Duty | Truth | Trigger and next deadline | Quiet condition |
| --- | --- | --- | --- |
| Failed teardown | Existing `environment_leases` rows in `pending_cleanup` | Commit signal; later of row backoff and saved retry/ownership deadline | No pending lease or deferred orphan |
| Failed acquisition before a DB row exists | Existing local orphan spool and the producing runtime's buffer | Local buffer registration; five-minute retry while buffered; startup spool load | Durable row owns recovery and spool copy is removed |
| Historical provider verification | Existing failed ephemeral leases and finished custom-image setups without matching cleanup proof | Commit signal; five-minute retry while an unverified candidate remains | No unverified candidates, including retained verified history |

`environment-cleanup-state.ts` owns the deadline query and the shared safe reader
for retry/ownership metadata. Cleanup claims and the scheduler use that same
reader, including malformed-number handling and the existing maximum horizon.
Startup retains the immediate scan, but never bypasses a saved in-flight claim or
retry cooldown. Subsequent scans respect the five-minute row backoff. Claims,
provider readiness, Stop authority, workspace retention, copyback, receipt
validation, and escalation rules stay with their current owners.

`environment-cleanup-work.ts` registers two independent workers. Their generation
counters preserve a wake until successful reconciliation, including a first write
during drain, changes during a sweep, and failure followed by drain. The existing
heartbeat interval bounds pending-cleanup starts after bursts of writes. Historical
verification has a separate minimum five-minute spacing, including commit-triggered
passes, and does not delay server readiness. No timer remains once
there is no obligation. A self-generated write can require a final reconciliation
before quiet. A failed sweep retains a retry. Shutdown unsubscribes local buffer
wakes; the delivery coordinator stops subscriptions/timers and joins active work.

## Producer coverage

The shared `writeEnvironmentCleanup` helper registers and awaits intent before a
write in a transaction. Existing transaction owners call
`notifyEnvironmentCleanup(tx)` directly. Nested calls retain outer transaction
settlement and uncertainty handling through the shared DB implementation.

- `environments.ts`: orphan insertion, release, metadata replacement, and run-wide
  release. These stores cover normal provider teardown and failed acquisition.
- `environment-runtime.ts`: reusable sandbox cleanup claims and their settlement,
  and Stop/export cleanup claims. Renewal of an already active claim retains its
  bounded timer; it cannot create new pending work.
- `heartbeat/recovery.ts` and `heartbeat/run-control.ts`: orphan-active recovery,
  retry settlement, and explicit recovery of historical leases.
- `environment-task-runtime.ts`: unconfirmed plugin task termination and plugin
  replacement orphans, including a registered deferred flusher when the row
  cannot be written. The flusher retains an idle hold until the row is durable.
- `sandbox-stop-and-retain.ts`: persisted Stop intent and its settlement.
- `native-workspace-export-resume.ts` and `native-workspace-export-retry.ts`:
  terminal-export cleanup, resumed-export cleanup claims, and settlement.
- `workspace-recovery.ts`: verified copyback schedules destruction.
- `native-workspace-sync.ts` and the native session executor's backup stamp:
  writes that can invalidate an existing historical row-version proof.
- `environment-custom-images.ts`: provider state, terminal state, and promotion.
  Initial active setup insertion is not a historical verification candidate.

Other lease metadata writes neither create pending cleanup nor change the
row-version/provider identity of a matching historical proof. Changes to an
already pending claim remain covered by its existing deadline. Deletion removes
work; an already scheduled reconciliation observes that removal. Independent SQL
writers and another server process are not covered by these process-local signals.

## Deferred orphan buffers

Runtimes that hold an unwritten orphan register their flusher in a registry scoped
to the shared database handle. Registration wakes the worker without contacting
the database. A sweep flushes registered runtimes as well as its own startup spool;
this reaches a producer runtime's buffer even when it differs from the heartbeat's
runtime. The registry retains only runtimes with unresolved buffer ownership.

Unreadable directories, records, and malformed records retain a retry; a missing
spool directory is an empty spool. A spool read failure still allows other runtimes to flush their buffers and
persisted leases to clean up, then fails the sweep so recovery stays scheduled.
Each concrete cleanup pass reloads the spool, including entries appended by
plugin task replacement after startup and entries beyond buffer capacity.
No empty-spool filesystem or database polling is introduced. Existing limits on a simultaneous database,
spool, and buffer-capacity failure remain; this is not a new durable queue.

## Verification and boundaries

The PostgreSQL worker tests exercise quiet configured state and verified history,
real store activation, persisted backoff, failed teardown and restart, nested
commit/rollback, drain/resume, cross-runtime deferred work, failed spool reads,
shutdown joining, provider uncertainty, and historical pagination. Existing
runtime, reaper, Stop, custom-image, and workspace tests cover the underlying
cleanup authority and provider contracts.

The runtime fixture now gives each simulated instance its own DB handle and spool.
Its journal-write failure injection targets the transaction boundary rather than
the direct update that moved inside that transaction. Fake-clock worker tests wait
for PostgreSQL I/O and distinguish an executing sweep from a retained next wake.

This does not migrate discovery of orphaned active leases or legacy shutdown
workspace settlement from the broader run-recovery loop. Custom-image *active
session expiry* also remains on its existing tick; only historical verification
moves here. Other maintenance duties, external probes, and connected transports
still affect idle traffic. No Cloud alarm coverage or host-sleep exemption changes.
These tests prove the changed workers become quiet and recover; they do not prove
deployed suspension or fleet savings.

## Custom-image setup expiry

Setup expiry uses a separate `custom-image-expiry` worker. The custom-image
service owns the active-status predicate, the earliest saved `expiresAt`, and
provider cancellation. Startup registers the worker in the existing enabled
heartbeat housekeeping path; the maintenance tick no longer calls its sweep.

All supported setup producers live in `environment-custom-images.ts`: initial
creation, provider refresh, cancellation/failure status, and promotion. They
register intent in their owning transaction. A provider refresh can move the
deadline earlier; a terminal transition removes it. Historical verification
metadata does not change active expiry eligibility and does not need this signal.
Environment deletion can only remove obligations; an already scheduled pass
observes the removal. Independent SQL and other DB roots are outside the existing
process-local notification contract.

No active dated session means no recurring reads or provider calls. Overdue
batches and failures retain a bounded retry, while first writes and failed
reconciliation survive drain. A missing expiry retains the existing behavior
(no inferred expiration); sleep safety still treats unsupported live resources
conservatively. Provider cancellation, failure state, and historical resource
verification keep their existing semantics. No Cloud alarm coverage changes.

## Historical retry test observation

The historical verification worker intentionally does not delay server readiness.
Its provider sweep finishes before the following database pending-state read
registers a retry deadline. The regression test now waits for that future
deadline before inspecting it; sweep completion alone is not scheduler settlement.
The runtime worker, retry interval, and readiness contract are unchanged.

A controlled 150ms delay before the real pending-state query reproduced the
current CI failure: the immediate assertion observed a null deadline. The
corrected assertion passed with the same delay. The temporary delay was removed,
and all 14 cleanup tests passed against an isolated PostgreSQL database. The
existing external test-database hook is carried at the stack foundation so
intermediate branches can use this same verification path.

An initial attempt at the foundation could not start embedded PostgreSQL because
that earlier branch lacked the external fixture hook. A broader fixture wait for
all idle holds to clear then failed three cases that legitimately retain pending
cleanup obligations. That wait was removed. Only the historical deadline assertion
changed; its requirement is now a deadline strictly in the future. The complete
suite passes with the original readiness and idle-hold behavior preserved.
