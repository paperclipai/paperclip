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
It also holds the existing per-run physical finalizer keys for each exact native
recovery proof. It re-inspects the complete source proof before capture and
publication. Changed descriptors, allocations, owners, aliases, or Git metadata
reject publication. Prepared sources and unresolved recovery warnings retain
their original state and evidence. They are not marked finalized or cleared.

Present nested workspaces must import before their parent. The existing owning
nested-import path downloads and restores each immutable child snapshot and
compares it with a fresh source capture before excluding that child. Missing or
changed coverage remains blocked. The archive retains its three source walks,
history normalization, Git/fsck checks, manifest ordering, and byte format. Its
self-contained remote function checks that every Git store belongs to the held
physical source roots. It preserves the original source files.

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
