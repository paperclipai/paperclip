# Installed skill package storage

Installed repository and editable-skill contents can live in the configured storage
backend instead of PostgreSQL JSONB. The database keeps company-scoped package
identities, storage receipts, source tracking, versions, permissions and run pins.
The original repository tree, wrappers, binary bytes and executable flags retain
their existing behavior. New Git packages also retain an immutable restore recipe;
locally authored/edited packages and unproven legacy packages keep a durable copy.

## Automatic upgrade

No data-migration command is required. The normal schema upgrade applies migration
0415 (`0415_zippy_zemo.sql`). External writes and automatic conversion are enabled by default. Startup
restores pending work from indexed `migration_at` / `maintenance_at` columns. The
shared delivery coordinator converts four snapshots and four versions per batch,
reading one legacy body at a time. It verifies the hash, uploads, reads the objects
back, validates extraction, then clears the legacy JSONB. Version IDs, revision numbers
and run pins stay unchanged. Failures retain the original bytes and retry after an hour.
Bundled release inventories keep their existing small inline validation contract.

Readers can use legacy contents while conversion is pending, including when conversion
commits between the metadata read and the content read. Conversion runs separately
from turn preparation. Completed migration history has no recurring scan. Normal
vacuum and backup retention determine when PostgreSQL reclaims physical space.

`PAPERCLIP_SKILL_PACKAGE_STORAGE_ENABLED=false` is an explicit compatibility override
for a coordinated rolling upgrade: it disables new external writes and automatic
package maintenance. All processes must support the new reader before allowing
external-only writes or clearing old payloads. Once automatic conversion runs, this
reader is the rollback floor; an older binary needs rehydrated database contents.
Use durable, backed-up local storage or S3-compatible storage for authored packages.
The extracted cache is not that storage backend.

Deleting an editable file or folder keeps a temporary copy outside the skill until
the transaction commits. Upload or database failures restore the original subtree,
including binary files, permissions, empty folders and files omitted from inventory.
Successful deletions remove the temporary copy; historical versions retain their
existing package bytes. If the commit reply is lost, recovery checks the saved
version under the mutation lock before restoring. A committed deletion stays
deleted. If the database is unavailable or the skill has since changed, recovery
preserves the backup and logs its location instead of overwriting newer work.

The optional `server/scripts/migrate-skill-packages.ts` command remains available for
diagnostics and controlled batches. It defaults to dry run, supports
`--phase=snapshots|versions|orphans|deletions`, `--company=<uuid>`, `--limit=1..50`,
`--after=<uuid>`, `--apply` and `--clear-legacy`. It is not part of normal installation
or upgrade. Never point it at another instance's database/storage configuration.

## Acquisition and retention

A missing package follows this order: verified local files, stored archive, legacy DB
contents, then an authorized exact-commit Git fetch. A new Git recipe records repository
identity, the original source, a full commit SHA, packager version, the precise included
file manifest (paths, encodings, modes, sizes and hashes), and the content hash. It is
loaded only on a cold miss, never with warm metadata queries. Recovery reads exactly
those files without rerunning discovery or today's filtering rules. A reused repository
name, wrong commit, changed file/mode/hash, missing original commit, or revoked source
credentials fails explicitly; it never substitutes the latest branch. Concurrent misses
coalesce and failed acquisition has a persisted five-minute backoff.

After 30 days, unused Git packages with a verified recipe can lose their cached archive
and extracted copy while retaining their identity, manifest and recipe. Current library
versions, explicit agent pins, active runs and unresolved recovery keep their packages.
A source/version change schedules another eligibility check; packages held by a run or
pin are also reconsidered on restart. This is conservative retention, not an immediate
promise to purge on unassignment. Legacy packages without a provable recipe and authored
or edited copies retain their durable bytes as long as a version references them.
A shared package remains durable when any referencing version lacks its own immutable
repository reference. This also conservatively retains per-skill Git imports without
repository projections. Authored preparation permanently marks the storage receipt as
durable, including when it joins a concurrent Git upload. Expiry checks that marker in
its update, so a later Git import cannot weaken an authored version's retention.

Native runtime assets expire after 30 days without use. An hourly coalesced filesystem
access lease protects preparation through durable run pinning. Cleanup shares the
publication lock, preserves assets referenced by active/recovering runs, and defers if
an unfinished input cannot be interpreted safely. After a pin blocks cleanup, the next
asset use or startup reconsiders it. Missing or damaged copies rebuild from verified
source bytes. The canonical package cache retains its capacity policy below, and runtime
version directories retain their existing pin-aware retention.

Package/version publication and deletion use transaction-aware work notifications;
local asset use signals its filesystem worker. Both reuse the delivery coordinator,
restore deadlines on startup, pause in drain/standby, and stop on shutdown. With no
pending conversion, retry, or eligible cache deadline they perform no recurring work.
The supported live writer is the owning server; independent SQL writers/other servers
need restart reconstruction or an explicit wake. No permanent DB listener is added.
Conversion retains authoritative legacy bytes until verification succeeds. Conversion
retries and cache/deletion dates are optional maintenance eligibility; they may wait
until the next ingress wake, including with package storage disabled. They do not
block idle sleep or claim an external Cloud alarm or measured host suspension.
Each object-deletion receipt has a 30-second storage deadline. Shutdown cancels
pending delete/existence requests; incomplete cleanup retains the receipt for retry.

## Execution and cache behavior

- New packages store one gzip tar archive and one manifest per company/content hash.
  The manifest contains paths, kinds, encodings, executable flags, byte sizes and
  SHA-256 values. PostgreSQL stores keys, hashes, sizes and ownership metadata.
- Preparation uses metadata-only version/package queries. Multiple selected versions
  are batched, and a shared repository descriptor is read once per preparation.
- Known selected repository skills skip unrelated library reconciliation. Selected
  rows and project visibility are still read fresh. Public rows are constrained with
  `access_source_id IS NULL` at the final read, so a concurrent scope change fails closed.
  Aliases, legacy operational skills, missing installations and mutable local sources
  retain the discovery/reconciliation path.
- A cold package download is coalesced in process; the existing company cache lock
  serializes cross-process restoration and pinning. The archive and each extracted
  file are verified before atomic publication. Extraction rejects unexpected entries,
  path escapes, links, duplicate paths, wrong sizes, modes and digests.
- Warm checks inspect directory entries and file identity/size/mode/mtime/ctime.
  Unchanged files avoid content reads and hashing. Changed identities are hashed again;
  altered runtime copies are rebuilt. No marker alone establishes integrity.
- Native asset packaging also caches manifests and asset references, checking both
  the selected source and delivered asset on reuse. It retains no repository bodies.
  Source edits invalidate the reference; missing or corrupt copies rebuild from verified bytes.
- Concurrent cold package I/O is limited to two operations, with a queue of at most 32.
  Cached version inventories and file previews have a separate two-reader, 32-waiter
  bound, so slow storage cannot prevent verified local reads. Both queues honor deadlines
  and cancellation; an overloaded local-read queue does not trigger a storage download.
  Identical cold version/file reads are coalesced. Verified scratch restores repopulate
  the shared cache under a short, nonblocking publication lock, so subsequent reads
  reuse local bytes. Eviction verification runs outside that publication lock.
  Cold administrative responses also have a two-response, 32-waiter bound held
  through post-fill cleanup, so decoded inventories cannot accumulate behind storage work.
  Caller-scoped metadata is read before taking that permit. Acquisition and cleanup
  use a private database connection, so queued transaction readers cannot deadlock
  the ordinary pool, including instances configured with one connection.
  Legacy repository bodies load only inside the I/O limit, including when deriving
  a missing manifest. Waiting readers retain metadata rather than repository contents.
  Packages share the Git scanner's limits of 10,000 files and 100 MiB decoded bytes.
  Recovery splits reads within the Git reader's 9,990-file and 61 MiB batch limits.
  Individual manifests are limited to 48 MiB; the manifest cache holds 16 MiB of serialized data.
  Repository projection metadata is shared; generated
  wrappers/policies have a 16 MiB budget and 256-entry limit. The stat/digest cache holds
  at most 128,000 file records, with 24 concurrent file checks.
  Native skill asset manifests hold at most 32,000 file records and 128 entries.
- Shared extracted packages target 512 MiB and 64 directories per company, trimming
  on cold fills only, with at most two eviction attempts and a ten-second storage
  verification budget per fill. This is a soft limit during a storage outage: cleanup preserves
  the last recoverable copy. Version projections retain the existing pin-aware cleanup.
  Abandoned package staging directories receive a one-hour crash grace.
- Internal package caches, their files, and containing directories cannot be
  imported as local skill sources. Fork the installed skill to retain its original
  access restrictions.

Each entrypoint still has a self-contained runtime tree, and remote staging can
duplicate those trees. This change does not introduce a new runner transport format
or cross-entrypoint asset deduplication.

## Publication, cleanup, and backups

Source imports prepare and verify packages before opening their publication
transaction. Generic authoring calls can arrive inside an existing edit/idempotency
transaction; these retain that serialization lock during upload and use an independent
package connection to avoid a one-connection pool deadlock. No upload happens on the
unchanged warm preparation path.

Uploads use unique attempt keys. An incomplete attempt has a durable claim with a
ten-minute expiry. Retries after expiry use fresh keys; an ambiguous database result
never triggers deletion of a possibly successful upload. A database trigger records
retired keys in `skill_package_deletions`, including company cascades. Promotion of
an upload to a published receipt does not enqueue its objects for deletion.

The maintenance phases `orphans` and `deletions` have the same dry-run/cursor controls.
`orphans` only removes unreferenced snapshot rows older than one day whose upload
claim is settled. Foreign keys protect referenced versions. `deletions` rechecks that
no live receipt owns the keys, deletes the two objects, confirms absence, then removes
the deletion receipt. Failed attempts have at least one hour of grace; retired
published objects have 30 days. These phases also run automatically from their saved
deadlines. Do not apply a blanket bucket lifecycle rule: authored packages and legacy
packages without exact restore recipes still require durable retention.

Database backups must be paired with object backups/history. Do not process deletion
receipts while a retained database backup outside the 30-day window still needs those
objects; extend receipt deadlines or retain object versions according to that backup
policy. A storage provider/bucket/prefix change requires copying and verifying the
objects first. The current storage facade does not find objects in an old bucket.

## Verification

`skill-package-store.test.ts` exercises real PostgreSQL/local storage, cold/warm
reads, same-size edits, offline historical restoration, missing durable objects,
upload recovery, company-deletion receipts, cancellation and resumable migration.
A reader that obtained its descriptor before the legacy clear pass follows the new
receipt, including when its old manifest is already cached. Existing source,
version-cache, retention, concurrency, authoring and runtime-context suites preserve
their original behavior checks. `runtime-context.test.ts` checks warm asset reuse,
source edits and repair through the normal native context builder. Additional recovery,
worker-lifecycle and asset-retention tests cover exact-commit restoration, automatic
conversion, persisted retry, idle/drain behavior and rebuilding expired native copies.

The native preparation benchmark accepts `--package-store=external` and
`--native-assets=true`. It reports elapsed time, PostgreSQL wire response bytes,
root-pool query count, object GET count/bytes, process RSS and preparation spans.
Use `--snapshot-file=<inventory.json>` for a representative saved package,
`--actor=agent --staging-shape=true` for authorization and unrelated-library load,
and `--network-delay-ms=5` for an emulated database delay. Synthetic local timings
are regression evidence, not a claim about deployed Railway latency.


To generate the same-size synthetic fixture without copying a private repository:

```sh
python3 - <<'PYTHON'
import hashlib, json
files = [{"path": "skills/diagnostic/SKILL.md", "kind": "skill", "content":
          "---\nname: diagnostic\ndescription: Native preparation benchmark\n---\nUse the bundled repository.\n"}]
for i in range(1348):
    text = hashlib.shake_256(str(i).encode()).hexdigest(8300)
    content = "\n".join(text[n:n + 64] for n in range(0, len(text), 64))[:16600]
    files.append({"path": f"assets/{i}.txt", "kind": "reference", "content": content})
with open("/tmp/skill-package-benchmark.json", "w") as output:
    json.dump(files, output, separators=(",", ":"))
PYTHON
pnpm --filter @paperclipai/server exec tsx scripts/benchmark-native-skill-preparation.ts --snapshot-file=/tmp/skill-package-benchmark.json --package-store=external --native-assets=true --actor=agent --staging-shape=true --network-delay-ms=5 --selected-skills=10 --warm-runs=20
```

The fixture generator reproduces the recorded file counts and JSON size, with new
synthetic content. Use `--selected-skills=1`, `2`, or `10` for comparable cases.

## Measured results, 2026-10-28

[Recorded samples](plans/2026-10-28-skill-package-performance-results.json) use a
synthetic 1,349-file, 22,799,129-byte JSON inventory. The multi-skill cases add one
entrypoint per additional selected skill. Each case includes native asset preparation,
fresh agent authorization, 155 unrelated library skills, and 5 ms of database network
delay in each direction. The table summarizes all 20 numbered warm samples; a fresh
service instance in the same process was measured separately.

| Selected skills | Warm median | Warm p95 | PostgreSQL response bytes | Ordinary queries | Object GETs |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 245 ms | 326 ms | 19,288 | 5 | 0 |
| 2 | 298 ms | 332 ms | 20,312 | 5 | 0 |
| 10 | 573 ms | 674 ms | 28,536 | 5 | 0 |

All warm cases transferred zero package file-content bytes through SQL and zero
object bytes. Query counts exclude the dedicated advisory-lock connection; wire bytes
include the measured proxy traffic. Cold preparation fetched one manifest and one
archive, about 13.45 MB total, even with ten selected entrypoints. Cold elapsed times
were 3.7, 6.3 and 11.0 seconds respectively. These local samples ran alongside other
verification work and do not establish production latency or a CPU reduction against
an unchanged baseline.

Median process CPU per warm preparation was 83/175/820 ms for 1/2/10 skills; filesystem
checks run concurrently, so CPU can exceed wall time. Process peak RSS was about
887/937/1,235 MB, including the application, synthetic fixture and cold allocations;
these are not incremental cache-memory measurements. Allocated instance file bytes
were about 97/152/596 MB. Runtime/native tree duplication remains visible here and is
a separate optimization. Cache budgets also mean sufficiently large selected sets or
many active companies can evict metadata/digests and require new hashing or asset
assembly; the warm timing is not a constant-time guarantee for arbitrary workloads.

The real S3-compatible proof used a disposable loopback MinIO server built from its
official `RELEASE.2025-04-22T22-12-26Z` source. An 18,008,626-byte archive containing
22 files (18,000,095 decoded bytes) passed multipart upload, independent read-back
verification and cold restoration. `server/scripts/verify-skill-package-s3.ts` repeats
this test against a loopback endpoint and creates/deletes its own bucket and database.
No production storage or Railway instance was changed.


Workspace typecheck, build, migration checks and focused integration tests passed.
The attempted full repository test run did not complete cleanly: parallel shards
reported fixture setup timeouts and assertions, then were stopped for isolation.
The affected skill concurrency assertion and sampled recovery/workspace failures passed
on isolated reruns. The remaining broad inventory is not claimed as verified; see the
[implementation record](plans/2026-10-28-skill-package-storage.md#implementation-verification-record).

## Automatic lifecycle follow-up verification

The final implementation passed 30 focused package/recovery/worker/native tests,
then 15 package/worker tests including two additional regressions for missing stored
objects with a live receipt and retaining unproven historical bytes. Source-sync,
version-retention and native integrations passed 73 tests. The idle-safety suite also
passed. Full workspace typecheck/build passed; the final server was rebuilt after the
manifest normalization fix. Migrations and map checks passed.

The shared PostgreSQL test-template path timed out (and exited a standalone benchmark
before measurement). The passing final runs used the supported
`PAPERCLIP_TEST_POSTGRES_TEMPLATE=0` fresh-cluster path. Earlier retirement assertions
caught PostgreSQL JSONB key reordering; manifest serialization now preserves its v1
wire encoding after a DB round trip. An empty native cache startup case was also fixed.

The final 20-sample warm runs measured:

| Selected skills | Median | p95 | SQL response bytes | Ordinary queries | Object reads |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 256 ms | 302 ms | 19,423 | 5 | 0 |
| 10 | 691 ms | 816 ms | 28,969 | 5 | 0 |

All warm samples still transfer zero package bodies through SQL and zero object bytes.
The larger restore recipe stays out of those queries. Ten-skill cold preparation was
slower on this busy host; the raw receipts retain that result as well as warm samples.
The earlier full repository test attempt remains incomplete; this follow-up does not
claim a clean full-suite result, deployed Railway measurements, or a live agent run.

### Administrative version reads

Version lists, current-version summaries, and test-run detail return file names/kinds
without bodies. Diff and restore fetch only the selected version through its existing
single-version endpoint. Archive reads for those operations and retention checks use
isolated scratch directories, so storage latency does not hold the company preparation
lock. Support inspection reads the requested stored version without Git recovery.

Package preparation renews a 24-hour publication grace. Publication and retirement
lock the same package row and recheck its receipt/current references before commit;
a prepared receipt retired before publication cannot silently become current.
