# Remote workspaces with disposable webservers

Date: 2026-10-30
Status: Implemented and in review in [PR #18403](https://github.com/paperclipai/paperclip/pull/18403).
The feature remains off by default. No production deployment or volume removal
has been performed.

Execution record (2026-10-30): native remote preparation, encrypted saved versions,
portable restore, ordinary file access, Stop/failure recovery, guarded closure,
retention, and explicit migration are implemented. The branch includes current
master through `105a67b52c`. Required recursive typecheck and the full build pass.
Complete test coverage is running in supported parallel shards. The original
serial test invocation was deliberately interrupted after eleven minutes; its
log is retained. Its recorded general-server workload alone exceeds ninety serial
minutes, so an interrupted command is not recorded as a passing suite.

Focused evidence uses real Postgres through migration 0419 and real child-process
filesystem execution. Fourteen lifecycle tests cover cold restore without the original
allocation or Git origin, staged/unstaged/untracked Git work, separate tasks sharing
one writer, lost provisioning replies, storage failure, stale publication, and
current Git credential context. Nine transport regressions cover filesystem
confinement, receipt writes, lost preparation/restore replies, saved-checkout reuse
without a credential refresh, and trusted SSH rewrites. Archive (17), storage (7),
migration (7), and retention (10) cases pass. The runtime controls (148), workspace
service controls (85), lifecycle controls (6), file routes (21 plus 50 existing),
recovery cases (144), manual runtime command controls (20), and Files UI
component tests (33) pass. Map and token checks pass. An actual S3
prepare/save/restore case passes using only generated synthetic files.

A separate 128 MiB experiment captured, encrypted, loaded, and restored synthetic
data with a matching independent SHA256. All 122 concurrent loopback HTTP probes
succeeded, with a maximum measured latency of 11.2 ms. Peak process RSS was
456.7 MiB, up 167.6 MiB from its loaded baseline. This is a local object-backend
experiment under concurrent test load. It is not a production throughput or low
memory guarantee.

Live Daytona acceptance is **not verified**. The zero-retry campaign stopped at
image qualification before agent creation. Its saved eval credential also failed
an independent API read with HTTP 401. The attempt and provisional creation name
are retained privately; provider absence cannot be certified with an invalid key.
A current credential is required before retry. Active native controller continuity
also depends on [PR #18343](https://github.com/paperclipai/paperclip/pull/18343).
A separate ordinary saved-copy browser check passed against actual S3, with
the original source deleted: file listing, saved-copy time, text preview, exact
binary download hash, and reload all passed in the supported classic interface.
The streamlined desktop task shell also crashes for a control task with no
workspace. That counterfactual identifies an existing SidePanelTabs issue; the
passing file check uses the supported classic task interface.

Material failures remain in the evidence record. The first required typecheck
found a missing experimental flag in a UI fixture; the fixture was fixed and the
full command passed. Initial embedded-Postgres checks hit the host semaphore
limit; fresh task-owned Docker databases provide the DB evidence above. Existing
recovery tests exposed cross-test retained-candidate history; isolated comparisons
pass, and the full 144-case repeat passes with company-scoped fixture cleanup.
Parallel checks also exceeded the original disposable database limit of forty
connections. The task database now allows two hundred connections. The failed
run is retained separately; complete coverage is running again, and individual
remaining failures are compared in isolation rather than assumed unrelated.

The first automated review scored 3/5 and identified four valid gaps. Fixes now
retain later managed-repository commits, reject unsupported manual commands before
local filesystem access, remove completed remote export staging with durable
cleanup retry records, and preserve safe portable Git remotes, tracking, and commit identity.
Their regression tests pass. The second review found a cleanup reply that could
hide a completed restore. Restore location and cleanup receipts now publish
together before cleanup runs. A further real regression showed stale same-run
preparation could replace dirty file authority with a second allocation. The
locked publication now verifies the exact dirty location and current lease.
Both regressions failed before their fixes and pass afterward. A fresh review
is required for these changes.

V1 admission rejects read-only cross-project referenced folders because the
qualified native sandbox cannot enforce their write boundary. It also rejects
custom remote close cleanup/teardown commands until a qualified remote maintenance
path exists. Manual workspace jobs, services, repairs, and runtime commands also
fail before local filesystem access; commands can run through an agent task. Same-project mutable managed repositories are supported. Confirmed
saved files do not certify unknown external actions or permit their replay.

This replaces the earlier workspace plan that retained a webserver checkout as
the main working copy. It implements the workspace portion of the broader
zero-downtime deployment effort.

## 1. Outcome and architectural decisions

An agent works in a remote sandbox. Replacing the webserver must not move,
restore, overwrite, or delete that working folder. The replacement webserver
reads durable records and connects to the same sandbox. After the work is saved,
another sandbox can recover it from object storage.

The first release covers native Paperclip Runner execution in managed Daytona
sandboxes, including plain task folders, Git workspaces, and managed repository
checkouts. Implement the storage contract through provider-neutral environment
interfaces. Qualify Daytona live; do not claim support for untested providers.

| Component | Responsibility |
| --- | --- |
| Remote sandbox | Own the current working files and run file/Git operations. |
| Object storage | Hold immutable, verified saved versions of those files. |
| Postgres | Hold workspace identity, access context, location, writer ownership, saved-version references, and unfinished operations. |
| Webserver | Authorize and coordinate operations; stream bytes; use disposable scratch space and caches. |
| Git provider | Supply new repositories and receive explicit pushes. It is not the backup for uncommitted or unpushed work. |

The working folder belongs to a logical workspace, not to a webserver process.
The sandbox allocation can change after a saved version exists. Retaining a
workspace does not require paying for a running sandbox indefinitely.

Firm defaults:

- No workspace snapshot or file copy is required merely because the webserver deploys.
- One active writer owns a logical workspace. Different workspaces can execute in parallel.
- Saved versions must restore without the old webserver, old sandbox, or original Git remote.
- The existing local workspace path remains supported for local development and self-hosting.
- Temporary webserver files are permitted. No acknowledged work or unresolved obligation may have its only durable copy there.
- Agent instructions, personal memory, provider credentials, controller checkpoints, run logs, and accounting journals retain their separate owners. Do not fold their migrations into this feature.

This release does not remove the Railway web volume or implement HTTP readiness,
traffic draining, cross-server events, or general scheduler ownership. It also
does not promise to preserve edits made after the last saved version when both
the webserver and sandbox are lost. The earlier hot-upgrade work remains the
dependency for preserving an active provider execution.

## 2. What is saved, and when

### Saved contents

Save ordinary workspace files, binary files, empty files and directories,
deletions, file modes, and supported symlinks. Save Git state needed to reproduce
the checkout: branch and commit identity, staged and unstaged changes, untracked
work, and required local history. Include each managed checkout separately and
preserve its relative location within the workspace.

Normalize Git worktrees into a portable representation. A saved version must not
contain a dependency on a `.git` pointer, object alternate, or common directory
on the old machine. Preserve the Git history available in the workspace;
shallow repositories need not acquire history they never had. Referenced Git
objects and any required base must already exist in object storage.

Do not save runtime-injected credentials, controller transport state, or known
rebuildable dependency/build caches. Use an explicit, versioned exclusion policy
derived from the existing synchronization rules. Do not drop tracked files or
ordinary user data merely because a filename resembles a cache. Report
unsupported filesystem entries or unsupported repository layouts before treating
the workspace as durably saved. Never silently truncate a snapshot.

### Save boundaries

1. **Initial preparation:** record the resolved source, pinned commit, and ready
   location before execution. An empty task folder has a durable empty baseline.
   An imported folder or initialized repository obtains its initial saved version
   before the run is admitted.
2. **Completed native run:** capture and publish a saved version before workspace
   finalization succeeds and before the next writer starts. An accepted model
   result can remain pending while its files are being saved.
3. **Stop or failure:** once the existing runtime contract proves mutation has
   stopped, preserve the available work before destructive cleanup. A failed save
   retains the source and the existing recovery obligation.
4. **Release, replacement, or removal of the allocation:** require a saved version
   that covers the latest supported mutation boundary. Stopping a sandbox while
   retaining its disk remains distinct from destroying it.
5. **Completed workspace commands:** commands that can change files participate
   in writer ownership and mark the workspace as requiring a save. File reads
   do not create save obligations.

There is no periodic full-workspace backup in v1. No-op saves can reuse a verified
unchanged saved version. Changes to repository inventory use the same save and
ownership path as other workspace mutations.

Capture requires a stable boundary. Hold new writers while the runtime completes
its existing mutation barrier. The remote capture helper verifies that included
files and Git state did not change during capture. If an unsupervised process
continues changing included files, retain the sandbox and leave saving pending;
do not certify an inconsistent copy. Reading files remains possible.

## 3. Data contracts and owning modules

### Durable records

Extend execution-workspace records with an explicit authority discriminator,
current saved-version reference, and writer/location epoch. Keep local and remote
locations distinct in shared types. A remote path must never reach a host `fs`
call merely because both are strings.

Add a company-scoped workspace-snapshot ledger. Each record has a workspace ID,
snapshot ID, parent snapshot, source operation/run, format version, manifest and
payload references, hashes and sizes, encryption material reference, and lifecycle
state. The database decides which snapshot is committed. Object existence alone
does not establish that a save succeeded.

Use the existing workspace-operation journal for capture, restore, and disposal
attempts. Persist the operation ID and expected writer/location epoch before
external work. Record the remote staged-copy identity and upload progress needed
to reconcile a lost reply. Keep large manifests and file contents out of run-profile
JSON and database rows.

### Narrow execution interfaces

Add a versioned remote-workspace realization contract. Its input selects an empty
folder, an authorized repository at a pinned commit, or a committed saved version.
Its result contains a verified remote location and repository inventory. It does
not require a controller-local source path.

Expose a small workspace access service to consumers:

- Prepare or reconnect to a workspace location.
- Inspect Git state; list and read confined workspace files.
- Capture a stable saved version and report its operation identity.
- Restore a saved version into a new, empty location.
- Dispose of a location after its durable obligations settle.

Core owns authorization, company isolation, task binding, publication, and
retention. The environment runtime owns allocation and transport. Remote helpers
own filesystem and Git mechanics. The storage service owns encrypted object I/O.
Heartbeat coordinates these owners; it must not acquire their implementation logic.

Use the existing environment execute and transfer interfaces for Daytona. Extend
their capability negotiation for the new remote workspace contract. Do not force
plain task folders into the current project-specific workspace-plugin schema.
Existing dedicated workspace plugins retain their protocol; capability support
must be explicit before they can opt into the new saved-version guarantee.

Relevant existing owners include:

- `server/src/services/heartbeat/workspace-preparation.ts` and
  `server/src/services/environment-run-orchestrator.ts`: admission and realization.
- `server/src/services/native-runtime/native-workspace-sync.ts` and the native
  finalizer: the copy-back path that the new mode bypasses.
- `server/src/services/workspace-file-resources.ts`: authorized browsing and reads.
- `server/src/services/workspace-recovery-snapshot.ts`, `git-restore-point-storage.ts`,
  and `packages/adapter-utils/src/`: reusable archive, integrity, encryption,
  and remote transfer machinery.

The existing expiration restore-point ledger is not the authority for live saved
versions. Reuse suitable codecs and validation without importing expiration-only
limits, upstream dependencies, or cleanup behavior.

## 4. Execution lifecycle

### Prepare and run

Reserve the logical workspace in Postgres and acquire its current writer epoch.
Resolve source authorization and Git credentials through existing controls. For
a new repository, clone and prepare it inside the sandbox. Run provisioning
commands there. Restore an existing saved version there when the prior allocation
has been deliberately released or is confirmed lost.

Prepare additional referenced projects through the same remote mechanism. Keep
their existing read-only access and per-project authorization. A user-selected
local path is not silently converted into a remote repository; migration must
first create and verify an import or keep that workspace on the local path.

Reconnect to a verified retained location when it exists. Do not seed it again
from the last snapshot. Pass the remote working directory to the Runner through
the new realization contract. The new path bypasses host checkout creation,
host provisioning, copy-in from a canonical webserver folder, and copy-back merge.

Instruction and credential staging still uses its existing contracts. Those
inputs are separate from the workspace contents and are never included in a
workspace snapshot merely because they were staged nearby.

### Save

1. Persist a save operation with the exact workspace, run, parent snapshot, and epoch.
2. Create an immutable staged export inside the bound sandbox at a stable boundary.
3. Transfer its manifest, file archive, and portable Git payloads to object storage.
4. Independently verify object hashes, sizes, and manifest bindings.
5. In one database transaction, recheck authority, advance the saved-version
   pointer, and commit the save receipt used by native finalization.
6. Release staging data and continue normal completion or cleanup.

For v1, use the existing transfer path and bounded webserver scratch storage as a
relay. The immutable remote export and database operation survive loss of that
scratch space. Direct sandbox-to-bucket transfers and a new content-deduplication
system are not prerequisites. Reuse unchanged complete payloads where already
verified; measure changed-snapshot cost before adding more storage machinery.

Use streaming transfer and encryption. Do not buffer the complete workspace in
Node memory. Keep bucket credentials on the existing storage-service side.

If upload succeeds but the database reply is lost, retry the same operation and
inspect its durable state. Do not blindly repeat publication. A stale owner can
leave an unreferenced upload but cannot replace the committed snapshot or dispose
of the source allocation.

### Webserver replacement and recovery

An ordinary deploy performs controller handoff only. It does not checkpoint,
copy, or move the workspace. Server B loads the current location and reconnects
under the existing controller-ownership rules.

If A disappeared while saving, B resumes the recorded save operation using the
immutable remote export, or recaptures under a fresh valid claim if capture had
not completed. It never asks the model to repeat completed work to reproduce files.

If the remote allocation is temporarily unreachable, keep its identity and
recovery obligation. A timeout is not proof that the sandbox was destroyed. If
loss is confirmed, restore the latest committed snapshot into a new allocation.
For a run with unsaved work, surface the existing recovery path and state that
post-snapshot edits may be unavailable; never silently resume from stale files.

Keep controller generation checks, Stop semantics, current authorization,
budget gates, and physical-owner evidence. Removing host copy-back removes that
specific local-writer dependency; it does not justify bypassing remote-writer
ownership or adopting an unknown process.

## 5. Browsing, Git operations, concurrency, and cleanup

### User and agent access

Route file listing, previews, downloads, changed-file inspection, repository
preparation, and workspace commands through the workspace access service. The
general file browser currently rejects remote workspaces; fixing that is required
for feature parity, not optional polish.

For a live allocation, read the actual remote files with existing path confinement,
size limits, and access checks. For a released allocation, read the latest committed
snapshot. Add response metadata identifying live versus saved content and the
saved timestamp. Keep expired or unavailable live content distinct from the last
saved version; do not silently present saved bytes as current.

Saved-file reads can use disposable read-only extraction caches keyed by company,
workspace, and snapshot identity. Cache loss must only affect latency. File browsing
must not start an agent turn or allocate a new execution sandbox. Large downloads
stream without loading a whole archive into memory.

Keep file links based on workspace ID and relative path. Never expose machine
paths, bucket credentials, or provider allocation IDs as public access authority.
Artifact publication retains its separate upload contract.

### Writer ownership

Reuse existing database lifecycle locks and admission checks. The durable epoch
fences preparation, mutation, snapshot publication, restore, and disposal. Recheck
the epoch after provider I/O. Do not hold ordinary row locks across transfers.

Separate tasks can use isolated workspaces concurrently. Shared workspaces are
eligible only where the effective policy serializes writers. Explicit concurrent
shared-writer configurations remain on the existing implementation and block
migration to this mode. Do not silently change their requested behavior.

Remote commands need operation receipts when a lost reply could repeat a mutation.
Read-only inspection may retry. Uncertain arbitrary commands use the existing
uncertainty/recovery behavior instead of being automatically replayed.

### Retention and cleanup

Pin the current saved version, versions used by active restores, and objects
required by unfinished operations or recovery holds. The latest saved version
remains available for the workspace lifetime under the existing workspace retention
and deletion policy. This is not an indefinite version-history product.

Reclaim superseded unreferenced versions after a seven-day grace period, matching
the existing native recovery-material default. Database deletion intents and
reference rechecks prevent a cleanup race from removing newly referenced content.
Track abandoned uploads and multipart cleanup as concrete obligations. Never use
a bucket listing or file age as the authority for deletion.

Use the shared delivery-work coordinator, transaction-aware producer notifications,
startup reconstruction, and actual retry/expiry deadlines. Settled work must become
idle; add no permanent scan or keepalive for this feature.

## 6. Compatibility and migration

Add an opt-in remote workspace capability through the existing managed-instance
feature configuration. Persist the authority mode per workspace. The flag controls
eligibility for new enrollment; disabling it does not turn remote workspaces back
into local directories.

Require external Postgres, remote object storage, stable encryption keys, and a
qualified remote environment before enrollment. Keep legacy adapters and local
workspaces on their existing path. Prevent a legacy or unsupported execution path
from writing an enrolled workspace.

Migration is a resumable administrative operation with inventory, dry-run, import,
verification, and activation stages:

1. Deploy compatibility readers while current workspaces remain local.
2. Inventory eligible folders, repository state, active runs, unresolved copy-back,
   local-path sources, shared-writer settings, and provider capabilities.
3. In the allowed maintenance window, stop new writers and settle or explicitly
   retain existing work. Do not switch a running task's workspace authority.
4. Capture the final local state once and upload it as the initial saved version.
5. Restore into a disposable remote location. Compare file hashes, Git state,
   repository inventory, and source/access bindings without using the old folder.
6. Atomically switch that workspace's authority and reopen admission. Preserve
   the local source as migration evidence, never as an automatic fallback.

If local and retained remote contents disagree, use the existing recovery/merge
path before activation; do not pick a winner by timestamp. Missing state or an
unsupported layout blocks that workspace's migration with a specific reason.

Set the oldest rollback version to the compatibility release. After authority
switch, rollback must still read the same remote location and saved versions.
An older local-only binary is not a supported rollback. Keep additive schemas and
versioned contracts compatible across the supported rolling-upgrade pair.

Keep the production web volume attached throughout this slice. Other state still
depends on it. Workspace qualification must not be presented as proof that those
other dependencies have been removed.

## 7. Delivery slices and acceptance evidence

| Slice | Useful result | Required evidence |
| --- | --- | --- |
| 1. Remote ownership and access | An opt-in native task prepares and uses its workspace entirely in the sandbox; browser reads use the remote location. Destructive disposal stays blocked until slice 2. | Empty webserver workspace root; no host checkout/copy-back; file and Git access work; local mode unchanged. |
| 2. Durable save and restore | A completed run publishes a saved version, and a new allocation restores it. | Real database/object-store tests, Git origin unavailable, crash injection around upload/publication, independent file verification. |
| 3. Lifecycle and migration | Stop, failures, retained workspaces, cleanup, and existing data use the same authority and save contract. | Restart, stale-owner, deletion-race, interrupted-migration, and compatible-rollback tests. |
| 4. Live qualification | Actual Daytona work survives webserver replacement and its saved result is reusable. | Exact revision and provider identities, useful task result, file hashes, saved-version receipts, browser walkthrough, and subsequent task. |

Keep the feature opt-in until all four slices pass. Each slice includes its own
tests and documentation; intermediate code must not claim a durability guarantee
or enable disposal that it cannot yet satisfy.

### First experiment

Use real Postgres, an S3-compatible object store, and a sandbox-like separate
process/filesystem to exercise one ordinary native task. Give it an empty folder
and then a small repository case. Make the webserver's workspace root unavailable.
Prepare remotely, create a file, save it, restart with empty scratch space, and
read the file through the ordinary API. Then restore into a second allocation
with the original allocation and Git origin unavailable.

Measure time to the first useful result, save time, restore time, bytes transferred,
and peak webserver memory. Use this loop while changing interfaces. Add real Daytona
only after the local contract works; local success does not qualify provider behavior.

### Acceptance matrix

| Case | Pass condition |
| --- | --- |
| Empty and populated task folders | Files, empty entries, modes, symlinks, and binary content survive save/restore. |
| Git work | Unpushed commits, staged/unstaged edits, untracked work, shallow metadata, and managed checkout locations restore correctly. |
| Missing upstream | Restore succeeds with the old disk, old sandbox, and Git origin unavailable. |
| Active webserver replacement | Same run/session/sandbox continues; no new model turn or workspace reseed occurs. |
| Replacement during save | The saved operation completes once; no accepted file save disappears. |
| Storage outage/corruption | Saving does not falsely succeed; source retention and recovery remain visible. |
| Competing controllers | Stale publication, restore, command replay, and disposal cannot win after ownership changes. |
| User access | Live and saved file browsing, preview, download, changed-file inspection, and artifact handoff work through ordinary authorization. |
| Subsequent work | Another native task uses the saved result without a webserver checkout. |
| Stop/failure | Partial work is preserved when available; no premature sandbox destruction or replay of uncertain external actions. |
| Existing data | Migration preserves files and Git state; interrupted migration resumes; rollback reads post-activation saves. |
| Security | Cross-company access, path escapes, archive attacks, credential export, and stale authorization are rejected. |
| Idle and performance | Settled operations add no recurring SQL/network work; large transfers remain bounded and unrelated HTTP requests stay responsive. |

Run targeted tests first, then the repository's required typecheck, test, build,
migration checks, and affected map checks. Exercise a real browser for file-access
changes. Update workspace/recovery documentation, shared contracts, feature and
agent-access maps, and any affected Storybook states.

Live qualification uses the actual supported native Runner and Daytona path.
Replace the controller during active work, during saving, and after saving.
Independently inspect run/session identity, remote files, committed objects, and
the next task's result. Record application and Runner revisions, environment,
timestamps, hashes, operation receipts, and failure evidence.

Other server state remains available through its existing mechanisms during this
test. Prove workspace independence by making every old workspace directory and
cache unavailable. Do not describe this narrower proof as a successful completely
volume-free webserver deployment.

The delivery endpoint is reviewed implementation with required checks and live
Daytona workspace proof. Production volume removal remains in the broader
zero-downtime deployment plan.
