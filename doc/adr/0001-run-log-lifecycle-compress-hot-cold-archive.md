# ADR 0001 — Run-log lifecycle: compress-on-complete, 30d hot, S3 cold archive with DB-tracked tier

- Status: Accepted
- Date: 2026-07-08
- Related: issue #58 (run-log disk pressure / ENOSPC), lue-kube#751 (janitor prune bug + PVC reconcile)

## Context

Agent run-logs are raw stdout stream captures — every `toolcall_delta`,
`thinking`, and `message_update` chunk persisted verbatim as one `.ndjson` line.
In production this repeatedly filled the shared run-log PVC and broke live runs
with `ENOSPC: no space left on device` (adapters fail on "write adapter result
JSON" every timer tick). Forensics on one incident: of 32G in `/paperclip/instances`,
21G was `data/run-logs`; a single company (Smilerite) held 19G, one agent 8.9G,
individual runs 100–668 MB. Only ~3G was older than 7 days — a **generation-rate**
problem, not a retention one, so retention alone frees nothing today.

The dominant lever is compression: streaming-delta ndjson is hugely repetitive and
gzips ~**88x** (a 198 MB run-log → ~2 MB; the existing restic R2 job already sees
~78x). Steps 1 and 2 of this work shipped compress-on-complete and a per-run size
cap. This ADR covers step 3: what happens to those (now tiny) compressed logs over
time, and how one tenant is prevented from starving the shared volume.

## Decision

A three-tier run-log lifecycle, with the DB row as the source of truth for **which
tier a log currently lives in**:

1. **Hot (local, compressed).** On completion a run's `.ndjson` is gzipped to
   `.ndjson.gz` in place. `heartbeat_runs.log_store = 'local_file'`,
   `log_ref` = relative path, `log_compressed = true`. Reads transparently
   decompress.

2. **Cold (S3), after `hotRetentionDays` (default 30).** A periodic in-process
   sweeper (`run-log-archiver.ts`) moves older **terminal** runs to object storage:
   - **Key schema:** `run-logs/<companyId>/<agentId>/<runId>.ndjson.gz`. Stable,
     per-run addressable, groups by tenant then agent.
   - **`log_store` is a tier pointer.** On archive the row is flipped to
     `log_store = 's3'` and `log_ref` is repointed at the S3 object key.
     `log_bytes`/`log_sha256` continue to describe the original uncompressed content.
   - **Verify-before-delete.** Upload → `headObject` must confirm the object exists
     **and** its content length equals the local `.gz` size. Only then is the row
     flipped and the hot copy unlinked (empty agent/company dirs pruned). Any single
     run's failure is logged and skipped; it stays `local_file` and is retried next
     sweep. Ordering guarantees we never delete a hot copy we cannot read back.

3. **Fairness budget.** Before the age pass, the sweeper walks the on-disk tree to
   compute per-company hot bytes. A company over `companyBudgetBytes` (default 5 GiB)
   has its **oldest terminal runs** archived early — ignoring the age gate — until it
   is back under budget. Runs whose status is `queued`/`running` are never selected,
   so a live run is never touched regardless of size.

**Storage access** goes through the existing provider abstraction (`StorageProvider`
via `getStorageProvider()`), never the AWS SDK directly, so the tier stays
provider-swappable (local_disk ↔ s3). The system-scoped archiver deliberately uses
the raw provider rather than the company-scoped `StorageService` facade, because that
facade enforces a `<companyId>/` object-key prefix appropriate for tenant-facing
requests but incompatible with the `run-logs/...` system key schema.

**Age signal:** `coalesce(finished_at, updated_at)`. `finished_at` is set when a run
reaches a terminal status, making it the authoritative completion time; `started_at`
would mis-age long-running-then-recently-finished runs, and `updated_at` alone drifts
on any row mutation. `finished_at` is the primary, `updated_at` a defensive fallback.

**Knobs** (env, resolved in `config.ts`; the archiver reads a single resolved config):
- `PAPERCLIP_RUN_LOG_ARCHIVE` — `auto` (default: archive iff `storageProvider === 's3'`)
  or `off`. When disabled/unavailable the sweeper logs one line and never schedules.
- `PAPERCLIP_RUN_LOG_HOT_RETENTION_DAYS` (default 30)
- `PAPERCLIP_RUN_LOG_COMPANY_BUDGET_BYTES` (default 5 GiB)
- `PAPERCLIP_RUN_LOG_SWEEP_INTERVAL_MS` (default 1h; first sweep ~30s after boot)
- `PAPERCLIP_RUN_LOG_SWEEP_ITEM_LIMIT` (default 200 archive actions per sweep, fairness
  + age combined; sequential, no unbounded concurrency)

**Retrieval** is transparent: `paperclipai runs log <runId>` resolves the run row and
reads via the run-log store, which handles `store: 's3'` by streaming the object,
gunzipping, and applying the same uncompressed offset/limit semantics as the hot gz
path (one shared `readGunzipRange`). Workspace-operation logs are **not** archived in
v1 (small); their read path stays `local_file`.

## Consequences

- **The S3 key schema is hard to reverse once objects exist.** Renaming the scheme
  after archived objects are written means a migration/copy of live data. The schema
  is intentionally minimal and addressable; treat it as a stable contract.
- **Readers must handle both tiers.** Every `heartbeat_runs.log_store` consumer must
  cope with `'local_file'` and `'s3'` (or safely skip). Retrieval and excerpt readers
  were updated; active-run/workspace-operation readers only ever see `local_file`.
- **No local cache in v1.** Every read of an archived run re-fetches + re-decompresses
  from S3. Acceptable for cold (>30d) history; a bounded local read-through cache is
  future work.
- **Graceful degradation.** With `storageProvider = local_disk` (as some deployed
  instances run today) the sweeper is idle; hot files then only age out via the infra
  janitor backstop (lue-kube#751, ~45d). Enabling S3 turns archiving on with no schema
  change.
- **Fairness byte accounting is conservative.** Freed bytes are counted as the
  compressed on-disk size; a rare legacy raw `.ndjson` that is gzipped during archive
  frees more than counted, so the loop may archive marginally more than strictly
  needed — never less. Harmless.

## Alternatives rejected

- **Janitor-only deletion (no DB tier).** The infra janitor prunes by mtime and is
  DB-blind: it cannot offer durable+fetchable history, and a deletion is unrecoverable.
  We keep it as a backstop, not the mechanism.
- **Streaming compression at write time.** Would require refactoring the stateful
  append writer to hold a live gzip stream per run (crash-safety, truncation-cap, and
  live-tail reads all get harder). Compress-on-complete captures ~all the win with a
  stateless finalize step.
- **restic/R2 tag only (current backup job).** DR-oriented: restic snapshots are not
  per-run addressable for on-demand `runs log <runId>` retrieval. Complementary, not a
  substitute for a DB-tracked, key-addressable archive.
