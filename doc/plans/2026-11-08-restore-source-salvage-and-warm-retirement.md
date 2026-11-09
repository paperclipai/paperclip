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

Its owner is the lease's run (`runOwner`), which is terminal. Most holds from
`environment-retained-orphan-settlement.ts` still apply: shared provider
resource, stop or restore intents in flight, pending cleanup claim, open runs
on the task.

Two existing guards are deliberately replaced for this kind, and only for it:

- The unconditional hold on `workspaceRestoreRecovery` lease metadata
  (`alwaysHeldSql`, `heldBy`). For a restore source it is replaced by the
  closed-actions and later-success conditions above, plus the salvage receipt.
- The `resourceDisposition === "destroy"` requirement in
  `scheduleRecoveredWorkspaceCleanup`. Restore sources (`retain_on_failure`)
  and warm leases (`keep_running`) never record `destroy`, so retirement uses
  the salvage receipt instead.

**Adoption versus retirement.** Reuse eligibility today is status-only
(`reusableLeaseCanBeResumed` accepts any `released` or `retained` lease), so a
metadata stamp cannot stop a new run from resuming a sandbox mid-salvage. At
claim time, the settle moves the lease to a non-resumable state with a
compare-and-swap on its status (the stop-only `pending_cleanup` claim shape).
A run admitted after that provisions a fresh sandbox. A run admitted before the
claim adopts the sandbox, and the claim's compare-and-swap then fails.

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
     compare it with the committed `executionWorkspaceSnapshots.manifestDigest`
     of the reference's snapshot. (`sha256` hashes the encrypted archive bytes and
     can never match a manifest digest.)
   - **Legacy native descriptor:** compare `captureDirectorySnapshotOffThread` +
     `directorySnapshotSha256` with the descriptor's `finalHostSha256`, else its
     `baselineSha256`.
   - **Warm sandbox after a successful turn:** the run already recorded
     `finalHostSha256` when it synced back, so a match needs no capture of new
     content.
   - **Equal:** record `compare: clean` and go to stage 3. **Unequal or
     unknown:** go to stage 2.
   - **Every exit after a resume attempt re-stops the sandbox**, clean or not,
     in a `finally`. `recoverRetainedWorkspace` does the same with
     `retryPendingSandboxTeardown` and `settleStopOnlyCleanup`. If the stop
     cannot be confirmed, a durable stop obligation stays on the lease.
     Preparing the resume clears `remoteExecutionTermination`, so stage 3 uses
     the new stop receipt from this re-stop, not the old one.
2. **Export.** Capture the filtered workspace: extract `quarantineRetainedRoot`'s
   capture, `omitDeniedWorkspaceFiles` and `putFile` steps from
   `workspace-recovery-fallback.ts` into an exported helper.
   - Store the archive under a deterministic object key derived from the lease
     and the attempt.
   - **Write the receipt with the attachment, in one transaction:** the asset,
     the issue attachment and `artifact` work product, the comment, and a
     `workspaceOperations` receipt (`kept_sandbox_salvage`, archive sha256),
     as `quarantineRetainedRoot` already does. `createAttachment` always
     inserts and assets are unique on `(company_id, object_key)`, so a retry
     first looks up an existing receipt or asset by object key and reuses it.
     It never creates a second artifact or comment.
   - The re-stop happens in the single resume window's `finally` (see Fencing),
     after the export, not between compare and export.
   - **Exposure.** The filter (`omitDeniedWorkspaceFiles`) only denies known
     secret names and directories; a credential in an ordinary file would be
     included. The export is therefore restricted to the issue's existing
     readers, stored with a bounded retention, and run through the run-log
     secret redaction on file contents. If the design review prefers, the
     first version can instead record "unsaved files exist" on the issue and
     wait for a user's decision before attaching the archive.
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

## Fencing (required before implementation)

- **One claim status that the sweep skips.** The retirement claim sets the lease
  to `pending_cleanup` and records `keptSandboxRetirement` with `stage` set to
  `compare` or `export` and an attempt id. The pending-cleanup sweep must treat
  a lease with an in-flight `keptSandboxRetirement` stage as held, exactly as
  it treats `workspaceRecoveryCleanup` or an in-flight cleanup claim. Only
  stage 3 clears the marker and queues the destroy. Otherwise the sweep could
  destroy the sandbox while its files are still being saved.
- **Admission claims before it resumes.** Run admission must win a
  compare-and-swap on the reusable lease's status before it calls the
  provider's resume. A resume that loses the claim provisions a fresh sandbox
  and never touches this one. This closes two overlaps: a turn that already
  selected the sandbox, and a provider resume in flight when retirement claims.
  Today `environmentResumeLease` runs before `acquireLease` updates the old row,
  so this ordering change is part of the work. Test: a turn racing a retirement
  claim leaves exactly one owner of the sandbox, and the loser never calls the
  provider for it.
- **One resume lifetime.** Compare and export run inside a single resumed
  window. The re-stop `finally` wraps both stages together, so the sandbox is
  running for the capture and stopped on every exit (clean, dirty or failed).

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
- Crash between the attachment write and the receipt: the retry reuses the
  artifact by object key and records the receipt once.
- Every exit after resume re-stops the sandbox (clean compare, capture
  failure, upload failure); an unconfirmed stop leaves a durable obligation.
- A turn admitted at the claim boundary: before the claim it adopts the
  sandbox and the claim fails its compare-and-swap; after the claim it gets a
  fresh sandbox.
- Warm: a done task within the window is adopted by a new turn; past the window
  it is retired; a still-running task's warm sandbox is never listed.

## Out of scope

- Hard-deleted issues: the lease's `issue_id` is set null on delete, so no rule
  can prove the task moved. The issue-delete path should hand its kept leases
  to this teardown. That is a separate follow-up.
