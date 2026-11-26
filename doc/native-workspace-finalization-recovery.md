# Native workspace finalization ownership and recovery

A native provider can fail before it submits a result while its workspace still
contains unpublished edits. A prepared workspace reference is not an export
receipt. Terminal provider failure pins the exact bound sandbox and records a
file-recovery obligation in the same transaction as the failed run. Both setup
failure handlers record that obligation before their terminal writer and provider
cleanup run. This includes descriptor reads that fail inside runtime selection. Only its exact live recovery claim can settle an owned
preparation failure; another owner or a stale claim prevents cleanup. Settling
that claim and recording file retention share a transaction.

The recovery card names the original run and requires evidence that its exact
allocation stopped and its files were recovered. Recording that evidence does
not retry the old turn, certify unknown external actions, change the current task
owner or status, or require an accepted native result. Accepted-result export
recovery and same-run provider recovery keep their existing paths. An export
that has already finalized does not create this file obligation.

Native workspace export and merge acquire a PostgreSQL advisory lock scoped to
company and run before the first physical copyback. The live heartbeat and the
reconciler share that lock. Recovery skips a busy owner without recording another
workspace operation or spending a retry. Recovery also rechecks the coordinator's terminal state and retry time under ownership: an earlier sweep snapshot cannot
start another export after live finalization publishes a permanent repair or delay.
A completed workspace barrier is reread
under ownership before export, and a committed coordinator cannot be overwritten
by a late failure receipt.

An unverified workspace owner keeps one board recovery action for its exact run
and owner fingerprint. Repeated recovery checks do not consume attempts or
rewrite that action. Task completion or cancellation does not prove the old
physical writer stopped, so reads and recovery sweeps retain this action while
the matching run still carries that owner receipt. After the receipt is cleared
or replaced, ordinary stale-action cleanup applies. Cleanup is attributed to
the system; historical cleanup from page reads does not add tasks to a person's
inbox or refresh issue activity timestamps.

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

When PostgreSQL configures an idle-transaction timeout, the owner probes its
dedicated lock transaction at one third of that interval, capped at
30 seconds. The probe stops and joins before the transaction is released. This
keeps a live copyback from losing its lock only because filesystem work has no
database statements. It does not disable the database timeout or reconnect a
failed lock session. Publication still requires the physical connection and
the exact durable owner token. A disabled timeout adds no periodic probe.

## Automatic cloud recovery

New Railway copyback receipts record the exact project, environment, service and
deployment ID. On takeover, the existing finalization reconciler asks the cloud
harness to inspect that deployment. The harness resolves the stack's owned
resources independently and issues a short-lived Ed25519 receipt only when the
exact deployment is `REMOVED` with `deploymentStopped: true`. This covers all
processes in the deployment, including orphaned copyback children. Missing,
truncated, live or unavailable provider evidence leaves the physical fence intact.

The tenant verifies the configured harness key, disjoint receipt audience, stack,
run, owner token, deployment identity and expiry. It records proof and an activity
entry when replacing only the exact owner under the existing advisory lock. The
normal reconciler resumes the accepted result; it does not create a provider turn
or change approval/monitor waits. A changed owner during verification fails closed.

Stop proof alone does not authorize old work to overwrite a current task. After
the provider read, automatic recovery uses the operator path's shared binding
checks under short coordinator, issue and run row locks, atomically with the
owner claim. The task must still be open, assigned to the run or its authoritative
review participant, and bound to that running native execution and accepted
result. A different checkout, newer execution or queued/running legacy execution
prevents takeover. Publication checks repeat this validation; row locks are never
held across physical copyback I/O.

The harness endpoint is `POST /v1/tenant/workspace-worker-stop`. The fleet-wide
server token authorizes a read request, never stop evidence: responses must be
signed by the harness. This endpoint requires the companion cloud harness change.
Deploying only the application keeps unknown owners fenced. No cloud provider
credentials are delivered to tenant applications.

The task view shows only “Restoring saved work…” after the server confirms recovery
or an operator queues it,
then removes the notice when commitment resolves recovery. It exposes no process
identifiers, shutdown form or manual resume control. Legacy receipts without
platform identity and unsupported platforms say operator assistance is needed;
operators use the documented exact-owner API below after independent stop proof.
The three diagnosed historical receipts do not gain a deployment identity merely
by upgrading. Never infer one from elapsed time or a hostname.

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

For legacy receipts, an authorized company owner, company administrator or
instance administrator records independently verified platform evidence through
the operator API. The task has no shutdown form or resume control. The API is
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

This is an operator attestation, not an automatic deployment-platform probe.
The separate `runtime:confirm_owner_stop` authorization action limits this
attestation to active company owners or administrators, the trusted local board,
or an instance administrator. Ordinary runtime managers and agents cannot release
the physical owner receipt. Missing role data keeps the client notice read-only.
A
missing advisory connection alone is insufficient. Admission rejects an active
copyback lock, an observably live local controller, a changed owner, a newer run,
or an unbound result. It records the exact owner and operator evidence atomically
with releasing the receipt. The accepted result, workspace descriptor, source
lease, task status, monitors, and approval waits are unchanged. The ordinary
reconciler performs copyback and applies the saved result through the status
arbiter. No provider wake is enqueued. The recovery action remains visible until
finalization commits. Admission supports saved-result copyback from `result_accepted`,
`workspace_finalizing`, and `retryable_failure`; an abandoned retry does not need
a replacement run. The existing retry schedule remains unchanged.
Repeating the same confirmation before reconciliation is
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
3. Use the operator API to record the repair and request export-only retry. The
   task shows operator assistance is needed, without an infrastructure form. The board API is
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

### Quiet task recovery and provider verification

The task conversation does not ask its user to certify recovered infrastructure
files. A source-bound recovery with a live native run or an eligible future
bounded retry uses the normal working presentation. A missed retry, exhausted
budget, unknown action outcome, or unresolved file hold remains visible. The
notice gives a brief explanation and a run-inspection link; stored diagnostics
and operator guidance remain under Recovery details. Source-only repair remains
available through the board-authorized recovery resolution API and its original
stop-receipt and evidence checks.

Remote provider-pack verification retries an interrupted read at most once.
Each command retains its 30-second transport timeout. A timeout, signal, absent
exit status, or transport exception does not prove artifact incompatibility.
Two inconclusive attempts hold the original run with
`runner_remote_provider_verification_unavailable`. Reattachment does not spend
a new provider attempt, so it cannot renew this exhausted read budget. A
completed nonzero verification, digest mismatch, or
wrong OpenCode version remains incompatible and cannot authorize a new provider
turn. Recovery retains the exact source workspace and existing ownership gates;
these read-only retries do not replay tools or alter a retained pack.

### Continue after confirmed source destruction

When an old export failed and its exact sandbox has a confirmed destruction
receipt, the task can continue from surviving attachments. This is reconstruction,
not recovery of the missing edits. The task's recovery notice exposes **Continue
from saved sources** to board operators with `runtime:manage`. Select the surviving
attachments, describe the missing work, and record the observed external action
outcomes. A retained or unverified sandbox must use the existing export or file
recovery path instead.
The source task may still display `in_progress` after an older controller's
run-only Stop. Reconstruction accepts that inactive state only with no execution
or checkout owner and the same source, recovery and status-version checks; an
operator does not need to manufacture a separate blocker merely to record recovery.

`POST /api/issues/{id}/recovery-actions/reconstruct-workspace` records this choice.
It validates the source run, accepted result, prepared descriptor, exact destroyed
lease, current task owner and status version. It rejects active copyback owners,
competing recovery, unreconciled newer executions, and attachments from another task or company.
The transaction records attachment hashes and a durable fresh-session delivery
intent. The old run, result, descriptor and failed finalization remain intact.
Repeated submissions adopt the original intent. Normal admission rechecks source
identity, attachments, authority, budgets, holds and task eligibility. It preserves
the retry count and does not grant a new work window or replay completed actions.
The agent must verify the selected attachments before rebuilding files.
Queued successors recheck their exact reconstruction receipt, sources and current
execution gates when claimed and immediately before provider handoff. A later
human block cannot be overwritten by automatic checkout.
Bounded retries keep the same reconstruction authority. Dispatch verifies the
system wake and predecessor chain back to the approved first run. It rechecks
the saved sources, remaining retry limits and current recovery obligations.
Unrelated executions and uncertain predecessor outcomes still stop dispatch.

A later native run-only cancellation may coexist with the older loss decision
only after its exact Stop acknowledgement, stopped lease receipts, and board
file-only repair have been recorded. Its external-action outcome must be
`not_performed`; an unknown or performed action stays held. Reconstruction saves
the identities and hashes of those repair decisions. Queue claim and dispatch
recheck the same evidence, so a changed receipt or another later run requires a
fresh decision. The cancelled run stays cancelled and is never replayed.

Stop also preserves a native workspace prepared before `paperclip_finish`.
The executor pins its files before releasing the environment. Startup and periodic
recovery process a bounded batch of historical acknowledged cancellations that
missed this step. The existing stop-only cleanup worker retains their exact
sandboxes and records provider receipts; this does not reopen a task or start
another turn. The normal file-only repair control remains required before an
older lost-work reconstruction can proceed.
If file retention loses the task lock, teardown keeps the source active for a
later pass. Historical sources already stopping or stopped remain eligible under
the existing exact-source checks. A stopped source requires the independent
stop-and-retain receipts and must not have a competing allocation owner.
Active warm allocations keep the same retention retry path. Only historical
stopping or stopped sources require the ephemeral policy, because a reusable
released allocation may already have a new owner.
Daytona stop-only cleanup also accepts a freshly verified archived allocation.
It first confirms that provider auto-delete is disabled. It leaves the archive
cold, with its files preserved, and records the process as stopped.
For a cancelled native run, the file-recovery form also offers an optional
confirmation that no external actions were performed. Leave it unchecked unless
the run history verifies that fact. The default records files without certifying
action outcomes. Changing the selected source clears the evidence and confirmations.
