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
