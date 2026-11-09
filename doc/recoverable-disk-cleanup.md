# Recoverable disk cleanup

The server materializes immutable skill versions under
`<instance>/skills/<company>/__versions__/<skill>/<version>`. These are disposable
disk copies: the company-scoped version and repository snapshot rows retain the
contents, including binary files and executable flags. Normal skill resolution
rebuilds a missing copy from the database without contacting its upstream source.

## Skill version caches

An hourly background sweep considers at most 50 directories per batch, yielding
between batches. It starts after server readiness, and respects the existing
worker shutdown, standby, and idle-drain controls. A non-current version becomes
eligible after one hour without use. Current versions, active-run pins and
unsettled recovery pins are retained. If an active run's version selection is
unknown, that company's caches remain. Non-versioned skill directories and
database snapshots are never removed by this worker.

Last-use records live separately under `__version_access__`. Older installations
without those records receive a full one-hour observation period. Preparation,
pin persistence and eviction share a company-scoped database lock across server
processes. Snapshot validation and byte counting run outside that lock; cleanup
rechecks current versions, run pins, last use, and directory identity before rename. Audits hold the lock through their file reads. Eviction atomically
moves a cache into unique `.trash-<UUID>` directories; trash deletion uses its own lock so normal
preparation can restore files while deletion finishes. A later sweep finishes
interrupted trash removal without deleting a newly materialized version.

Controls:

| Environment variable | Default | Effect |
| --- | --- | --- |
| `PAPERCLIP_SKILL_VERSION_RETENTION_ENABLED` | `true` | Set `false` to stop future sweeps; restoration stays available |
| `PAPERCLIP_SKILL_VERSION_RETENTION_DRY_RUN` | `false` | Set `true` to report candidates without changing cache or access records |

The internal `skillVersionRetentionService` supports company-scoped diagnosis,
bounded continuations, cancellation between entries, and dry run. Explicit agent
pins stay cached. Operators can also retain newest versions with
`PAPERCLIP_SKILL_VERSION_RETENTION_KEEP` (default `0`), or change the one-hour
window with `PAPERCLIP_SKILL_VERSION_RETENTION_GRACE_MINUTES` (default `60`). Each batch reports
candidate and reclaimed allocated bytes, eviction counts, and skip reasons in
the server log. Compare volume usage before and after to verify physical savings;
concurrent writes and filesystem allocation can affect the net change. A dry run
does not start the legacy observation period.

Roll out with dry run enabled, inspect candidates/skips, then enable removal.
Recovery archives and runner backups have separate ownership and retention;
this worker never scans or removes them.

## Native session failover backups

After each remote turn, the server copies the sandbox's harness state (runner
state plus the provider's session home, such as `codex-home`) to
`<instance>/runtime/paperclip-runner/durable-sessions/<scope>/failover-backups/current`.
A replacement sandbox restores the session from this copy, and an ephemeral sandbox
restores it at the start of every turn. Each session keeps one copy, and a single
copy can reach several gigabytes. Codex copies omit credentials, scratch
directories, and data Codex downloads again on startup: remote plugin bundles under
`plugins/cache/<remote marketplace>`, the remote plugin catalog cache, and plugin
install staging. After a restore, remote plugins can be unavailable to a turn until
Codex finishes downloading them.

An hourly background sweep expires the copy once the session can only resume by
reopening closed work. It checks at most 200 sessions and expires at most 50 per
batch, starting two minutes after readiness. A copy expires when all of these hold:

- every issue the session ran on is `done` or `cancelled`, and closed before the window;
- the copy itself was written before the window;
- no run of the session is queued, running, or unfinished;
- every native run finalization of the session is settled, with no recovery in progress;
- no active, released, retained, or pending-cleanup environment lease references the copy;
- the session is not executing, initializing, warm, or closing in this process, and
  no cleanup activation is pending in its directory.

A session whose control-plane state is missing, unreadable, or larger than 4 MB
keeps its copy, because the sweep cannot identify its runs.

The sweep checks and locks these rows in one transaction, and removes the agent task
session that points at the session there. A reopened issue therefore starts a fresh
native session instead of resuming the expired one. The copy is atomically renamed to
`failover-backups/.retiring-<UUID>`, and a final check looks for a run of the session.
If one appeared, or the check fails, the rename is undone. Only a confirmed copy is
renamed to `.expired-<UUID>` and deleted asynchronously. A later sweep restores an
unconfirmed `.retiring-*` copy when `current` is missing, drops it when a newer
`current` exists, and finishes an interrupted deletion.
The rest of the session directory, including its control-plane state, is kept.

| Environment variable | Default | Effect |
| --- | --- | --- |
| `PAPERCLIP_NATIVE_HARNESS_BACKUP_EXPIRATION_ENABLED` | `true` | Set `false` to stop expiring copies |
| `PAPERCLIP_NATIVE_HARNESS_BACKUP_EXPIRATION_DRY_RUN` | `false` | Set `true` to report candidates without deleting copies or task sessions |
| `PAPERCLIP_NATIVE_HARNESS_BACKUP_EXPIRATION_DAYS` | `7` | Days an issue must be closed before its sessions' copies expire (minimum `1`) |

Each batch that finds candidates logs them with candidate and reclaimed allocated
bytes, cleared task sessions, and skip reasons.

## Git workspace restore points

Git cache expiration (`PAPERCLIP_GIT_CACHE_EXPIRATION_ENABLED=true`) normally removes a
closed issue's worktree only when its remote can reproduce it exactly. With
`PAPERCLIP_GIT_RESTORE_POINTS_ENABLED=true`, it can also remove a worktree that has
unpushed commits, uncommitted or untracked files, or history-only commits, once its issue
tree has been closed for `PAPERCLIP_GIT_RESTORE_POINT_TERMINAL_DELAY_DAYS` (default `3`).
It also removes the worktree of an issue tree that is still open once nothing has
touched it for `PAPERCLIP_GIT_RESTORE_POINT_IDLE_DAYS` (default `7`, `0` turns this off):
no issue in the tree or bound to the workspace was updated and no run for those issues or
the workspace was created, started or finished in that time, and no run is still live. An
interrupted removal is finished by later sweeps while the issue stays open. The workspace reaper sets a
deadline for that moment, so open trees cost no recurring checks before then. When a run
later finds its issue's workspace removed this way, it reopens the workspace, restore
point included, before using it; if the restore fails, the run fails instead of starting
in a new workspace. A comment or an agent update on the issue reopens it the same way.
Before removal it saves a restore point:

- a git bundle of commits the remote does not have, against a remote-verified base,
  including commits only reachable from the reflog or `ORIG_HEAD`;
- deterministic snapshots of the index and working tree, including untracked files and
  non-default file modes. Ignored files are left out, and so are untracked `.env` and
  `.env.*` files, which provisioning recreates with current secrets.

The restore point is encrypted with a per-restore-point key wrapped by the instance
secrets key, uploaded to file storage, read back and hash-checked, then activated in
the same transaction that archives the workspace with a versioned recipe
(`paperclip.git-cache-restoration.v2`). Older servers reject that recipe instead of
restoring without the saved work. Under the expiration locks, the worktree must still
match the captured snapshot exactly; otherwise expiration rolls back, keeps the
worktree, and drops the restore point.

Nested managed checkouts under `.paperclip-repositories/` get their own restore points
when their checked-out branch has unpushed commits or uncommitted, untracked or
history-only work. Each is stored under its checkout name, recorded in the recipe's
contents, and verified against its own snapshot under the expiration locks. A nested
checkout still blocks expiration when another local branch or tag has commits its
remote lacks, when any reflog holds commits that are neither on the remote nor part of
the checked-out history the restore point bundles, when it has objects reachable from
nothing, or when its `COMMIT_EDITMSG` holds a draft that matches no commit in its
history. A `COMMIT_EDITMSG` that matches a commit is accepted for every nested checkout.
Each restore point also records a digest of its `HEAD` reflog and `ORIG_HEAD`; under the
expiration locks that history must be unchanged too, so a commit followed by a reset
after capture rolls expiration back. Reopening
re-clones the checkout, imports its bundle, checks out the saved commit and applies the
restore point. Submodules, special git state and ignored files other than `.env`
still keep a worktree from expiring.
Restore points are refused when the file storage is `s3` and the secrets master key
does not come from `PAPERCLIP_SECRETS_MASTER_KEY`.

Reopening the issue, or the next run that recreates the worktree, imports the bundle,
re-adds the worktree at the saved commit, applies the restore point and verifies the
result. The bundle is always imported, so history-only commits are present again as
objects in the repository; they are not recreated as branches or reflog entries, and the
restore point keeps them until it expires. A draft commit message left by an aborted
commit still keeps the worktree from expiring, because restore points do not save it. A worktree that already matches is only marked applied, and a worktree that
diverged is never overwritten: the restore fails closed and can be retried. A missing
or corrupt restore point also fails closed.

When a restore point has expired, through retention or on a nested checkout, reopening
starts fresh instead: the worktree is recreated on its branch (the branch tip if the
repository still has it, otherwise a new branch from the base ref), the project's nested
repositories are cloned fresh before the provision command runs, the saved recipe is
dropped, and a system comment on the issue warns that unpushed and uncommitted work from
before the cleanup is no longer available. The same warning is returned with the reopen
result and recorded on the `execution_workspace.reopened` activity.


Restore points are encrypted saves of the parts of a git worktree that its remote
cannot reproduce: unpushed commits and uncommitted files. They let a closed issue's
worktree be removed and restored later. The table `execution_workspace_restore_points`
tracks each one with its storage key, hash, size and status
(`pending`, `active`, `expiring`, `superseded`, `delete_requested`, `deleted`). The objects live in
the instance's configured file storage (`local_disk` or `s3`).

An active restore point's `delete_after` is either its expiry time or empty while its
source issue tree is open. A database trigger on `issues` keeps this current: when an
issue's status or parent changes, or an issue is deleted, it marks every active restore
point whose source issue is that issue, its old or new parent, or any of their ancestors
as due now, in the same transaction. A retention worker on the shared delivery-work
scheduler runs at startup, when issue changes settle while restore points exist, and at
real deadlines: the earliest expiry, the end of an abandoned capture's grace period, or
a failed deletion's retry. With nothing due, it schedules nothing, and open trees cause
no recurring checks. At review it checks the source issue tree:

- Tree still open: clear `delete_after` and wait for the next issue change.
- Tree `done` or `cancelled`: expire `PAPERCLIP_GIT_RESTORE_POINT_RETENTION_DAYS`
  (default `90`, minimum `1`) after the tree's latest close, immediately if that time
  has passed. Expiry first moves the row to `expiring`, runs the expiry hook, and only
  then requests deletion. An `expiring` row's object is never deleted; after a restart
  or a hook failure the hook is retried, after 15 minutes when it failed.
- Source issue gone: delete.

Deleting an issue or a company marks its restore points `delete_requested` in the same
transaction and notifies the worker, so their objects are removed promptly. A
`pending` restore point older than one hour was abandoned mid-capture and is deleted.
`superseded` and `delete_requested` restore points have their stored object removed,
then become `deleted` once the storage provider confirms the object is gone. A
storage failure is recorded in `last_error` and retried after 15 minutes. Work is
processed in batches of 50; a full batch continues immediately.

Rows have no foreign keys, so they outlive a deleted workspace, issue or company long
enough to remove the stored object. Each run that changes anything logs its counts.

