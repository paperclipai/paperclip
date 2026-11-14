# Automatic database backups

How automatic logical backups run and how to restore one. Other database guidance is in [DATABASE.md](DATABASE.md).

Paperclip can run automatic logical database backups on a timer. These backups cover
non-system database schemas, including migration history and plugin-owned database
schemas. Defaults:

- enabled
- every 60 minutes
- retain 30 days
- backup dir: `~/.paperclip/instances/default/data/backups`

Automatic backups are disabled for isolated worktree instances created with
`paperclipai worktree init` or `paperclipai worktree:make`. Existing worktree
configs are migrated to the disabled setting when their server next starts. The
main/default instance keeps the normal enabled-by-default behavior.

Configure these in:

```sh
pnpm paperclipai configure --section database
```

Run a one-off backup manually:

```sh
pnpm paperclipai db:backup
# or:
pnpm db:backup
```

Environment overrides:

- `PAPERCLIP_DB_BACKUP_ENABLED=true|false`
- `PAPERCLIP_DB_BACKUP_INTERVAL_MINUTES=<minutes>`
- `PAPERCLIP_DB_BACKUP_IDLE_CHECKPOINT_ENABLED=1` enables verified final backups
  for owned idle sleep, with restart catch-up. Off by default; see
  [idle sleep safety](idle-sleep-safety.md) for the hosting and storage contract.
- `PAPERCLIP_DB_BACKUP_RETENTION_DAYS=<days>`
- `PAPERCLIP_DB_BACKUP_DIR=/absolute/or/~/path`
- `PAPERCLIP_DB_BACKUP_MAX_AGE_HOURS=<hours>` controls the `/api/health`
  stale-backup warning threshold
- `PAPERCLIP_DB_BACKUP_ALERT_FILE=/path/to/failure-marker` lets external cron
  wrappers surface the last failed backup in `/api/health`
- `PAPERCLIP_WORKSPACE_REAPER_COOLDOWN_DAYS=<days>` sets how long the
  terminal-workspace reaper waits after an issue tree becomes terminal before it
  archives the execution workspace and deletes the worktree. A person can reopen
  the work inside this window. The default is `1`. A value of `0` disables the
  cooldown and restores immediate reaping. A negative or non-numeric value falls
  back to the default.
- `PAPERCLIP_WORKSPACE_COMPACTION_DELAY_HOURS=<hours>` sets how long the reaper
  waits after an issue tree becomes terminal before it removes regenerable files
  from the workspace (see [Terminal workspace compaction](workspace-repositories.md#terminal-workspace-compaction)). The default is
  `1`. A value of `0` compacts on the next sweep. A negative, empty, or
  non-numeric value falls back to the default.
- `PAPERCLIP_WORKSPACE_COMPACTION_ENABLED=false` turns compaction off. Any other
  value keeps it on.
- `PAPERCLIP_SKILL_PACKAGE_STORAGE_ENABLED=false` disables external writes and automatic
  package maintenance for a coordinated rolling upgrade. Default: enabled. Legacy
  conversion runs automatically in bounded batches, outside turn preparation.
  Existing external packages remain readable with the override. See
  [package storage and acquisition](skill-package-storage.md).
- `PAPERCLIP_SKILL_VERSION_RETENTION_KEEP=<count>` sets how many of the newest
  materialized versions of each skill stay on disk (see
  [Skill Version Snapshot Retention](skills-and-teams-catalog.md#skill-version-snapshot-retention)). The default is `0`. A negative, empty, or non-numeric value
  falls back to the default.
- `PAPERCLIP_SKILL_VERSION_RETENTION_GRACE_MINUTES=<minutes>` sets how long a
  materialized skill version stays after its last use. The default is `60`. A
  negative, empty, or non-numeric value falls back to the default.
- `PAPERCLIP_NATIVE_HARNESS_BACKUP_EXPIRATION_DAYS=<days>` sets how long an issue
  stays closed before the failover backups of its native sessions expire (see
  `doc/recoverable-disk-cleanup.md`). The default is `7` and the minimum is `1`. A
  negative, empty, or non-numeric value falls back to the default.
  `PAPERCLIP_NATIVE_HARNESS_BACKUP_EXPIRATION_ENABLED=false` turns expiry off, and
  `PAPERCLIP_NATIVE_HARNESS_BACKUP_EXPIRATION_DRY_RUN=true` only reports candidates.
  A resumed session restores its failover backup from durable storage before the
  provider starts. Each read has a five-minute idle limit instead of a short total
  limit: a large or slow backup keeps restoring while bytes flow. A read that makes
  no progress for five minutes fails with `native_harness_storage_download_stalled`
  and publishes no partial backup. The whole restore, including local decrypt,
  digest and extraction, has a 30-minute outer limit
  (`native_harness_storage_restore_deadline_exceeded`). Stop ends the restore.
- `PAPERCLIP_NATIVE_RUNNER_EVIDENCE_RETENTION_DAYS=<days>` sets how long native
  session continuity-break archives and quarantined session state are kept (see
  `doc/recoverable-disk-cleanup.md`). The default is `7` and the minimum is `1`. A
  negative, empty, or non-numeric value falls back to the default. The backup
  expiration enabled and dry-run switches apply to it as well.
- `PAPERCLIP_NATIVE_WORKSPACE_SYNC_RETENTION_DAYS=<days>` sets how long a settled
  run's native workspace sync folder (descriptor, manifest and seed archives under
  `<instance>/native-workspace-sync/<run>`) is kept (see
  `doc/recoverable-disk-cleanup.md`). The default is `7` and the minimum is `1`. A
  negative, empty, or non-numeric value falls back to the default.
  `PAPERCLIP_NATIVE_WORKSPACE_SYNC_RETENTION_ENABLED=false` turns retention off, and
  `PAPERCLIP_NATIVE_WORKSPACE_SYNC_RETENTION_DRY_RUN=true` only reports candidates.
- `PAPERCLIP_GIT_RESTORE_POINTS_ENABLED=true` lets git cache expiration remove closed
  worktrees with unpushed or uncommitted work after saving an encrypted restore point
  (see `doc/recoverable-disk-cleanup.md`). It is off by default.
  `PAPERCLIP_GIT_RESTORE_POINT_TERMINAL_DELAY_DAYS=<days>` sets how long the issues that
  use the workspace (the source issue and descendants bound to it) must be closed first. The default is `3`. A negative, empty, or non-numeric value falls
  back to the default.
  `PAPERCLIP_GIT_RESTORE_POINT_IDLE_DAYS=<days>` sets how long an open issue tree's
  worktree must go untouched before it is removed the same way; runs restore it
  automatically. The default is `7`, and `0` turns this off.
- `PAPERCLIP_TASK_DIRECTORY_RETENTION_ENABLED=true` lets the terminal workspace reaper
  save and remove plain task directories under `<instance>/isolated-workspaces/` once
  their issue tree has been closed for `PAPERCLIP_GIT_RESTORE_POINT_TERMINAL_DELAY_DAYS`,
  and remove orphaned ones (see `doc/recoverable-disk-cleanup.md`). It is off by default
  and runs as a dry run until `PAPERCLIP_TASK_DIRECTORY_RETENTION_DRY_RUN=false`. Removal
  needs `PAPERCLIP_GIT_RESTORE_POINTS_ENABLED=true`, because the files are saved in an
  encrypted restore point first and restored on reopen.
  `PAPERCLIP_TASK_DIRECTORY_ORPHAN_GRACE_DAYS=<days>` sets how long an orphaned
  directory's issue tree must be closed and its contents unchanged. The default is `7`
  and the minimum is `1`. A negative, empty, or non-numeric value falls back to the
  default.
- `PAPERCLIP_GIT_RESTORE_POINT_RETENTION_DAYS=<days>` sets how long a git workspace
  restore point is kept after its issue tree closes (see
  `doc/recoverable-disk-cleanup.md`). The default is `90` and the minimum is `1`. A
  negative, empty, or non-numeric value falls back to the default.

Without `PAPERCLIP_DB_BACKUP_ALERT_FILE`, health checks look for
`db-backup-to-s3.failure` in the backup directory, beside the backup directory,
and in the default sibling `health/` directory.

DB backups are not full instance filesystem backups. For full local disaster
recovery, also back up local storage files and the local encrypted secrets key if
those providers are enabled.
