# Retiring kept sandboxes: salvage, then destroy

Status: proposed design, for its own reviewed task. Not implemented.

## Problem

Paperclip keeps a remote sandbox after its run in two cases:

- **Warm reuse** (`reuse_by_environment`): the next turn on the same workspace
  resumes the sandbox.
- **Workspace-restore source** (`retain_on_failure`, lease and run carry
  `workspaceRestoreRecovery`): after a failed run, the stopped sandbox may hold
  the only copy of files that were never saved back.

Some of these sandboxes are never retired:

| Case | Why it stays | What ends it today |
|---|---|---|
| Restore source whose recovery actions were closed by a user Retry (`explicit_user_continuation`), where a later run on the task succeeded | Restore recovery only destroys after a verified repair with disposition `destroy` (`scheduleRecoveredWorkspaceCleanup`), and only for open or exhausted actions (`workspaceRecoverySourceEligible`). The retained-orphan kind treats `workspaceRestoreRecovery` as permanently held. | Environment deletion (#20085) |
| Warm sandbox, suspended, whose task is done or cancelled but still bound to the workspace | The idle timer lives in the server process. After a restart, Daytona's own auto-stop suspends it. Nothing destroys it while the task stays bound. | Environment deletion |

Both are suspended (stopped) and owned, so they leak storage cost, not compute.
In the warm Daytona chaos wave w-20261108T170423-s9501, all four real
"orphans" were closed restore sources.

Decision so far (2026-11-08): grade a stopped, owned restore source as
retained, not as a leak (#20086). Environment deletion destroys both kinds with
consent (#20085). This note covers retiring them earlier without losing work
(R2: no unsaved work is lost).

## Rule

One owned kind on the shared ownership reconciler,
`environment_kept_sandbox_retirement`, lists a kept sandbox when:

- **Restore source:**
  - every recovery action for the source run is closed (resolved or cancelled,
    including by explicit user continuation);
  - a later run on the same task has succeeded;
  - no native workspace export or preservation obligation is pending.
- **Warm sandbox:**
  - the task is `done` or `cancelled`;
  - the sandbox has been idle (`releasedAt`, or the last turn's end) longer
    than the retention window: default 24 h, configurable per instance;
  - its newest lease row is `released` or `retained`.
  A new turn on the task inside the window adopts the sandbox as it does today.

Its owner is the lease's run (`runOwner`), which is terminal. All the existing
holds from `environment-retained-orphan-settlement.ts` apply: shared provider
resource, stop or restore intents in flight, pending cleanup claim, open runs
on the task.

## Settle: salvage, then retire

Reconciler settles never call providers; they hand provider work to a sweep
with a durable claim. Retirement does the same, as a three-stage state machine
recorded on the lease (`keptSandboxRetirement`), each stage idempotent and
retried with backoff.

1. **Compare.** Claim the lease (`pendingCleanupInFlight`-style attempt id with
   a controller stamp), then resume the stopped sandbox read-only: the same
   path `recoverRetainedWorkspace` uses (`resumeWorkspaceRecoveryLease`), under
   `withNativeWorkspaceFinalizationOwnership`.
   - **Remote workspace reference:** capture the read-only manifest digest and
     compare it with the committed `executionWorkspaceSnapshots.sha256` of the
     reference's snapshot.
   - **Legacy native descriptor:** compare `captureDirectorySnapshotOffThread` +
     `directorySnapshotSha256` with the descriptor's `finalHostSha256`, else its
     `baselineSha256`.
   - **Warm sandbox after a successful turn:** the run already recorded
     `finalHostSha256` when it synced back, so a match needs no capture of new
     content.
   - **Equal:** record `compare: clean` and go to stage 3. **Unequal or
     unknown:** go to stage 2.
2. **Export.** Capture the filtered workspace: extract `quarantineRetainedRoot`'s
   capture, `omitDeniedWorkspaceFiles` and `putFile` steps from
   `workspace-recovery-fallback.ts` into an exported helper.
   - Store the archive.
   - Attach it to the issue with `issueService.createAttachment`, which creates
     the `artifact` work product.
   - Add one comment naming the file and why it was kept.
   - Record a `workspaceOperations` receipt (`kept_sandbox_salvage`, archive
     sha256) as the idempotency key. Then re-stop the sandbox through the
     stop-only contract (`prepareSandboxStopAndRetain` → `settleStopOnlyCleanup`).
   - **First version:** export the whole filtered workspace. A file-level diff
     needs new code on top of the manifest and `selectDirectorySnapshot`, and
     can follow.
3. **Retire.** With `compare: clean` or a verified export receipt, hand the
   lease to the pending-cleanup sweep for destruction. Use the same lease update
   as `scheduleRecoveredWorkspaceCleanup` (`pending_cleanup`, policy
   `ephemeral`, `workspaceRestoreRecovery` removed, stop receipt kept as
   `workspaceRecoveryCleanup.stopReceipt`, so successors are never blocked),
   with the salvage receipt in place of `hasVerifiedWorkspaceRepair`.

**Failure keeps the sandbox.** If the resume, capture, upload or attachment
fails, the lease stays suspended, and the stage retries with backoff up to a
bounded retention window. Past the window it is handed to the board as an
issue recovery action ("salvage failed; the sandbox is kept"). It is never
destroyed without a clean compare or a confirmed export.

## Provider I/O steps and their receipts

| Step | Provider call | Durable receipt before the next step |
|---|---|---|
| Claim | none | attempt id plus controller stamp on the lease |
| Resume read-only | `environmentResumeLease` | none needed; the step is re-done on retry |
| Capture | sandbox exec/read | manifest digest on `keptSandboxRetirement` |
| Upload | storage `putFile` | object key plus sha256 |
| Attach and comment | none (database) | `issueWorkProducts` row, comment id, `workspaceOperations` receipt |
| Re-stop | `environmentStopLease` | stop receipt (`remoteExecutionTermination.state = stopped`) |
| Destroy | `environmentDestroyLease` (pending-cleanup sweep) | `expired` with a destroyed receipt |

## Tests

- Old-saved/new-resumed: restore sources and warm leases written by the
  current release, in their exact row shape.
- Clean compare → destroyed without export. Dirty compare → one artifact work
  product and one comment, then destroyed. Export failure → kept and retried,
  never destroyed.
- Holds: open run, open recovery action, pending export, another lease on the
  sandbox, an operator owner-gone attestation.
- Concurrency: two reconciler processes settle once (one work product).
- Warm: a done task within the window is adopted by a new turn; past the window
  it is retired; a still-running task's warm sandbox is never listed.

## Out of scope

- Hard-deleted issues: the lease's `issue_id` is set null on delete, so no rule
  can prove the task moved. The issue-delete path should hand its kept leases
  to this teardown. That is a separate follow-up.
