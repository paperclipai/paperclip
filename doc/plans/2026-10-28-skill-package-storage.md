# Move installed skill packages out of PostgreSQL

Status: implemented in this checkout, including automatic conversion, exact-commit
recovery and cache retention. Focused verification passed; the broad test run
did not complete cleanly (details below). No production changes.
Operational contract: [skill package storage](../skill-package-storage.md).
Measured results: [benchmark receipts](2026-10-28-skill-package-performance-results.json).
Investigation date: 2026-10-28. Code inspected: `1ed0af41867ba40fd1d23292d395588d18c2fcbe`.

## Decision

Store the exact audited installed package in the existing storage backend: S3-compatible
object storage for hosted instances, persistent local storage for local installations.
PostgreSQL retains package identities, storage receipts, versions, source tracking,
permissions and run pins. A bounded, verified disk cache supplies execution and file reads.

New Git packages retain an immutable recipe with repository identity, exact commit,
included-file manifest and packager version. Authored and unproven legacy packages
retain independent durable bytes. Also retain the installed package's content hash: the package can exclude unsafe, oversized or unsupported files and can be
a reduced repository subset. A commit SHA alone does not identify that transformation,
provide the bytes when upstream disappears, or represent an edited local copy.

Preserve today's packaging and access behavior during the storage migration. In particular,
do not switch all imports back to directory-only mode or infer a complete dependency
graph from Markdown references. The original dependency-loss bug was real.

The first delivery removes file-content traffic from PostgreSQL for migrated repository
packages, avoids repeated remote reads of the same immutable package, and stops creating
packages for repositories with no installable selected skills. Deduplicating the final
per-skill runtime transport is a separate, explicitly scoped follow-up.

## What the trace established

### Import and refresh

1. Project workspace creation/update calls `enqueueProjectSkillSource` inside the
   workspace transaction. An eligible GitHub URL is sufficient to enqueue; this happens
   before discovery. Existing legacy projects have an explicit adoption path.
2. `skillSourceSyncService.importBinding` checks authority, reserves bounded work credits,
   and requests `packageMode: 'repository'`. The scanner resolves a commit and uses a
   shallow, temporary Git repository to list paths and read blobs.
3. `github-skill-source.ts` discovers entrypoints, builds and audits package files, and
   filters unsupported/unsafe files. Repository mode normally includes the supported
   tree, with a skill-folder-plus-reference fallback for oversized repositories and a
   further skill-only fallback. It does not store Git history or `.git` metadata.
4. `skillSourceService.publish` hashes `scan.repositoryFiles` and inserts their **contents**
   into `company_skill_repository_snapshots.file_inventory`. Deduplication is by company
   and content hash. The insert happens before the selected-valid-skill loop; a nonempty
   package can therefore be stored with no discovered or selected usable skills.
   `ON CONFLICT DO NOTHING` avoids a duplicate row, but still sends the proposed file
   array to PostgreSQL whenever publication reaches that insert. The earlier unchanged
   commit/tree shortcut avoids this path for qualifying automatic checks.
5. Each selected skill version references that snapshot and its original entrypoint.
   Publication also passes `candidate.files` into `createVersion`, which persists those
   contents again in `company_skill_versions.file_inventory`. Thus the full repository is
   shared, but the selected skills' own files have an additional persisted copy.
6. Automatic refresh already skips downloading when the commit or root tree is unchanged.
   It uses saved setup authority, leases, budgets and five-minute deadlines. An included
   file change changes the package hash and versions every selected skill. This conservative
   invalidation preserves access to shared and dynamically chosen dependencies.

The similarly named fields are different: `company_skills.file_inventory` and
`company_skill_sources.repository_package.files` are file metadata; repository snapshot
and version `file_inventory` fields contain actual contents. Moving the former alone
would not address the measured payload.

Source pointers: [project attachment](../../server/src/services/projects.ts),
[binding and identity](../../server/src/services/project-skill-source-bindings.ts),
[worker](../../server/src/services/skill-source-sync.ts),
[scanner](../../server/src/services/github-skill-source.ts),
[publication](../../server/src/services/skill-sources.ts),
[snapshot/version schema](../../packages/db/src/schema/company_skills.ts).

### Reads and execution

`company-skills.ts::runtimeVersionInventory` selects the entire repository snapshot,
then `repositorySkillProjection` builds a generated discovery wrapper plus the full
original tree under `.paperclip-repository/`.

| Consumer | Current unnecessary or amplified work | Replacement |
| --- | --- | --- |
| Runtime preparation | Loads JSONB before checking the materialized directory and before entering the per-version shared promise | Resolve a small package descriptor; coalesce package loading before I/O; validate disk files against hashes |
| Skill audit | Materialization loads the repository; audit requests the inventory again | Reuse the verified package handle and manifest; audit actual delivered bytes |
| Skill detail/file tree | Loads contents, then discards them to keep paths and kinds | Read the package manifest only |
| One supporting file | Falls back to loading the whole repository inventory | Read the requested file from the verified local package cache |
| Fork, create-from-existing, disconnect-and-keep | Projects repository files; editable versions can persist a full projected tree inline | Copy from a package handle; save resulting snapshots to the same external package store |
| Cache retention | `hasRestorableSnapshot` reads repository JSONB on a process-cache miss to validate entrypoints | Verify external durability before eviction; never evict the last usable copy on storage failure |
| Version API / Studio test context | Version objects and one heartbeat join directly consume inline version inventories | Metadata-only internal queries plus explicit package hydration where content is required |

The existing per-version disk cache does **not** prevent the initial database read.
Existing cache locks serialize publication, pinning and eviction, but do not turn
repository identity into a shared content cache.

Each selected entrypoint also gets its own full runtime copy. Native remote launch loops
over skill bundles and stages each directory separately. Moving storage alone does not
remove this disk/transport multiplication. Never assume 79 installed skills means all
79 are assigned or transferred on every run.

Source pointers: [runtime, audit, browsing and version creation](../../server/src/services/company-skills.ts),
[projection](../../server/src/services/skill-repository-package.ts),
[cache locking and restorability](../../server/src/services/skill-version-cache.ts),
[Studio context](../../server/src/services/heartbeat/run-preparation.ts),
[remote staging](../../server/src/services/native-runtime/remote-launch-assets.ts),
[company export](../../server/src/services/company-portability.ts).

### Evidence and limits

The preceding Railway investigation recorded six snapshot reads returning **93.6 MB**
in a 15-minute window: **12.94%** of observed PostgreSQL response bytes. A later metadata
inspection found a package containing **1,349 files**, **22,611,267 serialized JSON bytes**,
and **79 current referencing skills**. These are prior observations, not a fresh benchmark
of this proposal. The measured build was `71b448b9`; the later example was observed on
`b25f3e2a`. The principal import/runtime files inspected here match the earlier linked
`2e5bbde8` revision. Do not extrapolate either capture to every current instance.

Serialized JSON bytes are neither compressed on-disk PostgreSQL size nor raw repository
size. PostgreSQL can compress/store large values out of line using
[TOAST](https://www.postgresql.org/docs/current/storage-toast.html). Selecting the complete
inventory still returns that value to the application. New snapshot payloads also add
database storage, WAL, backup and decoding work; those costs were not quantified here.

Removing this traffic does not establish a 12.94% latency improvement, solve all Railway
slowness, or justify a specific CPU reduction. The capture measures bytes, not causality
for every slow request.

## Why this implementation arose

- [#14713](https://github.com/paperclipai/paperclip/pull/14713), September 30, introduced
  GitHub-synchronized skills on the existing immutable-version foundation.
- [#15731](https://github.com/paperclipai/paperclip/pull/15731), October 12, fixed missing
  shared scripts, policies, sibling skills and credits by preserving repository packages.
  It explicitly chose shared database snapshots and self-contained per-skill delivery.
- [#16066](https://github.com/paperclipai/paperclip/pull/16066), October 13, extended that
  behavior to automatic project imports and refresh.
- [#16308](https://github.com/paperclipai/paperclip/pull/16308) preserved referenced files
  for oversized repositories. [#16433](https://github.com/paperclipai/paperclip/pull/16433)
  subsequently made old disk copies disposable, with database restoration as the guarantee.

The #15731 description reports strong byte/mode, offline, pinning and real runtime proof,
and explicitly acknowledges per-skill runtime duplication. Its inline reviews caught
audit/projection mismatches, lost binary/mode information, unsafe files, expensive regexes,
and per-blob Git process overhead. The review was not indifferent to correctness or cost.

The inspected acceptance evidence does not establish a bound on PostgreSQL response bytes
for warm preparation, one-file browsing, or multiple entrypoints sharing a large package.
The supported explanation is that a legitimate dependency-preservation feature reused a
content-bearing version contract, while performance proof focused on acquisition and
functional delivery. Automatic adoption enlarged the affected workload. Original author
sessions were not identified, so this is not a claim about unrecorded reasoning.

The preventive change is a storage boundary whose normal return type cannot contain a
repository's bytes, backed by real SQL-byte and storage-read assertions for shared packages.

## Proposed implementation

### 1. One package service, existing storage providers

Add an owning service such as `skill-package-store.ts` for encoding, publication receipts,
manifest reads, verified extraction and cache acquisition. `company-skills.ts` consumes it;
the heartbeat only asks for a prepared skill. Provider details stay under `server/src/storage`.

The existing [storage API](../../server/src/storage/types.ts) supports streamed uploads,
reads, HEAD and deletion, with [local](../../server/src/storage/local-disk-provider.ts)
and [S3](../../server/src/storage/s3-provider.ts) providers. Reuse this infrastructure.
Do not put packages in user-visible issue attachments or give them attachment retention.

Use a versioned `tar+gzip` bundle of raw file bytes and a separate bounded JSON manifest.
The manifest contains original path, kind, byte length, SHA-256 and executable flag for
each file. Archive entries live under `files/`; reserved format metadata stays outside
that namespace. Preserve binary bytes and supported modes. No base64 repository JSON is
needed in the stored archive. Stream encoding/compression to a bounded temporary file,
hash it, then stream upload. Do not synchronously compress on the server event loop.

Keep the existing semantic content hash for migrated packages, so migration does not
create new skill revisions. Separately record archive and manifest SHA-256 values and
format version. Do not silently change the current hashing order or rely on an S3 ETag
as a content checksum. Any future hash-algorithm change needs its own versioned identity.

A manifest is sufficient for a file tree; a cold file read may fetch the archive once.
An archive deliberately favors simple bulk materialization over random remote file reads.
If cold single-file traffic proves material, add an indexed/range-readable format later.
Do not start with thousands of remote objects and database rows per package file.

### 2. Metadata schema and contracts

Extend the existing snapshot row with storage state/format and a receipt containing the
provider, server-owned archive/manifest keys, hashes, compressed/uncompressed sizes and
file count. Keep the existing snapshot ID and `(company_id, content_hash)` uniqueness.
Add company-scoped relational constraints where a new package reference is introduced.

During migration a snapshot is one of: legacy inline; inline plus verified external copy;
external only. An explicit discriminator distinguishes absent payload from an empty
package. Keep pending upload attempts separate from externally readable versions, using
small preparation receipts/leases in the owning snapshot storage metadata. A final version
may reference only a ready package.

Repository-backed version rows retain their snapshot and entrypoint references but stop
duplicating `candidate.files`. Preserve the directory-local view as a manifest projection.
Existing historical version inventories must be migrated from their actual stored bytes;
do not assume an older or checkpointed inventory exactly matches a current projection.
If it differs, store that inventory as its own immutable package.

Support ordinary local, directory-only and forked versions with the same package reference
in a second compatible writer path. Keep a bounded inline legacy reader until backfill
finishes. Small searchable skill Markdown/metadata can remain on `company_skills`; the
goal is to remove file-tree payloads, not prohibit useful database text.

Split internal `VersionMetadata` from content-bearing responses. Public
`CompanySkillVersion.fileInventory`, the version routes, Studio and export consumers
currently expect contents: preserve their response behavior through explicit hydration
from storage, or add an opt-in metadata view and move clients to it. Never return an empty
inventory to an old caller merely because the database payload was cleared. A storage
location or opaque digest is not an authorization capability and need not be exposed.

### 3. Publication without long database transactions

```text
authorize and scan immutable Git revision
  -> audit/filter the installed package
  -> obtain a bounded preparation claim for (company, content hash)
  -> write manifest + archive to unique attempt-owned storage keys
  -> verify stored lengths, hashes and manifest/file agreement
  -> short DB transaction: recheck source revision/lease/authority;
     publish ready receipt, versions, current pointers and activity together
  -> settle preparation receipt and release temporary files
```

Perform provider I/O outside the publication transaction. Refresh's current source and
lease fencing still decides whether the result may be published. A failed upload keeps
all installed versions. A failed or uncertain commit must be reconciled before cleanup;
never delete an object simply because the transaction call returned an error.

Use immutable unique attempt keys, with logical deduplication in PostgreSQL. This matters:
`createStorageService.putFile` currently deletes its upload key on failure. Reusing a
single deterministic key across writers could let a losing/failed writer delete a winner.
Do not use that API as a create-if-absent content-addressed store. A concurrent winner's
receipt is retained; the losing attempt's own keys become cleanup candidates only after
its outcome is known. Preserve pending receipts through restart and company deletion.

Amazon S3's [strong read-after-write consistency](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html)
helps verify a successful object write, but does not make an S3 write and SQL commit atomic.
Qualify other supported S3-compatible backends separately. Pass cancellation through the
storage facade; its current public read API omits the provider's AbortSignal capability,
and uploads need bounded cancellation/settlement too. Avoid abandoned streams after timeouts.

### 4. Shared verified cache before per-skill projection

Use a cache identity containing instance/storage namespace, company, format and package
content identity. Reauthorize the skill/version before every use. Deduplicating content
within a company must not expand a private project's audience; authorization stays on
the referencing skill/source, including forks and detached copies.

Acquire a package-scoped shared promise **before** opening legacy payloads or object
storage. One cold request fetches/verifies/extracts the package; concurrent consumers reuse
it. Different service instances in one process share this work. Use filesystem locking
and atomic publication for processes sharing a volume; replicas with separate disks may
each need one fetch. Keep cache ownership distinct from authorization and version pins.

Validate compressed size, expanded size, file count, normalized paths, duplicate/colliding
entries, per-file digest and executable mode. Reject links, devices and traversal; never
run repository code on extraction. An extracted directory or `.complete` marker alone
is not proof of byte integrity. Warm runtime validation compares actual disk files with
the hashed manifest, including unexpected files and modes, without rereading SQL payloads.
Audit continues to inspect actual content and may require new policy scans independently
of package immutability.

Keep the current self-contained `.paperclip-repository` skill layout initially. Build it
from the shared package cache and reuse the manifest in materialization and audit. Preserve
the existing company cache lock through final publication and durable run pinning. Stage
slow downloads before that lock, then recheck authority/version identity inside it; if
the caller already holds an outer preparation lock, change that owner deliberately rather
than weakening pin safety. Cache eviction must respect active handles during staging.

Bound cached disk bytes, active downloads, expanded temporary bytes and in-memory manifests;
do not introduce an unbounded process-wide map of decoded repository arrays. The existing
61 MiB package cap is not a bound on concurrent copies or historical cache growth.

### 5. Avoid content work when nothing can be installed

After listing the immutable tree, return a successful empty discovery when no valid
entrypoint path exists, before batching support blobs and constructing a repository package.
Persist the source's checked commit/tree and next check, not its contents. The initial
shallow Git fetch still transfers Git objects; do not claim zero acquisition cost.

At publication, require at least one selected, valid candidate needing a package. A scan
with only excluded/invalid skills can retain candidate metadata and warnings without a
durable payload. A scan in which upstream skills disappear retains previously installed
versions and their packages. A later commit can still discover and import a new skill.

Keep current unchanged-commit/tree checks and work-budget accounting. Changing the
five-minute refresh policy or adding provider events is independent work, not a prerequisite
for moving bytes out of PostgreSQL.

## Alternatives considered

| Alternative | Assessment |
| --- | --- |
| Store SHA; clone from upstream on use | Small database, but loses offline/deleted/revoked-upstream recovery and adds execution-time network work; does not reproduce filtered packages by itself |
| Durable bare Git mirror with retained refs | Useful for acquisition deduplication; requires durable backup, pruning/GC rules, isolation and a filtered-export contract; does not naturally cover edited/generated skills |
| Self-contained Git bundles in object storage | Viable for raw Git retention; Git distinguishes self-contained bundles from incremental bundles with prerequisites. More Git state than the installed-package contract needs |
| Compress JSONB or add a large RAM cache | Can reduce a symptom; keeps database payload storage and cold-read cost, and adds heap pressure |
| Always keep only a skill directory | Reintroduces known missing shared-file dependencies |
| Per-file content-addressed storage | Better cross-version dedup and single-file access; adds object count, manifest graph and garbage-collection complexity before that benefit is measured |
| Immutable package archive + manifest + disk cache | Recommended first implementation: existing providers, bounded bulk I/O, exact installed bytes, stable version references |

The [Git bundle documentation](https://git-scm.com/docs/git-bundle) describes prerequisite
verification. A bundle or mirror is a real retained copy; a remote SHA is only a reference.
A reusable Git acquisition cache remains worthwhile if profiling shows repeated shallow
fetches dominate, but it must preserve the scanner's credential and caller isolation.

## Automatic conversion, acquisition and retention

The accepted follow-up removes the manual migration requirement. New writes default
to external packages, and a finite delivery worker converts legacy rows, independently
verifies storage and then clears duplicate payloads. It uses indexed row deadlines,
transaction notifications and restart reconstruction, rather than per-turn work or
an empty-table polling interval. The CLI is optional diagnostics. See the current
[operational contract](../skill-package-storage.md) for upgrade/rollback details.

New Git imports persist a restore recipe alongside the package: repository identity,
source authorization reference, exact commit, precise included-file manifest and
packager version. Warm queries exclude this larger metadata. A cold miss first uses
local verified files, then stored bytes, then legacy DB bytes, then the original
Git commit using current source authorization. Every recovered file must match the
saved size/mode/hash; moving branches and current filtering rules cannot change it.
Historical packages without a provable recipe remain durable instead of inferring
an origin from mutable current skill metadata.

Unused Git archives become eligible after 30 days, keeping current versions, explicit
pins and active/recovering runs. Metadata and recipes survive expiry. Retired storage
keys have another 30-day deletion grace. Locally authored and edited packages remain
durable while referenced. Canonical extraction retains its bounded cold-fill eviction;
version directories use existing retention; native runtime assets now have a 30-day
idle lifetime, pin-aware cleanup and a shared publication/deletion lock. A pin can
conservatively defer cleanup until the next relevant mutation/use or restart.

Source and package writes remain company-scoped. Saved grants are rechecked on Git
acquisition, with a persisted five-minute failure backoff and existing singleflight.
No upstream network request, storage HEAD, cleanup scan, or TTL write is added to
warm package preparation. Native access timestamps are coalesced hourly on disk.

Lifecycle ownership remains in the package/native asset services. `index.ts` only
registers them with the existing coordinator. `migration_at`/`maintenance_at` and the
existing deletion receipts are durable truth; no additional worker queue table was
introduced. Conversion retains the original bytes and may wait for ingress without
blocking idle sleep. Optional retention may wait for the next ingress wake. This does not establish deployed sleep or a Cloud alarm contract.

## Delivery slices and proof

| Slice | Owning files/area | Exit condition |
| --- | --- | --- |
| A. Storage boundary and compatibility | New `skill-package-store.ts`; storage facade; DB/shared version descriptors; `company-skills.ts` readers | Real local and S3-compatible upload/restore round trips; old rows work; metadata reads contain no file bytes; no behavior change yet |
| B. Publisher and runtime | `skill-sources.ts`, scanner, version/fork/copy writers, package cache, cache retention | New package bytes never enter SQL; two or more selected skills share one cold package load; warm preparation does not reload it; zero-skill scan persists no package |
| C. Consumers and migration | Version routes/client contracts, Studio context, export/disconnect, bounded migration command | Old API content behavior preserved; historical pins and copies restore; full current/legacy consumer matrix passes; backfill can restart safely |
| D. Qualification and rollout | Existing skill suites and runner journey; operational docs/maps | Byte/performance evidence, fault injection, staged backfill, rollback boundary and cold recovery demonstrated |

Slices A–D form the complete database-storage change. Keep runtime transport deduplication
separate: add a shared package bundle plus entrypoint descriptors to the runtime context,
transfer each package once, and construct each discovery entrypoint in the destination.
Preserve the existing fallback for adapters that require independent directories. Do not
use host-only symlinks or shared writable hardlinks as a shortcut; qualify read-only mounts,
copy-on-write copies or destination-local materialization against each supported transport.
This later change reduces transfer/disk multiplication; it is not needed to remove DB bytes.

Use the existing `skill-sources`, `skill-version-cache`, `skill-version-retention`, project
skills and native runner suites. Add a representative large synthetic package and an
assembled PostgreSQL/storage benchmark, not mocks that eliminate serialization and I/O.

| Scenario | Required evidence |
| --- | --- |
| 1,349 files / approximately 22.6 MB JSON / 1, 2 and many entrypoints | Record exact fixture size, actual PostgreSQL DataRow bytes, object GET count/bytes, CPU, peak RSS, disk bytes and preparation duration; sizes need not reproduce private content |
| One cold preparation using several skills from one package | Zero repository file-content bytes in SQL; at most one payload download per package per shared cache scope; equal delivered bytes/modes |
| Warm preparation, audit and restart with intact disk cache | Zero repository payload bytes from SQL; zero payload GETs while cache is valid; actual integrity checks retained |
| File tree and one-file read | Tree reads manifest only; first file read may fetch one archive, repeated reads reuse it; unrelated package contents never pass through SQL |
| Unchanged refresh and no-skill repository | No new package/version payload; empty scan remains discoverable on a later commit; existing installed content survives removal/failure |
| Storage failure, corrupt archive/manifest/cache, cancellation | No partially published version; old installation remains; no silent SHA refetch; unrelated requests remain responsive |
| Concurrent import, uncertain commit, process crash, deletion | No winner object deleted; persisted attempt reconciliation; stable IDs and source lease/revision fencing |
| Private project, revoked access, detached/forked content | Fresh application authorization on cache hits; no company/project boundary widening |
| Pins, cold restore, Studio, forks, disconnect, export, retention | Equivalent supported files, binaries/modes and discovery policy; historical semantics preserved without upstream |
| Backfill interrupted at each boundary | Retry changes no version IDs or contents; no early payload clearing; dual-reader rollback works |

Report SQL byte reduction separately from object-store traffic and execution latency.
The target is **zero package file-content bytes in PostgreSQL responses for migrated
packages**, not zero database queries or zero network bytes. No percentage CPU/latency
saving is claimed until measured on the replacement.

Update `doc/PRODUCT.md`, `doc/SPEC-implementation.md`, `doc/SPEC.md`, `doc/DATABASE.md`,
`doc/DEVELOPING.md` and recoverable-cleanup documentation to replace the database-byte
restoration guarantee with durable-package restoration. Update affected skills/version
feature and access map entries, and run `node scripts/check-maps.mjs`. Generate schema
migrations with `pnpm db:generate` and follow migration snapshot rules. Run focused checks
first; before a PR-ready implementation handoff run `pnpm -r typecheck`, `pnpm test:run`
and `pnpm build`, plus the affected real runner journey. See the operational contract
and verification record below for the checks actually completed in this checkout.


## Implementation verification record

Implemented the storage migration, dual reader and guarded writer, bounded migration
CLI, deletion receipts, package/runtime caches, metadata batching and native asset
reuse. The approved follow-up adds default-on writes, automatic verified conversion,
immutable Git restore recipes, persisted acquisition backoff, automatic object cleanup
and native asset retention. The public API continues to hydrate explicit file-content responses. New source
packages are prepared before publication transactions; existing generic authoring
transactions keep their serialization boundary and use an independent upload connection.

- Full workspace typecheck passed; the server was rebuilt after the final refinements.
- Full repository build passed. Migration numbering/safety and map contract checks passed.
- Focused package, source, company-skill, retention/cache, concurrency, heartbeat preparation
  and native context suites passed. The final migration/retention rerun passed 36 tests;
  the final project-source/authoring-route rerun passed 92 tests.
- Real loopback S3-compatible multipart upload and historical restoration passed; its
  disposable server/data were removed after verification.
- The benchmark records 60 warm samples across 1, 2 and 10 selected entrypoints, plus
  cold and fresh-service cases. It includes actual PostgreSQL wire bytes and native
  asset creation. It does not prove deployed Railway latency or a live agent turn.
- The serial full-suite invocation was deliberately cancelled and replaced with the
  repository's supported CI groups/shards for the same inventory. The broad run
  recorded setup timeouts and assertions in the skill concurrency, native recovery,
  workspace and other suites. It was stopped to isolate those failures before the
  remaining chat, route and workspace groups completed. The skill concurrency case,
  two representative recovery cases and the workspace assertion all passed on isolated
  reruns. This is **not** a clean full-suite result or complete CI qualification.

Per-entrypoint runtime/transport deduplication remains the separately scoped follow-up
from this design. Writers and automatic conversion now default on; the explicit false
override remains available for a coordinated reader-first rolling upgrade.

### Automatic lifecycle follow-up

The user approved automatic conversion, acquisition on miss and cleanup. This is
implemented without a required data-migration command. Final proof: 30 focused tests
passed, followed by 15 package/worker cases including additional missing-object and
retention regressions; 73 source/native/retention integration cases passed. Idle-safety
coverage passed, workspace typecheck/build passed, and the final server rebuild passed.
The supported fresh-cluster test path bypassed shared-template startup failures.
Two actual regressions found during development—JSONB key reordering during recipe
verification and empty native-cache startup—were fixed and covered in the passing run.

Forty new warm benchmark samples (one and ten selected skills) plus cold/fresh-service
samples retain five ordinary SQL queries and zero object/body reads. Receipts and timing
limits are in the [operational guide](../skill-package-storage.md#automatic-lifecycle-follow-up-verification)
and the linked JSON. No production cleanup, deployment or data migration was performed.
The earlier broad full-suite limitation remains open.
