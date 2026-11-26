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
