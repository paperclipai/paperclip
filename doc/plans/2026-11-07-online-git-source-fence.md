# Online Git source preservation

The online importer must exclude every writer of a selected checkout, its Git
administration, and all common or borrowed object stores. A checkout's task key
alone does not cover a shared project base or a private cache owned by another
task. Unrelated remote work must continue.

The source owner reads bounded, stable Git pointer, `commondir`, and alternates
metadata. It maps each physical directory to the existing company/task source
key or managed-project source key. It derives a transitive company cohort from
those owners and declared project sources. It rejects foreign physical aliases,
unknown stores, bare repositories, symlink metadata, network alternates, and
uncertain or excessive metadata. It preserves every object store; HEAD alone is
not a source closure. The bounds are 1,000 company records, 256 cohort records,
128 source keys, 32 borrowed stores, and four alternate levels. Foreign minimal
paths use the existing bounded scan of 256 records per page, at most 40 pages.

Configured directory aliases resolve through the existing canonical path owner
before Git inspection. Git pointer files and administration/object-store links
retain their strict checks. A configured symlink does not make a direct symlink
migration source admissible.

The runtime retains the existing plain-task-directory treatment of an exact
regular `.git/info/exclude` fragment. It is not an operational Git repository.
Git pointers and object stores retain their topology checks, and migration
rejects the fragment instead of treating it as an ordinary snapshot. A blocked
reopen returns its existing structured failure without attempting reconstruction.
Arbitrary self-hosted Git paths and file URLs retain the genuine offline
maintenance path; online migration requires a proven physical source owner.

Physical exclusion enumerates both `cwd` and `providerRef` through one source
path owner. Company/foreign alias checks, early admission, layout checks and
filesystem mutation owners use that set. A managed or Git source in either
locator requires a proven scope before the legacy fallback. Capture and display
keep their existing preferred-path selection. Missing archived sources retain
their existing reconstruction path.

Preparation, lifecycle, runtime-service, expiration, and reopen owners retain
the same physical keys before filesystem mutation or lifecycle exclusion. The
importer holds all cohort task/project and lifecycle keys through publication.
Each cohort reserves its members in fully joined batches of at most eight
independent transactions. It joins every reservation before starting capture or
releasing the source fence, including on failure. Partial journals keep the full exact member
and operation set for resume; publication stays serial in one transaction.
It also holds the existing per-run physical finalizer keys for each exact native
recovery proof. It re-inspects the complete source proof before capture and
publication. Changed descriptors, allocations, owners, aliases, or Git metadata
reject publication. Prepared sources and unresolved recovery warnings retain
their original state and evidence. They are not marked finalized or cleared.

A terminal failed run can hold recovery for a separate durable remote workspace
on the same task. A strict remote-only proof lets the old local source import
without resolving that recovery. The proof binds the exact run, finalizer,
action, accepted result, task, remote authority, allocation and any committed
baseline snapshot. It uses the canonical remote source inspector, takes the
run's finalizer fence and is rechecked before publication. Mixed legacy/remote
references, active owners and changed bindings remain blocked. The remote
source never enters the legacy export list; its dirty state, files, result and
recovery obligation remain intact. Previous-release prepared references keep
their original epoch and prior snapshot identity; the baseline need not have
been created by the held run.

Present nested workspaces must import before their parent. The existing owning
nested-import path downloads and restores each immutable child snapshot and
compares it with a fresh source capture before excluding that child. Missing or
changed coverage remains blocked. The archive retains its three source walks,
history normalization, Git/fsck checks, manifest ordering, and byte format. Its
self-contained remote function checks that every Git store belongs to the held
physical source roots. It preserves the original source files.

Ordinary capture does not read an enclosing host repository outside its root.
Its canonical ordinary proof remains valid there. Any `.git` marker at the
selected root still requires Git admission. A completed nested operation stays
in the parent layout guard unless the derived child proof covers that exact
operation and physical path. Missing or revoked snapshot coverage cannot turn
the leftover child into an ordinary parent directory.

Receipt path scans retain canonical resolution for aliases. A lexical SQL prefix
could hide a child reached through a symlinked ancestor. The finite receipt bound
remains in force; query optimization must preserve that alias coverage.

Imported child paths come from the same exact completed migration/snapshot
selector used by nested source verification. Their physical Git owners remain
in the parent fence after their database rows become remote. The selector bounds
company migration receipts to 10,240 and binds each child path, operation,
snapshot, digest and Git metadata proof. Current remote child execution does not
reacquire authority over those historical host files.

A source metadata observation at `2026-11-06T23:15:08.979Z` examined 160 pending
Git records and 120 unique paths. It found 92 Git pointers, 49 Git directories,
19 absent archived roots, and nine common/object stores. No alternate or uncertain
metadata was observed. Project cohort sizes were 126, 27, 4, 1, 1, and 1; the
largest contained 110 distinct task owners. These observations bound useful
cohorts. They are not a coherent snapshot, acquired lock proof, or claim that all
160 are eligible. Missing archived sources keep their existing authenticated
reconstruction path. Remaining provider, recovery, preparation, runtime, and
source-change blockers remain authoritative.

Focused verification uses the real importer and local storage owner. It covers
prepared sibling recovery, unrelated running remote work, private cache ownership,
source changes during upload, leaf-first exact child coverage, and existing Git
expiration/reopen consumers. Archive tests exercise both local calls and the
serialized remote function, compare archive bytes and digests, remove every
original source, restore uncommitted/staged work, and run fsck. No hosted import,
hold, cancellation, provider call, or shared-cache Git command is part of these
local tests.

A cohort shares its initial nested-source verification only within its held
source and finalizer fences, keyed by physical root, Git roots and the exact
recorded child set (or discovery). After every capture joins, a separate fresh
verification checks each physical root and child set before publication. A
changed child still rejects the whole cohort. Singleton imports keep their
per-import checks. No local-byte proof survives the invocation.

The online migration owner can checkpoint completed immutable nested-snapshot
verification in the child snapshot ledger. This optional versioned proof binds
the complete encrypted reference, child lineage, source operation and a known
S3 endpoint/region/bucket/prefix/style namespace. A new process can reuse it only
after fresh strong-ETag/length, current ledger/source-fence checks and canonical
metadata-only unwrapping of each child key under the current master key. This
key check also runs for in-memory hits; it returns no secret or payload. The proof
is published only after canonical decryption, manifest/file restore and a stable
post-verification HEAD. Missing or unknown proof versions, implicit provider
endpoints and weak or changed validators require full verification. Existing
records need no migration. No plaintext scratch, parent journal CAS, authority,
retention deadline or local/Git source proof is reused. Every resumed invocation
reacquires the source locks and captures current local bytes again. Read-only
verifier callers do not opt into checkpoint publication.
A change that strengthens immutable archive verification must advance the proof
version so earlier verification cannot bypass the new checks.


A cohort with nine to 32 members is admitted only when every canonical resolved
physical root is exactly the same. Cohorts of at most eight members retain the
existing mixed-leaf rules. Source resolution, admission, reservation, recovery
checks, final readers, replay and cleanup remain bounded to eight peers per
stage. Capture concurrency remains at most eight, and all running peers join
before an error or cancellation can release the source fence.

With shared initial and final child verification, 30 fresh aliases need one
initial and one final child pass instead of four pairs. For N distinct covered
children this changes 8N child checks to 2N. Thirty parent captures, uploads and
restores remain required. This is a work-count reduction; hosted wall-clock
improvement is not yet measured. Saved six- and eight-member cohorts retain their
exact membership. The canonical maintenance request accepts the same bounded
32-member list; single-workspace and capture-worker limits stay unchanged.
The journal shape is unchanged; older tools that enforce the
eight-member bound refuse larger cohorts and must not regroup them.

After a successful online cohort capture, members without archived repository
intents release their parent archive, authenticated readback, fresh comparison
archive and restored tree before the worker starts another member. The scratch
root and nested-child verification areas remain until atomic publication, and
the final fresh child checks still run. Archived repository intents retain their
restored payload for the final publication proof. Select a larger cohort
only after checking the actual parent capture footprint, its verification and
restore scratch, and current free capacity on the target filesystem. The worker
limit does not bound retained nested-child scratch. Keep the existing resource guards.
