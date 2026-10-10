# Native workspace finalization ownership and recovery

Native workspace export and merge acquire a PostgreSQL advisory lock scoped to
company and run before the first physical copyback. The live heartbeat and the
reconciler share that lock. Recovery skips a busy owner without recording another
workspace operation or spending a retry. Recovery also rechecks the coordinator's terminal state and retry time under ownership: an earlier sweep snapshot cannot
start another export after live finalization publishes a permanent repair or delay.
A completed workspace barrier is reread
under ownership before export, and a committed coordinator cannot be overwritten
by a late failure receipt.

The lock transaction holds no row locks. Ordinary progress and finalization
receipts remain visible through the normal database pool. A dedicated connection outside the application pool is
reserved for the duration of copyback and closed when it settles; even a one-connection application pool remains available for progress writes. Its run profile carries
`nativeWorkspaceFinalizationOwner`, an exact token, host, PID, and process-start
receipt. Losing the lock connection does not prove physical copyback stopped:
a contender still refuses a receipt whose controller is alive. The original
callback joins before its token is released, and publication checks the lock
connection and token. Graceful completion clears the receipt. If that cleanup write fails after the
callback joins, only the same exact controller boot retains positive in-process
join evidence and may resume after reconnecting; an unknown token or a new boot
does not inherit that authority. A controller that
has exited on the same host can be recovered automatically only when a durable
successful workspace barrier proves its copyback finished. A dead parent can
leave tar/Git children alive, so incomplete copyback requires operator stop
verification even on the same host. PID reuse is checked against its recorded
start time rather than trusted by PID alone.

## Unverified copyback after controller replacement

Generic orphan recovery does not turn a missing provider PID into `process_lost`
while the native coordinator is `workspace_finalizing` with an accepted result
bound to the same company, issue, and run. The finalizer owns that unfinished
suffix, including the interval before it acquires its physical owner receipt.
The heartbeat's phase or profile alone does not establish this authority.
The conditional orphan write rechecks the durable result and the heartbeat's
PostgreSQL tuple version, so a result published while the write waits on its row
lock cannot be overwritten using an older statement snapshot. Result publishers
lock and update that heartbeat in the same transaction as acceptance.

The running run keeps its source lease while the existing finalizer either
completes, records its bounded failure policy, or requires operator stop
verification. A new queued run or a healthy child task cannot clear an
unverified copyback hold. Verified finalization clears the matching run's hold
after commitment. Existing terminal-task dispositions and explicit cancellation
remain unchanged; this does not recover a source already destroyed by an older
controller or claim that an unfinished export succeeded.

The controller cannot verify a process on a foreign or unknown host, or orphaned
copyback children after an abrupt parent death before the success barrier. It surfaces
`native_workspace_finalization_owner_unverified` as board-owned recovery, with no
automatic provider wake. This is an intentional limit: elapsed time or a missing
database connection never proves the old copyback process stopped.

An instance operator must first verify through the deployment platform that the
exact prior controller **and its copyback subprocesses** have stopped. Retain the
sandbox, accepted native result, and workspace descriptor. Do not run a new
provider turn, delete workspace contents, or relax archive confinement.

After that platform verification, open the task's **Workspace finalization needs
recovery** notice. A board member with runtime-management access records the
platform stop evidence, confirms that the exact controller and all its copyback
processes have stopped, and selects **Resume saved result**. The equivalent API is
`POST /api/issues/:id/recovery-actions/resume-workspace-finalization` with:

```json
{
  "actionId": "<recovery-action-id>",
  "runId": "<run-id>",
  "ownerToken": "<owner-token-from-recovery-evidence>",
  "controllerAndCopybackStopped": true,
  "stopEvidence": "<deployment-platform evidence for this controller and its children>"
}
```

This is an operator attestation, not an automatic deployment-platform probe. A
missing advisory connection alone is insufficient. Admission rejects an active
copyback lock, an observably live local controller, a changed owner, a newer run,
or an unbound result. It records the exact owner and operator evidence atomically
with releasing the receipt. The accepted result, workspace descriptor, source
lease, task status, monitors, and approval waits are unchanged. The ordinary
reconciler performs copyback and applies the saved result through the status
arbiter. No provider wake is enqueued. The recovery action remains visible until
finalization commits. Repeating the same confirmation before reconciliation is
idempotent; it cannot release a newer owner. Generic recovery resolution, including
false-positive dispositions, cannot dismiss this hold or bypass saved-result
finalization.

Repeated sweeps preserve these copyback-specific instructions, including for
older actions whose recovery budget was already exhausted. They must never
recommend starting a replacement provider run for this hold.

For older servers without this action, the maintenance fallback follows.

After that platform verification, use a database maintenance transaction to
release only the exact receipt shown by the recovery action. Replace the four
placeholders with the action's company, run, token, and source issue. The advisory
lock prevents concurrent acquisition during this change; the token comparison
prevents clearing a newer owner. A zero-row update means ownership changed and
requires fresh inspection. This maintenance operation is for a full-control
instance operator, not an agent tool.

```sql
BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended(
  'native-workspace-finalization:<company-id>:<run-id>', 0));
UPDATE heartbeat_runs
SET runner_profile_json = runner_profile_json - 'nativeWorkspaceFinalizationOwner'
WHERE company_id = '<company-id>'::uuid
  AND id = '<run-id>'::uuid
  AND native_issue_id = '<issue-id>'::uuid
  AND runtime_mode = 'native'
  AND runner_profile_json->'nativeWorkspaceFinalizationOwner'->>'token' = '<owner-token>'
RETURNING id;
COMMIT;
```

Resolve the existing board recovery action with a note containing the platform
stop evidence. The ordinary reconciliation sweep then resumes workspace
finalization from the accepted result. Confirm the run's native phase and
`resultJson.finalizationPhase` are `committed`, there is no `nextAttemptAt`, and
no workspace operation is still running. The accepted provider result is reused.

## Automatic unsafe archive recovery

An unsafe link in a native workspace must not fail a completed task or require
an operator to repair a sandbox. The accepted agent result remains authoritative.

Daytona validates every exported archive before extraction. If validation rejects
an archive, export once more using files, directories, and relative symlinks
whose resolved targets stay inside the workspace. The fallback does not follow
or delete symlinks. It omits unsafe or unresolvable links, stores hard-linked
files as ordinary bytes, and preserves directory exclusions and empty directories. The second archive passes the same confinement checks.
A fixed informational message records the fallback in the provider log.

If native copyback still rejects the archive or its source confinement check,
Paperclip discards that export, records `workspace_export_omitted` at info level
in the local run log, and completes finalization using the original accepted
result. It does not create a task warning, recovery card, repair request, or new
provider turn. The normal completion policy still enforces ownership and explicit
workflow constraints. Lost remote files are an accepted tradeoff.

The live path and restart finalizer use the same policy under workspace
finalization ownership. Ownership loss, transport failures, missing sandboxes,
and other unrelated errors retain their existing handling. No unsafe archive is
extracted. No host path or link target is copied into the informational run event.


## Repairing a failed workspace export without rerunning the agent

Transient export failures retry three times, then produce
`native_workspace_sync_out_retry_exhausted`. The accepted result stays saved,
and the exact sandbox is stopped and retained for export-only recovery. The
reason identifies a transport/copyback failure, not an inferred disk-space cause.
New unsafe archives use the automatic policy above and do not create this hold.
Historical unsafe-archive holds recover automatically as described below; they do not use this operator flow.

A board member with runtime management access can complete the saved result:

1. Read the recovery action, run, and environment lease. Verify the company, run,
   provider sandbox ID, and stopped-provider receipt. Preserve that exact sandbox;
   do not acquire a replacement or seed the host workspace over it.
2. Through the provider console or official SDK, resume that sandbox and inspect
   the export failure while preserving all user files. Restore transport access
   or other provider prerequisites before retrying. Extending the sandbox
   retention window can be necessary during this repair.
3. In the task's **Workspace export needs repair** notice, describe the repair and
   choose **Retry workspace export**. The equivalent board API is
   `POST /api/issues/:id/recovery-actions/retry-workspace-export` with
   `{ "actionId": "<recovery-action-id>", "runId": "<run-id>", "repairNote": "<repair and preservation evidence>" }`.
4. Confirm the same run commits, the saved result determines the task outcome,
   and the recovery action resolves. No new provider turn or wake is created.
   A reusable repair sandbox is stopped and retained again. An ephemeral sandbox follows its original destroy-after-turn policy only after the exact result commits and the workspace reference contains a finalized host-copy receipt.

Admission requires the same accepted result, task owner, descriptor, and lease;
confirmed prior provider stop; an available repaired sandbox; and no newer task
execution or competing current lease. It shares finalization ownership and
resumes only the recorded provider lease through its verified lifecycle method.
That method drains old activity and verifies the saved workspace identity before
reopening the provider's controller admission gate; an external console restart
alone does not reopen that gate. Admission rejects a missing or replacement
sandbox and revalidates after probing the exact workspace. A changed binding or unavailable sandbox
returns `409` without reopening work. A duplicate queued request is idempotent.
Unsafe archives use automatic salvage or omission during retry. Generic
ordinary recovery resolution cannot retry, mark done, or send the task for review
in place of export-only retry. Explicit board false-positive/cancellation
dispositions remain deliberate overrides; they do not claim successful copyback.

Before publishing terminal export failure, the finalizer atomically records a stop-only intent with the failed run. This includes ephemeral allocations: ordinary release policy cannot delete their unexported files. A crash before cleanup leaves enough exact lease, result, and plugin authority for restart recovery. The same intent remains while export-only retry is active.

Before resuming the retained sandbox, the controller durably records a stop-only
cleanup intent on that exact lease and removes the old stopped receipt. If the
resume reply is lost, probing fails, or admission changes, it stops and retains
the sandbox. A failed stop remains `pending_cleanup`; a restarted controller's
bounded cleanup sweep retries the verified stop without destroying saved files.
An in-flight request holds a 15-minute cleanup claim, so a controller crash may
delay that sweep until the claim expires. Neither an unconfirmed stop nor a
stale receipt grants admission, and a changed lease or competing sandbox owner
prevents cleanup from taking ownership. Retry export after the lease has a new
confirmed stopped receipt. No provider turn is created by this recovery.
Cleanup and its readiness probe use the plugin ID recorded on that lease. Another
plugin with the same provider name cannot take over; an unavailable original
plugin defers cleanup without consuming an attempt. Stop-only cleanup requires the exact plugin worker to advertise `environmentStopLease`. Older plugins without that hook receive neither release nor destroy; resume admission also defers until safe compensation is available.
New intents use schema v2 with an explicit plugin pin. A v1 intent created before
that field existed remains recoverable using only the plugin ID already recorded
on its exact lease; an explicit mismatched pin is still rejected.

The opt-in `native-workspace-export-resume.live.test.ts` is a provider-boundary
fault integration, separate from the browser Product E2E. After building the
Daytona plugin, run that exact Vitest file with `PAPERCLIP_LIVE_EXPORT_RESUME=1`,
`DAYTONA_API_KEY`, and `PAPERCLIP_LIVE_EXPORT_RESUME_IMAGE` set to an immutable
image digest. It creates one disposable ephemeral sandbox and database, injects probe and stop transport failures, and verifies a fresh runtime can stop the sandbox while preserving exact nonce bytes. It also injects three transient failures at the production finalizer boundary and verifies retained work plus export-only retry admission. This boundary test does not claim physical copyback or result commitment; historical browser Product E2E supplied that proof before automatic unsafe-export recovery. It deletes only that owned fixture after proof.

### Historical unsafe exports

The reconciliation sweep automatically recovers accepted results that an older
controller terminalized with `native_workspace_sync_out_unsafe_archive`. It
omits the already-rejected export without accessing the old provider, so a
stopped, unavailable, or deleted sandbox cannot require user repair. The
omission barrier and result re-admission are atomic under finalization ownership.
The normal status arbiter still enforces current ownership, contracts, and gates.

This works with active, incorrectly resolved, or missing old repair actions. It
clears the matching stale unsafe notices instead of restoring them. Newer runs,
changed task ownership or contracts, another active recovery action, and explicit
operator dispositions prevent replay of old results. No provider turn is created.
Diagnostics appear only in the local run log; no unsafe-export activity notice,
repair card, or recovery chip is created. Existing stop-only allocation intents
retain their exact ownership and cleanup protections.

Daytona stop-only preservation disables provider auto-delete and refreshes the provider record to confirm the disabled policy before stopping. An unavailable or unconfirmed policy leaves cleanup pending; it never falls back to stop or delete. The original ephemeral destroy policy applies only after exact accepted-result copyback and commitment.

New ephemeral native allocations receive an acquisition-time workspace sentinel bound to their run and provider allocation. Export-only resume requires that proof and the unchanged durable intent. A legacy ephemeral allocation without this proof remains blocked; recovery never creates a sentinel or accepts a replacement during resume. The reusable workspace identity hash is unchanged.

Disabling auto-delete retains provider storage while repair waits. No automatic lease-age sweep deletes these released, confirmed-stopped allocations. Storage costs can continue until committed copyback applies the original cleanup policy or an operator explicitly deletes the allocation.

### Generic stop-only cleanup

An explicit sandbox `stop_and_retain` also requires the dedicated provider hook
when no export repair is involved, including successful per-turn reusable runs
and startup cancellation. Before dispatch, the controller stores a separate
`sandboxStopAndRetain` intent bound to the company, run, lease, provider allocation,
and original plugin. The initial cleanup and restart sweep both require that
plugin to advertise `environmentStopLease`. Missing capability or failed stop
leaves pending cleanup; ordinary release and destroy are never fallback methods.

A matching stopped receipt clears the pending intent, leaves the lease released
and resumable, and saves `sandboxStopAndRetainReceipt`. Its request identity,
original plugin and `method: "environmentStopLease"` attest this dispatch route.
The accepted-result export intent and its commitment requirements are unchanged.

The built-in fake provider uses its explicit `stopLease` operation rather than a
plugin RPC. Its intent pins the registered built-in provider and its receipt says
`builtin.stopLease`. This provider owns no real process or filesystem; the receipt
models its lifecycle. Missing built-in stop support or an unconfirmed receipt
also remains pending through restart, without calling release or destroy.

### Legacy copy-back after a confirmed stop

A legacy adapter can report failed workspace copy-back after cancellation has
already stopped and released its sandbox lease. The host records the exact lease
snapshot from before adapter dispatch. For an originally ephemeral source, the
recorder can preserve the released allocation for repair only while the current
lease is still ephemeral and its company, run, issue, workspace, provider,
allocation, acquisition time, plugin, and realized root still match. It requires
both the dedicated stop-and-retain receipt and the matching stopped-execution
receipt. A competing owner or changed source fails closed. The recorder leaves
release status and receipts intact, excludes the allocation from reuse, and
creates the existing board-owned file-repair obligation without replaying work
or changing a newer run or the task's status.

This late-recording path does not admit reusable leases. Provider resume can
precede the database handoff, so an old stop receipt and a database row lock
cannot prove that reuse has not started. Existing active-source and previously
recorded recovery paths retain their behavior. A missing or rejected original
snapshot does not authorize adopting another released lease.

A retained source receipt records control-plane evidence; it does not prove the
provider still holds the original bytes or that copy-back succeeded. Operators
must verify and recover the exact source separately. Later successful runs and
completed tasks do not certify recovery of earlier workspace files.
