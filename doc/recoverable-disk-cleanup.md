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
