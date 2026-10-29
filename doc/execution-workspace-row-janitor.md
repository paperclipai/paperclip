# Execution workspace row janitor

The terminal workspace reaper archives a row. It never removes one, so the
`execution_workspaces` table grows by one row per run. The row janitor removes
the rows that no longer have a user.

The janitor is a sweeper next to `sweepTerminalWorkspaces`. It runs on the
existing `terminal-workspaces` delivery queue. It adds no new timer and no new
poll loop. The queue wakes for the earliest deadline of the two duties. When
neither duty has a deadline the worker stays quiet.

## The delete guards

The janitor removes a row only when all of these are true.

- No run in status `queued` or `running` reaches the row. A run reaches the row
  through `issues.checkout_run_id`, through `issues.execution_run_id`, or
  through the row's own `source_issue_id`.
- No live row in `execution_workspace_runtime_leases` holds the row. The lease
  table has no status column, so a lease is live while `expires_at` is in the
  future.
- No row in `workspace_runtime_services` holds the row with the status
  `provisioning`, `starting` or `running`.
- No open issue points to the row through `issues.execution_workspace_id`.
- The source issue of the row is `done` or `cancelled`. The whole issue tree of
  the source issue is terminal too, so an open child issue keeps the row.
- No restore point in the status `pending`, `active` or `expiring` holds the
  row. The restore point ledger has no foreign key to the workspace table, so
  the janitor leaves the ledger to its own expiry service.
- The row was not used and not updated inside the cooldown. For a row that the
  archive path already closed, `cleanup_eligible_at` must also be at or before
  the cutoff. The archive path writes that column. The janitor reads it.

## The storage guard

The janitor removes database rows only. It never removes or moves a file on
disk. A row that still owns a worktree is therefore never a candidate. Only a
row that holds no exclusive storage can be removed.

- A row with `provider_type = 'local_fs'` and `mode = 'shared_workspace'` is
  bookkeeping for a shared project checkout. The row owns no worktree. The
  shared checkout lives in `project_workspaces` and stays.
- A row with `status = 'archived'` was already released by the archive path.
  The archive path ran its cleanup and removed the workspace artifacts.

A row in the status `cleanup_failed` is never removed. Its cleanup is pending,
so its storage may still be present. The archive path owns the retry.

A row that still has follow-up work pending keeps its storage, so it stays
too: a plugin workspace whose provider was not removed, a git cache
expiration, a nested clone migration, an isolated repository rehome, and an
isolated task directory.

## The delete is fenced

The delete runs inside `withExecutionWorkspaceLifecycleLock`, the same advisory
lock that the archive path takes. The lock fences the delete against a reopen
that publishes a row between the scan and the delete.

The delete checks every guard again in the same statement. A row that changed
after the scan is not removed. The sweeper counts that row as skipped.

## The reporting

The sweeper returns and logs the number of rows that it removed. It also
returns the number of rows that it checked and the number of rows that a guard
kept. It writes one activity log entry for each removed row, with the action
`execution_workspace.stale_row_removed`.

## The configuration

Three environment variables control the sweeper. All of them have a safe
default.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PAPERCLIP_WORKSPACE_ROW_JANITOR_ENABLED` | `true` | The sweeper runs. |
| `PAPERCLIP_WORKSPACE_ROW_JANITOR_COOLDOWN_DAYS` | `1` | The cooldown of the last guard. A value of `0` removes a row as soon as it has no user. |
| `PAPERCLIP_WORKSPACE_ROW_JANITOR_DRY_RUN` | `false` | The sweeper reports the rows that it would remove and removes none. |

The existing `PAPERCLIP_WORKSPACE_REAPER_COOLDOWN_DAYS` is not reused. That
value belongs to the archive path. The janitor has its own cooldown because it
removes rows.

## Verification

The suite `server/src/__tests__/execution-workspace-row-janitor.test.ts` uses
the embedded PostgreSQL helper. It shows that a stale row is removed and that a
row with a live run is kept. It also covers a live lease, a live runtime
service, an open issue, a source issue that is not terminal, an open child
issue, the cooldown, a shared checkout that stays on the disk, an isolated row
that still owns its worktree, an archived row, a live restore point, the dry
run, and the next deadline.

The suite `server/src/__tests__/workspace-row-janitor-config.test.ts` locks the
parser contract of the three environment variables.

The change adds no database schema and no migration.
