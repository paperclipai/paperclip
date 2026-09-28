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

The controller cannot verify a process on a foreign or unknown host, or orphaned
copyback children after an abrupt parent death before the success barrier. It surfaces
`native_workspace_finalization_owner_unverified` as board-owned recovery, with no
automatic provider wake. This is an intentional limit: elapsed time or a missing
database connection never proves the old copyback process stopped.

An instance operator must first verify through the deployment platform that the
exact prior controller **and its copyback subprocesses** have stopped. Retain the
sandbox, accepted native result, and workspace descriptor. Do not run a new
provider turn, delete workspace contents, or relax archive confinement.

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

This replaces the former manual export-repair endpoint and task card. There is
no operator repair workflow for unsafe archives.

Pending stop-only cleanup intents from the former manual-repair flow still use
the exact recorded provider and verified stop receipt. They cannot fall through
to destructive teardown. This compatibility path creates no new task warning,
repair action, or provider turn.

Legacy cleanup requires the pinned worker to advertise `environmentStopLease`,
whose contract forbids deleting the allocation even if stopping fails. A
release-only worker leaves the old intent pending; ordinary release is never a
substitute for stop-and-retain. New exports do not create these intents.

## Explicit stop-and-retain cleanup

Every sandbox cleanup request with `stop_and_retain` records an exact durable
intent before provider dispatch. Plugins must advertise `environmentStopLease`;
built-in providers must implement `stopLease`. Missing support, an unconfirmed
stop, or changed allocation ownership leaves cleanup pending without substituting
ordinary release or destroy. The cleanup sweep can finish the same intent after
a controller restart.

Daytona disables and verifies provider auto-delete before stopping a retained
allocation. Stop failure never falls back to deletion. Ordinary destroy requests
keep their existing policy. This cleanup path adds no workspace repair endpoint
or task warning, and does not change the best-effort unsafe-export policy above.
