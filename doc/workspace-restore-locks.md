# Workspace restore locks

Workspace restore and agent-file collection serialize writes to each canonical
target directory. Their lock files live in
`<instance root>/locks/directory-merge`, outside the writable target. All writers
must use the same instance root and a filesystem with reliable SQLite file
locking. Network filesystems that do not provide that locking are not supported.

Each target has a permanent `<hash>.lock.sqlite` file. An open SQLite
`BEGIN IMMEDIATE` transaction holds its reserved file lock for the entire write
operation. Contenders retry without blocking the Node event loop, up to the
existing 30-second limit. Closing the connection releases the lock; the operating
system also releases it when the process exits or crashes. Independent targets
use different files and can proceed concurrently.

This uses the same built-in `node:sqlite` dependency as workspace manifests.
See [SQLite file locking](https://www.sqlite.org/lockingv3.html) for the reserved
lock contract. No application database or schema migration is involved.

The adjacent `<hash>.lock.owner.json` records a PID and creation time only for
bounded timeout diagnostics. Missing, stale, or incorrect metadata cannot grant
or retain ownership. PID reuse, PID namespaces, and wall-clock changes do not
decide whether a writer owns the lock.

**Never delete, replace, or move a `.lock.sqlite` file while an instance can
write to it.** Its stable inode is part of the locking contract. Replacing it
could let two writers lock different files for the same target. Files remain
after release, including for targets that no longer exist. Their diagnostic
owner sidecars are normally removed after release.

## Upgrade from directory locks

Older versions created `<hash>.lock/owner.json` and checked only whether the
recorded PID existed. A server restart could reuse that PID and leave an orphaned
lock permanently protected. Those records cannot establish a process lifetime or
PID namespace, so the new implementation never guesses that a legacy holder is
dead. An existing legacy directory continues to block admission.

Do not run old and new lock protocols concurrently against the same instance
root. An old process does not participate in the SQLite lock protocol.

1. Drain and stop **all** old server and worker processes that can write to the
   instance root, including processes on other hosts or in other containers.
2. Preserve any unfinished-run evidence needed for recovery. After all writers
   are stopped, move leftover legacy `<hash>.lock/` directories to an operator
   scratch directory outside the lock root. Do not remove `.lock.sqlite` files.
3. Start all writers on the new version. Verify that a run completes both the
   provider turn and file collection/restore. A successful model response alone
   does not prove that its local file changes were saved.

The same drain requirement applies to rollback. Existing permanent SQLite files
can remain on disk; older versions ignore them. Do not infer that a legacy lock
is safe to remove from its age, an absent PID, or a successful task response.

This change prevents new orphaned ownership. It cannot recover file changes
that an earlier failed collection discarded.

## Required remote restore failures

When a legacy sandbox run cannot copy required workspace files back, the server
keeps the original allocation for repair. It writes the failed run, the exact
lease retention intent, and a board-owned repair hold in one transaction. The
hold survives reassignment and conversation resets and coexists with newer
recovery incidents; it never supersedes them.
Cleanup stops that allocation and verifies its provider receipt. It does not
use ordinary ephemeral destruction or return the source to warm reuse. Stop
failures use the existing cleanup retry and backoff policy.

The retained source uses `retain_on_failure`. A stopped source can still incur
provider storage charges. It stays available until an operator recovers or
explicitly discards it; elapsed time never proves that its files were copied.
The task's `GET /api/issues/:id/recovery-actions` response lists these repair holds
alongside any newer active incident, including the original lease IDs. Inspect
those exact leases through `GET /api/environment-leases/:leaseId`,
confirm that cleanup stopped them, recover the missing files, and record
`workspaceRepairEvidence` through the existing recovery-action resolution API.
Use the exact recovery action ID, `outcome: "restored"`, the task's **unchanged**
`sourceIssueStatus`, and `executionReconciliation` for the recorded source run.
Only a board operator can record this repair. It preserves the current task
owner, conversation generation, status, and execution locks. It does not queue a
continuation or replay the stopped run; after repair, any new work still follows
the normal admission rules.
Then use the provider's operator console to remove that exact retained
allocation when its files are no longer needed. Verify its immutable provider
allocation ID against the recorded lease before removal. The ordinary reusable
sandbox cleanup does not select `retain_on_failure` sources; do not use
environment deletion as proof that this allocation was removed. Keep the
environment and its provider credentials until recovery is complete. Recording a
repair decision does not automatically destroy it.

A new message, Retry, or `/new` cannot clear this workspace repair hold. Ordinary
local lock-timeout retries and runs without a required remote copy-back failure
keep their existing policy. This change preserves future failures; it cannot
recover files from an allocation that was already destroyed.
