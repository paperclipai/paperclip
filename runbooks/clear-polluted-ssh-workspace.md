# Clear a polluted shared SSH workspace

This runbook is for operators recovering from a stranded SSH-adapter run whose
workspace import keeps failing because another task left scratch directories
on the remote.

## When to use this runbook

Use this when **all** of the following are true:

- An issue assigned to an SSH-driven agent moved to `blocked` automatically.
- The blocking comment names a non-retryable error code
  `workspace_import_conflict`, **or** the linked run shows tar errors of the
  form `tar: ./<path>: Cannot open: File exists` /
  `Cannot create directory: Not a directory` / `Cannot create symlink: File
  exists` during workspace import.
- The colliding paths reference a sibling task's scratch checkout (e.g. a
  long-finished `release-eng-tmp/magma-blo-XYZ/` checkout, a stale per-task
  build dir, or a partial unzip).

If the run failed for a different reason (auth, sshd down, lease drop, agent
crash, code error), this runbook does not apply — investigate the run instead.

## Background — what changed

The SSH workspace import (`syncDirectoryToSsh` in
`packages/adapter-utils/src/ssh.ts`) now extracts the incoming tar with
`tar --overwrite`, so the same-path file-vs-file collisions that used to
strand the run no longer fail (BLO-1497).

What still fails — and what this runbook is for — is the residual case where
the remote has a non-empty **directory** at a path the incoming archive wants
to occupy with a regular file (or symlink), or vice versa. `tar --overwrite`
cannot reconcile a type mismatch with a populated directory; the import
surfaces a `WorkspaceImportConflictError` that the orchestrator re-emits as
`EnvironmentRunError("workspace_import_conflict", { paths })` carrying the
exact offending remote paths.

The recovery sweep recognizes `workspace_import_conflict` as **non-retryable**:
the source issue moves to `blocked` on the first failure (no 5-cycle loop),
and the recovery owner is paged via the standard "Recover stalled issue"
artifact (BLO-1498).

## Step 1 — Identify the colliding paths

The blocked issue's auto-comment names the recovery issue. Open the linked
run; the failure message includes the conflict paths, e.g.

```
Workspace import into /home/oramadan/paperclip-workspaces hit 3 path
conflicts: release-eng-tmp/magma-blo-1475/orc8r/cloud/go/serde/doc.go,
release-eng-tmp/magma-blo-1475/cdn/cloud/go/services/beacon/storage,
+1 more
```

If the message is truncated, the recovery issue's description includes the
full structured paths array. Use that authoritative list for the next steps —
do not infer paths from log scraping.

## Step 2 — Identify the owning sibling task

For each conflicting path, find the task that put it there. The path prefix
is usually a giveaway:

- `release-eng-tmp/magma-blo-NNNN/` → owned by issue `BLO-NNNN`. Look up the
  ticket; if it is `done` or `cancelled`, the directory is leftover scratch
  and is safe to remove. If it is `in_progress` or has open execution, treat
  it as live work — coordinate before deleting.
- `<task-key>-tmp/`, `<agent-name>-build/` → grep recent runs for matching
  taskKey or agent identifiers.
- Anything you cannot identify → **stop and post a comment** on the recovery
  issue tagging the lane owner (Platform/SRE per [BLO-519]). Do not delete
  unidentified state.

## Step 3 — Snapshot before deleting

SSH to the remote workspace host using the credentials in the lease metadata.
Before any destructive change, snapshot the colliding subtree so you can
recover if you guess wrong:

```bash
# Replace HOST/WORKSPACE/PATH with values from the recovery issue.
ssh "$USER@$HOST" "tar -C $WORKSPACE -czf /tmp/polluted-snapshot-$(date -u +%Y%m%dT%H%M%SZ).tgz $PATH"
```

Keep the snapshot for at least one full sprint. If the deletion turns out to
have hidden in-flight work, restore from the snapshot rather than re-running
the affected task from scratch.

## Step 4 — Remove only the colliding subtree

```bash
ssh "$USER@$HOST" "rm -rf $WORKSPACE/$PATH"
```

**Do not** wipe the whole workspace directory. Other live tasks share the
same shared workspace; clobbering it produces exactly the cross-task pollution
this runbook is meant to clean up.

If the conflict list spans multiple paths under a common parent (e.g. five
files all under `release-eng-tmp/magma-blo-1475/`), prefer removing the
common parent in one step rather than file-by-file — the goal is to leave the
remote consistent.

## Step 5 — Resume the source issue

Once the polluted subtree is gone:

1. Reassign the recovery issue back to the source assignee (or close it if
   the source already has the right state). The standard recovery wake will
   re-dispatch.
2. Verify the next run's workspace import succeeds — the blocked source issue
   should auto-transition out of `blocked` once a successful continuation
   lands.

If the import fails again with a *different* `workspace_import_conflict`
path, repeat Steps 1–4 for the new path. If it fails repeatedly with the same
path, escalate — the `tar --overwrite` path is supposed to resolve all
file-vs-file cases automatically, so a re-occurrence is a regression worth
investigating.

## Step 6 — Prevent recurrence

If a *living* sibling task is putting scratch state into the shared workspace
root, that task should be moved to a per-task scratch subdir
(`agent-home`/`task-session` workspace mode, or a dedicated build dir under
`/tmp/`). Open a follow-up issue against the owning agent with a link to this
incident.

For agents that *must* checkout into the project workspace (e.g. release
engineering tasks that need the source tree), prefer an explicit
`worktreePath` so each task gets its own branch worktree instead of writing
into the project primary.

## References

- [BLO-1497] SSH workspace tar import crashes on pre-existing files — root
  cause and the `tar --overwrite` + `WorkspaceImportConflictError` fix.
- [BLO-1498] Platform/SRE — SSH adapter tar-extract collides with sibling
  task workspace state — recovery loop hardening (this runbook,
  non-retryable error-code short-circuit).
- [BLO-519] / [BLO-518] — Platform/SRE lane ownership.

[BLO-1497]: /BLO/issues/BLO-1497
[BLO-1498]: /BLO/issues/BLO-1498
[BLO-519]: /BLO/issues/BLO-519
[BLO-518]: /BLO/issues/BLO-518
