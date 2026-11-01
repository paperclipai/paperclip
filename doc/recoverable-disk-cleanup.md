# Recoverable disk cleanup

The server materializes immutable skill versions under
`<instance>/skills/<company>/__versions__/<skill>/<version>`. These are disposable
disk copies: company-scoped versions reference durable packages in the configured
storage backend, or retain legacy database inventories. Normal skill resolution
rebuilds missing copies, preserving binary bytes and executable flags. New Git packages
can also restore the exact original commit from their saved recipe using current
repository access. Authored/legacy packages without that recipe require independent
external durability before eviction; unavailable storage leaves those caches intact. Shared extracted packages have a
separate cold-fill capacity policy. See [package storage](skill-package-storage.md).

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
| `PAPERCLIP_NATIVE_RUNNER_EVIDENCE_RETENTION_DAYS` | `7` | Days continuity-break archives and quarantined session state are kept (minimum `1`) |

Each batch that finds candidates logs them with candidate and reclaimed allocated
bytes, cleared task sessions, and skip reasons.

### Continuity-break archives and quarantined session state

The same sweep also removes two kinds of evidence that native sessions leave behind
under the same root:

- `<session>/continuity-breaks/<epoch ms>-<UUID>/`, written when a session starts a
  fresh provider session and moves the retired session's state aside. Nothing reads
  these archives again.
- `quarantine/<session>.<reason>.<epoch ms>.<pid>.<UUID>/`, written when a session's
  state loses authority. Recovery and failed-run retry still consult these entries.

An entry's age comes from the epoch in its name, or from its modification time when
that epoch is in the future. An entry is removed once it is older than
`PAPERCLIP_NATIVE_RUNNER_EVIDENCE_RETENTION_DAYS` and its session is not executing,
initializing, warm, or closing in this process. Quarantine entries created by
native cleanup (`<session>.identity_indeterminate.cleanup.<UUID>`) are referenced
from recovery history and kept. Symlinks are never followed or removed. Once a
quarantined entry is removed, recovery and failed-run retry no longer see it, so a
later run of that session may start a fresh provider session instead of refusing.

The evidence check runs on the sweep only when something is due: once at startup,
then when the oldest retained entry, or an entry the executor has written since,
reaches the window, and on the next sweep after a busy session, a failed removal,
or a full batch. It only reads the filesystem and never queries the
database. A dry run reports each candidate once until newly written evidence comes due.

An entry is renamed to `.expired-<UUID>` in its folder before it is deleted, and a
later sweep finishes an interrupted deletion. An empty `continuity-breaks` folder
is removed. Archives, quarantine entries, and leftovers count toward the batch
limits of 200 entries and 50 removals shared with backup copies, and
`PAPERCLIP_NATIVE_HARNESS_BACKUP_EXPIRATION_ENABLED` and `_DRY_RUN` apply to both.

## Native workspace sync folders

Each native run that syncs a workspace with a remote sandbox writes a folder at
`<instance>/native-workspace-sync/<run>/` with its descriptor, manifest, and the
workspace and git seed archives. A seed can reach more than a gigabyte. Only the
same run reads the folder again: restart recovery, finalization export, board export
retry, and retained workspace recovery. Later runs adopt warm workspaces from lease
metadata and the shared `generations` cache, which this worker never touches.

A retention worker on the shared delivery-work scheduler removes a run's folder once
nothing can read it. It runs at startup and at real deadlines: the earliest settled
run's finish (or an orphan folder's newest file) plus the retention window, a
recheck one window later for folders it had to keep, and a 15-minute retry after a
failure, a held finalization lock or a leftover it could not delete. With no
folders it schedules nothing; when a run then creates its folder in this server
process, the worker wakes and schedules that folder's deadline. A folder
named for a run id, that is a real directory and whose newest file is older than
the window, is removed when one of these holds:

- no run with that id exists;
- the run has no valid workspace sync reference and is settled: it `succeeded`,
  `failed`, was `cancelled`, `timed_out` or `interrupted`, finished before the
  window, has no live process, no live controller lease and no finalization owner
  receipt;
- the run is settled as above, and also:
  - its native run finalization, if any, has no lease owner or scheduled retry and is
    `committed`, or `terminal_failure` with no recovery state or `blocked`;
  - no active or escalated workspace export or owner-unverified recovery action
    names the run;
  - no lease of the run carries `nativeWorkspaceExportResume` or a cleanup in flight;
  - its referenced lease was destroyed, or no retained workspace recovery of the run
    is scheduled, running, awaiting evidence, queued or recovering;
  - historical recovery adoption has no pending work for the run.

Failed native runs can keep their recorded process ID after they finish. A recorded
process blocks removal only while it can still be the run's own process: the run has a
local lease or no lease, and the process ID or process group still exists on this
host with the recorded start time (or a start time that cannot be read). A process ID
from a remote sandbox, or one the operating system reused, does not block removal.

Each folder is checked in one transaction that holds the run's finalization
ownership lock, so it never races a finalization or export of the same run. A held
lock skips the folder. Inside that transaction the folder is renamed to
`.expired-<UUID>`, and it is deleted after commit. The next sweep finishes an
interrupted deletion. Each batch tries at most 50 leftovers, then checks at most 200
folders and removes at most 50. Leftovers and folders each continue from where the
previous batch stopped, so a leftover that cannot be deleted does not block others. Deadline discovery reads
run state 200 folders at a time and stops when the server drains or shuts down.

| Environment variable | Default | Effect |
| --- | --- | --- |
| `PAPERCLIP_NATIVE_WORKSPACE_SYNC_RETENTION_ENABLED` | `true` | Set `false` to stop removing folders |
| `PAPERCLIP_NATIVE_WORKSPACE_SYNC_RETENTION_DRY_RUN` | `false` | Set `true` to report candidates without removing folders |
| `PAPERCLIP_NATIVE_WORKSPACE_SYNC_RETENTION_DAYS` | `7` | Days a run must be finished, and its folder untouched, before removal (minimum `1`) |

Each batch that finds candidates logs them with candidate and reclaimed allocated
bytes and skip reasons.

## Git workspace restore points

Git cache expiration (`PAPERCLIP_GIT_CACHE_EXPIRATION_ENABLED=true`) normally removes a
closed issue's worktree only when its remote can reproduce it exactly. With
`PAPERCLIP_GIT_RESTORE_POINTS_ENABLED=true`, it can also remove a worktree that has
unpushed commits, uncommitted or untracked files, or history-only commits, once its issue
tree has been closed for `PAPERCLIP_GIT_RESTORE_POINT_TERMINAL_DELAY_DAYS` (default `3`).
For this, only the issues in the tree that use the workspace count: the source issue, and
each descendant that is bound to it (`execution_workspace_id`, which is how a child that
inherits the parent's workspace with `reuse_existing` is recorded) or that selects it as
its current or pending existing workspace. The delay runs from the latest close time among
those issues. A closed issue's worktree can therefore be removed while descendants that
work in their own workspaces stay open. Any issue still bound to the workspace, and any
live run, finalization, lease, recovery action or runtime service of an issue in the tree
or of the workspace, still keeps it. If an open descendant later binds to the removed
workspace, its next run or a comment reopens it from the restore point, as below. The
workspace reaper does not compact or archive such a worktree by its normal rules while
descendants are open; only expiration removes it.
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
  non-default file modes. Untracked `.env` and `.env.*` files are left out, because
  provisioning recreates them with current secrets;
- a separate snapshot of ignored files, such as build caches or files an agent kept out of
  git. It leaves out `.env` files, nested `.paperclip-repositories` checkouts (they get their
  own restore points), `.claude/settings.local.json` (saved with the workspace contents)
  and anything inside a regenerable directory such as `node_modules` or `dist`. A
  restore point with ignored files uses payload schema `v2`, which older servers reject
  instead of restoring without them. Restoring never overwrites an ignored file that already
  exists, and an ignored nested repository keeps the worktree.

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
A nested checkout's remote-tracking refs (`refs/remotes/origin/*`) and their reflogs can
point at commits the remote has since dropped, for example a branch deleted after a squash
merge. Strict expiration keeps such a checkout. In restore point mode those commits are
saved in the checkout's restore point instead, as history-only objects (the remote-tracking
refs themselves are not recreated), and any change to the remote-tracking refs after capture
rolls expiration back.
Each restore point also records a digest of its `HEAD` reflog and `ORIG_HEAD`; under the
expiration locks that history must be unchanged too, so a commit followed by a reset
after capture rolls expiration back. Reopening
re-clones the checkout, imports its bundle, checks out the saved commit and applies the
restore point. Submodules, special git state and ignored files other than `.env`
still keep a worktree from expiring.
Restore points are refused when the file storage is `s3` and the secrets master key
does not come from `PAPERCLIP_SECRETS_MASTER_KEY`.

## Isolated task directories

Tasks without a project repository run in a plain (non-Git) directory at
`<instance>/isolated-workspaces/<companyId>/<issueId>/`. Its execution workspace row has
strategy `project_primary`, provider `local_fs` and that exact path as `cwd`, in
`isolated_workspace` or `shared_workspace` mode. Agents can leave the only copy of their
work there, such as reports or generated files, because nothing pushes it anywhere.

Before this cleanup existed nothing removed these directories. The terminal workspace
reaper archives a workspace only after proving delivery through Git (a merged pull request
or a merged branch); for a directory that is not a Git checkout the status inspection fails,
so the row was always skipped as undelivered. A workspace archived by hand keeps its
directory too: artifact cleanup removes a `local_fs` directory only when the row says the
runtime created it, and task directory rows never say so. Deleting them on archive would
discard work silently, so retention saves the files first instead.

With `PAPERCLIP_TASK_DIRECTORY_RETENTION_ENABLED=true` the terminal workspace reaper
handles an open task directory row once every issue in its tree has been `done` or
`cancelled` for `PAPERCLIP_GIT_RESTORE_POINT_TERMINAL_DELAY_DAYS` (default `3`), the same
delay git restore points use. It registers that moment as its deadline, so a closed tree
costs no checks before then. It removes the directory only when all of these hold, checked
under the issue's source lock and the workspace lifecycle lock:

- the source issue is still bound to the workspace (`issue_not_bound` otherwise), because
  reopening restores through that binding;
- no run of the tree or the workspace is queued, running or unfinished, no native run
  finalization is unsettled, no environment lease or runtime service is live, no recovery
  action is unresolved and the workspace is not waiting for a reopen to be consumed
  (`live_or_unresolved_consumer`); these are the checks git cache expiration uses;
- no other open workspace or project workspace points into the directory (closed rows
  for the same issue do not count);
- the directory is a real directory, not a symbolic link (`unsafe_task_directory`).

It then saves a restore point of the directory: every file with its mode, every
directory and every symbolic link (the link itself; links are never followed). A
`node_modules` directory next to a `package.json` is left out, because installing the
package recreates it. Sockets, devices and other special files keep the directory
(`unsupported_filesystem_entry`), and so does a directory over the restore point limits
(`task_directory_too_many_files`, `task_directory_file_too_large`,
`task_directory_too_large`; 20,000 files, 64 MiB per file, 256 MiB in total). The
captured snapshot is decoded once before anything is removed; a directory whose snapshot
could not be restored stays (`task_directory_not_restorable`). The restore
point uses the git restore point ledger, storage and encryption: it is sealed with a
per-restore-point key wrapped by the instance secrets key, uploaded to file storage under
`git-restore-points/<workspace>/<generation>/task-directory/`, read back and hash-checked,
and activated in the same transaction that archives the workspace and records the
`isolatedTaskDirectoryRetention` state in its metadata. It follows the git restore point
retention (`PAPERCLIP_GIT_RESTORE_POINT_RETENTION_DAYS`, default `90`), counted from the
later of the tree's close and the removal, so a task that closed long ago still keeps its
files for the full period. Restore points must be enabled (`PAPERCLIP_GIT_RESTORE_POINTS_ENABLED=true`,
`restore_points_disabled` otherwise), and they are refused when the file storage is `s3`
and the secrets master key does not come from `PAPERCLIP_SECRETS_MASTER_KEY`.

Right before deletion the directory is read again. If anything changed since the capture,
the workspace is made active again, the restore point is dropped and the directory stays
(`task_directory_changed`). Otherwise the directory is renamed to a recorded
`.expired-<random>` name beside it, no longer than the original name, and deleted. The
archive and the removal are recorded as `execution_workspace.task_directory_archived` and
`execution_workspace.task_directory_removed` activity. A removal the
server could not finish is finished by a later sweep.

Reopening the workspace restores the directory before anything uses it: a comment or an
agent update on an issue bound to a closed `isolated_workspace`, or the next run of the
issue in either mode. The files are written to a `.restoring-<random>` staging directory
beside it, whose name is no longer than the original, verified against the saved digest
and renamed into place. An empty directory in the way is replaced; a non-empty
one that does not match keeps the workspace closed and fails the reopen instead of
overwriting it. After a successful reopen the restore point is superseded and removed; the
next retention saves a new one. When the restore point has already expired, the reopen
starts with an empty directory and posts a system comment on the issue saying the earlier
files are no longer available.

### Orphaned task directories

The reaper also walks `isolated-workspaces/` once per server start, at most 8 issue
directories per sweep, continuing from that position in the next sweep. It never follows
symbolic links. For each directory:

- an open execution workspace pointing at or into it keeps it (the reaper handles that
  row as above);
- a closed workspace row that its issue is still bound to is handled like an open row:
  the directory is saved in a restore point on that row and removed after the terminal
  delay, and reopening restores it (outcome `preserved_and_removed`);
- any other directory is an orphan: its workspace row is missing, or archived or
  `cleanup_failed` without the issue bound to it. An orphan is removed when its issue is
  gone, or every issue in the tree has been closed for
  `PAPERCLIP_TASK_DIRECTORY_ORPHAN_GRACE_DAYS` (default `7`), and nothing in it changed
  during that period, and no project workspace, live runtime service, unsettled run,
  finalization, live lease or unresolved recovery action of the issue refers to it. Leases
count when they belong to a run of the issue tree, to an issue in the tree, or to any
workspace row of the directory. An
  orphan is not saved first: no workspace row can reopen it. If its issue is reopened
  later without another workspace, its next run starts in an empty directory.

After that first walk, the reaper looks only at the directories that changes point to: a
workspace row that becomes archived or `cleanup_failed`, or an issue that becomes `done` or
`cancelled`, sends the reaper to that issue's directory and the directories of its
ancestors, whose trees may have just closed. A directory it kept is checked
again at its own deadline: the end of the grace period or terminal delay, or an hour later
when a lock was busy or a live run, lease, service, finalization or recovery action still
used it. A directory whose issue is open waits for the issue to close. With nothing pending
it registers no work. The walk also deletes leftover `.expired-*` and `.restoring-*`
directories older than an hour; when deleting an orphan's trash fails, another walk is
scheduled an hour later.

### Controls and logs

| Environment variable | Default | Effect |
| --- | --- | --- |
| `PAPERCLIP_TASK_DIRECTORY_RETENTION_ENABLED` | `false` | Set `true` to let the reaper handle task directories |
| `PAPERCLIP_TASK_DIRECTORY_RETENTION_DRY_RUN` | `true` | Set `false` to save and remove; a dry run only reports candidates and needs no restore points |
| `PAPERCLIP_TASK_DIRECTORY_ORPHAN_GRACE_DAYS` | `7` | Days an orphan's issue tree must be closed and its contents unchanged before removal (minimum `1`) |

Each open or pending workspace logs `event: "execution_workspace.task_directory_retention"`
with its outcome (`removed`, `dry_run` or `skipped`), skip reason, candidate bytes and
reclaimed bytes. Each directory the walk inspects logs
`event: "execution_workspace.task_directory_cleanup"` with its outcome (`removed`,
`preserved_and_removed`, `dry_run` or `skipped`), reason and bytes. Each reopen that
restores a directory logs `event: "execution_workspace.task_directory_restore"`. A sweep
saves and removes at most 8 open task directories; the rest continue in the next sweep. A
workspace that was skipped is inspected again only when it or its issue changes, or at its
retry deadline, so skipped workspaces do not use up that limit.
Roll out with the dry run, inspect the candidates and skip reasons, then set the dry run to
`false`.

## Nested project repository worktrees

Extra project repositories that have no configured local folder are no longer full
clones inside every task. Each task's `.paperclip-repositories/<name>-<key>` checkout is a
Git worktree of one shared clone per company, project and repository URL: the managed
project checkout for that URL under the instance's `projects/` directory (the same clone
that main task worktrees use when the repository is a task's primary source). Objects are
stored once in that clone, so a new task adds only its working files. Repositories with a
configured local folder are still seeded as independent copies. Existing standalone
nested clones keep working unchanged until the optional conversion below turns them into
worktrees of the shared clone.

Each nested worktree checks out its own branch, `paperclip/<id>/<branch>`, where `<id>`
derives from the worktree path and `<branch>` is the remote's current default branch
(refreshed before each new worktree) or the configured branch ref, tracking
`origin/<branch>`. Reopening derives the upstream from the saved source ref, not from the
branch name. A tag or commit ref is checked out detached, as
before. Branch names therefore never collide between tasks. When a checkout kept under
`.paperclip-runtime/detached-repositories/` still holds that branch, the new worktree
uses `paperclip/<id>/r<n>/<branch>` instead, so the retained work is never reset. `git pull` works as before;
pushing needs an explicit destination such as `git push origin HEAD:<branch>`. Adding the
worktree, fetching and removing registrations are serialized per shared clone. Each new
worktree first fetches with `--prune`, so a branch deleted upstream is rejected as a fresh
clone would reject it. Server-side Git commands on the shared clone run with hooks
disabled, so hooks an agent plants there never run in the server.

Branches and reflogs of a worktree live partly in the shared clone. Expiration and restore
points therefore scope their checks to what belongs to the nested worktree: its `HEAD`,
`HEAD` reflog, `ORIG_HEAD`, index and working tree (stored per worktree) and every branch
under its own `paperclip/<id>/` prefix together with that branch's reflog. Those must be on
the remote or saved in a restore point exactly as for a standalone checkout. Checking out
any other branch, stashes, unsupported refs or custom local config in the shared clone
still block expiration. Branches outside the prefix, other tasks' branches and their
history stay in the shared clone and never block or get deleted. Commits that existed only
in the nested worktree's `HEAD` reflog are written back into the restored worktree's `HEAD`
reflog, so they stay protected after reopening.

Expiring a task removes the nested worktree's registration from the shared clone and
deletes its own branch only at the verified recorded commit. Reopening recreates the
worktree from the shared clone (re-cloning the shared clone if it is gone) on the same
branch and commit and applies its restore point. Deleting or archiving a task removes the
registration of each of its nested worktrees and deletes their branches only when every
commit is on a remote-tracking ref; an unpushed branch stays in the shared clone. Moving a
nested worktree to `.paperclip-runtime/detached-repositories/` when its repository leaves
the project repairs its registration.

### Converting existing standalone nested clones

Tasks prepared before nested worktrees existed still hold a full standalone clone in each
`.paperclip-repositories/<name>-<key>` checkout, often of the same large repository many
times over. With `PAPERCLIP_NESTED_CLONE_MIGRATION_ENABLED=true`, the terminal workspace
reaper converts each such checkout in an open task into a worktree of the project's shared
clone and deletes the standalone clone. It holds the source lock and workspace lifecycle
lock that git cache expiration holds, the per-shared-clone lock that nested worktree
creation holds, and the expiration lock files (`index.lock`, `HEAD.lock` and the current
branch's ref lock) in the clone, so no run,
expiration, reopen, restore or other conversion against the same shared clone can
interleave. A checkout is converted only when:

- no run, native finalization, environment lease or runtime service is still live for the
  workspace, and it is not waiting for a reopen to be consumed (the issue may be open);
- its name is the managed checkout name of one of the project's repository workspaces
  (`unknown_managed_checkout` otherwise), that repository has no configured local folder
  (`local_source_checkout`), and the clone's `origin` is exactly the repository URL
  (`foreign_origin`);
- the project has a verified shared clone for that URL (`no_shared_base`,
  `shared_base_repo_mismatch`) whose local config runs no filters or commands
  (`unsupported_base_git_config`);
- the clone holds only branches, tags and `origin` remote-tracking refs, no stash
  (`nested_clone_has_stash`; stashes are not converted, because `refs/stash` would be shared
  by every worktree of the shared clone), no worktrees of its own, no custom hooks, no local
  config beyond the stock keys, `origin` and branch tracking, no `info/exclude` pattern the
  shared clone lacks (`unsupported_info_exclude`), no in-progress merge, rebase or similar
  state, no hidden index flags, and no commit that only another branch's reflog holds
  (`unique_branch_reflog_commits`);
- nothing a restore point refuses (submodules, filtered paths, special files, untracked
  nested repositories, oversized contents or history).

The conversion fetches the shared clone, then brings the clone's history in under the
checkout's own prefix: the current branch becomes `paperclip/<id>/<branch>` at the same
commit, tracking `origin/<branch>` (or the branch's configured `origin` upstream); every
other local branch whose tip the shared clone's remote-tracking refs do not contain becomes
`paperclip/<id>/<branch>`, every such tag becomes `paperclip/<id>/tags/<tag>` at the
tagged commit, and every such `origin` remote-tracking ref (for example one whose branch was
deleted or force-pushed upstream) becomes `paperclip/<id>/remotes/origin/<branch>`. `<id>` derives from the final checkout path, so later expiration and release
treat those branches exactly like a nested worktree's own branches: they block expiration
until pushed or saved and are never deleted while unpushed. A restore point of the clone,
captured against commits both repositories share and preserving those branch tips, its
`HEAD` reflog and `ORIG_HEAD`, is imported into the shared clone. Other tasks' branches and
worktrees are never touched; a name that already exists in the shared clone skips the
checkout (`nested_clone_ref_conflict`).

The new worktree is added at `<name>.clone-migrating` beside the clone, the restore point
is applied (index, worktree changes, untracked and ignored files, file modes), the `HEAD`
reflog and `ORIG_HEAD` are copied, and regenerable directories, untracked `.env` files and
`.claude/settings.local.json` are moved in by rename. The two must then match exactly
(HEAD, index, worktree, ignored files, modes, reflog, branch and every created ref). Any
difference or failure before the swap moves the items back, removes the new worktree and
the created branches, and leaves the clone untouched. The swap renames the clone to
`<name>.clone-standalone`, moves the new worktree into `<name>` with `git worktree move`
and runs `git worktree repair` in the shared clone. Then one database update records the
worktree in a saved restoration recipe that lists the checkout, and the old clone is
renamed to `<name>.clone-trash` and deleted.

Before it changes the shared clone, the conversion records
`nestedCloneMigrationPending.<name>` in workspace metadata (shared clone, HEAD, created
refs, moved items and phase). The next pass uses it after a crash: before the swap it moves
items back, removes the new worktree and the created branches, then converts again; once
the clone has been renamed aside it finishes the swap and deletes the old clone, so work done
in the converted checkout after a crash is kept. A state that matches neither (for example a
new checkout created at `<name>` while the clone was aside) is left alone with
`nested_migration_recovery_conflict`. The reaper also finishes a pending record after the
workspace is archived; if the task worktree is already gone, it forgets the record, removes
the stale registrations and deletes only created branches whose commits are on the remote.
Expiration treats the `.clone-` names as unexplained
files and keeps the workspace until the conversion settles. A dry run reports a pending
record without acting on it.

Each attempt logs `event: "execution_workspace.nested_clone_migration"` with the checkout
name, outcome (`migrated`, `recovered`, `rolled_back`, `dry_run` or `skipped`), skip reason,
new branch, candidate bytes (the clone's `.git`) and reclaimed bytes. A workspace is
inspected again at most hourly, and a retry deadline it registered survives later sweeps
during that hour. A retry deadline is registered only while a pending record
exists or the skip comes from a live consumer, a busy lock or a changed workspace row; other
skips, including a change caught by verification, wait for a later sweep. The reaper looks
only at checkouts named after the project's configured repositories (plus pending records),
never at arbitrary directories, and attempts at most 8 per workspace per sweep. Pending
recoveries go first, and the rest rotate across sweeps. While a rotation has not yet visited
every checkout it registers a retry deadline; after a full rotation without progress it waits
for a later sweep, until a conversion succeeds or the set of candidate checkouts changes. `PAPERCLIP_NESTED_CLONE_MIGRATION_DRY_RUN=true` reports candidates
without changing anything and registers no deadlines.

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


## Isolated repository sources

For a while, workspace preparation gave some isolated `git_worktree` workspaces their
own full clone of the project repository under
`instances/<id>/isolated-repository-sources/<companyId>/<issueId>/checkout`, with the
issue's worktree inside it. Workspace metadata marks these with `isolatedRemoteSource`.
New workspaces no longer get one; they are worktrees of the project's shared managed
clone. Each old clone still holds a full `.git` and an unused default-branch checkout.

With `PAPERCLIP_ISOLATED_SOURCE_REHOME_ENABLED=true` (and git cache expiration enabled),
the terminal workspace reaper moves each such open workspace onto the shared clone and
then deletes its private clone. It runs under the same source lock, workspace lifecycle
lock and Git lock files as git cache expiration, so no run, expiration, reopen or
restore can interleave. A workspace is moved only when:

- no run, native finalization, environment lease or runtime service is still live for it,
  and it is not waiting for a reopen to be consumed (the issue may be open);
- the project has a shared managed clone for the same `repoUrl`;
- its worktree sits at the standard `.paperclip/worktrees/<branch>` location, and the
  branch is absent from the shared clone, points to an ancestor of the worktree's HEAD
  there, and is not checked out in another of its worktrees;
- the shared clone's local config sets no filter drivers, includes, attribute files, worktree
  config or command settings (`core.fsmonitor`, `core.hooksPath`, `core.sshCommand` and
  similar), and it has no `info/attributes`, because the move checks out files there;
- its Git state is transferable: no stash or replacement refs, no in-progress merge,
  rebase or other worktree-specific state, no hidden index flags, no shallow history, and
  nothing a restore point refuses (submodules, filtered paths, special files, untracked
  nested repositories). The transfer is local, so it uses much larger restore point limits
  than uploads do: 500,000 files, 1 GiB per file and in total, a 1.5 GiB bundle and
  1,000,000 commits.

The move captures a restore point of the old worktree against commits both repositories
share, imports it into the shared clone, creates or fast-forwards the issue branch, adds
the new worktree at the same HEAD and applies the restore point (index, worktree changes,
untracked and ignored files, file modes). The `HEAD` reflog and `ORIG_HEAD` are copied.
What restore points leave out is moved by rename on the same filesystem: regenerable
directories such as `node_modules`, untracked `.env` and `.env.*` files,
`.claude/settings.local.json`, and each nested `.paperclip-repositories/*` checkout as a
whole. A standalone nested clone moves as is. A nested checkout that is a worktree of its own
shared clone moves too, and the move runs `git worktree repair` in that clone so its
registration follows the new path. Its `paperclip/<hash>/` branch is renamed to the prefix of
the new path, because that prefix proves the checkout owns the branch (a rollback moves it
back, repairs it and renames the branch back). Items inside a moved nested checkout, such as
its `node_modules`, move with it. Any other
ignored file that a restore point does not save keeps the workspace in
place.

The new worktree must then match the old one exactly (HEAD, index, worktree, ignored files,
modes and reflog), and every moved item must exist. Only then does one database update
point the workspace at the new path, drop `isolatedRemoteSource`, rewrite a saved
restoration recipe to the shared clone, and record `isolatedRepositoryRehome`
(`{ at, from, to, cleanedAt }`). Any failure before that update removes the new worktree,
moves items back, restores the branch, and leaves the old worktree untouched. Before it
changes the shared clone, the move records `isolatedRepositoryRehomePending` (target, branch,
previous branch tip and planned moves). If the server stops before the update, the next
attempt uses that record to move items back, remove the new worktree and restore the
branch, then starts again. A dry run reports such a record without undoing it. If an item
exists in both places (for example a process recreated `.env` in the old worktree), the
rollback stops with `rehome_rollback_conflict` and keeps the new worktree and the record, so
neither copy is lost; later attempts retry the rollback once the conflict is resolved. A new worktree is removed only when the move created it: a
target that appears from elsewhere is never deleted.

After the update, the old worktree is removed (its ownership is proven by `git rev-parse`
or, when its registration in the clone was already pruned, by its `.git` pointer into the
clone's `worktrees` directory). The clone is then renamed to trash and deleted when nothing
else needs it and everything in it is reproducible:

- no other workspace or project workspace refers to it (a workspace already expired with its
  worktree removed does not count) and no runtime service runs in it;
- after `git worktree prune`, it has no worktree besides its own checkout;
- its own checkout has no tracked changes and no untracked files (only Paperclip's
  compaction trash is allowed, even inside a directory with a regenerable name), and its
  ignored files are only inside regenerable directories (such as `node_modules`) or Paperclip's compaction
  trash. Empty directories, such as the `.paperclip/worktrees` parent left by the old
  worktree, do not count;
- it has only branch, tag and remote-tracking refs (no stash, notes or replacement refs);
- every commit that its local branches, local tags, reflogs (other than remote-tracking
  ones) or `ORIG_HEAD` hold is on one of its remote-tracking refs, present in the shared
  clone, or found on the remote. The remote is read fresh (branches and tags) with the
  company's Git identity, falling back to anonymous access, and only when some commit is in
  neither place. `HEAD` itself counts too, so a detached checkout is covered. Remote branches and release tags that the shared clone never fetched do
  not keep a clone.

A clone with more than 5,000 refs, reflog entries or such commits is kept
(`clone_history_budget`), and so is one with more than 1,000 ignored directories outside
regenerable ones (`clone_file_budget`); those directories are read in one Git call. The log entry names up to five paths, worktrees, refs or commits
that kept a clone (`cloneKeptPaths`). A clone another workspace still uses is kept
(`cloneRetained`); that workspace's own move removes it later. If the server stops after
the update, a later sweep finishes the removal and sets `cleanedAt`, also after the
workspace has been archived.

The reaper also sweeps orphaned clones under `isolated-repository-sources/` once per server
start: clones that no execution workspace refers to (no open workspace with matching
`isolatedRemoteSource`, and no closed one that would need the clone to reopen) and that no
pending move or cleanup still owns. The repository must be proven by the database: the
workspaces of that issue must record exactly one repository URL, and the clone's `origin`
must equal it (`unproven_repository` or `source_identity_changed` otherwise), so a rewritten
`origin` is never fetched or trusted. It applies the same reproducibility check, using the
shared clone of a workspace of the same issue and repository when one exists, and logs
`event: "execution_workspace.isolated_source_orphan_cleanup"`. It inspects at most eight
issue directories per reaper sweep and continues from that position in the next sweep, so a
slow remote cannot hold up other workspace cleanup. When the walk ends and it kept any
orphan, it looks again a day later; otherwise it registers no further work. It also deletes leftover
trash directories from interrupted removals.

Each attempt logs `event: "execution_workspace.isolated_source_rehome"` with the outcome,
skip reason, candidate bytes and reclaimed bytes. A workspace that is skipped, or whose
clone is kept for a reason that can change, is retried an hour later through the reaper's
existing deadlines; nothing runs while there is no candidate.
`PAPERCLIP_ISOLATED_SOURCE_REHOME_DRY_RUN=true` reports candidates without changing
anything.

Re-homed workspaces get a new path. An agent that resumes an older session may still
remember the old path; the run's working directory comes from the updated workspace.

Reopening or restoring an expired workspace whose recipe came from a private clone no
longer recreates that clone when the project has a shared managed clone for the same
repository, its branch there is absent or at the saved commit, and the shared clone has
every commit the saved restore point bundle needs as a base. A recipe with worktree-backed
nested checkouts on branches keeps the old behavior, because their branch names are bound to
the old path. The workspace is
rebuilt as a worktree of the shared clone at the standard location, with the saved commit
and restore point imported and applied as before. Without a shared clone, the old
behavior applies.
