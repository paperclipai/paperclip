# Preserve existing workspaces during ephemeral enrollment

The deployment endpoint remains a volume-free Cloud tenant, followed by a real
rolling deployment while an agent works and new work is admitted. Enrollment must
preserve existing task files and historical recovery sources. It must not reset
task workspaces, manufacture successful copyback, or weaken migration guards.

## Evidence and remaining work

| Required outcome | Current evidence | Remaining gap | Owner / next action |
| --- | --- | --- | --- |
| Existing active task retains files | The current import encrypts, uploads, independently restores, compares the source again and publishes under the lifecycle lock. A live completed task imported successfully with its original directory retained. | The importer only accepts an active workspace with the current task binding. | Workspace migration owner: support historical records without changing the task binding or lifecycle state. |
| Archived task retains its saved files | Retention records include encrypted task-directory restore points, Git restore points and verified Git reconstruction recipes. | The importer rejects missing local folders even when an existing restore point can reconstruct them. | Restore-point owners: reconstruct into migration scratch space, reject expired/missing/corrupt sources, and feed the verified result into the normal import publication. |
| Shared project roots preserve all task files | Legacy roots contain nested task worktrees and multiple records can reference one physical folder. | A naive root capture recursively imports those other workspaces; the current per-record writer check does not fence aliases. | Workspace migration owner: inventory physical overlaps, fence all writers, and preserve nested workspace coverage before excluding any directory. |
| Failed runs retain unsaved files | Provider inspection distinguishes surviving archived sandboxes from missing allocations. Existing recovery validation accepts some sources and rejects others for missing provenance or ambiguous allocation ownership. | Recovery must settle or durably preserve each exact source. A successful old preservation action does not necessarily update the legacy sync descriptor. | Workspace recovery owner: verify existing preservation receipts, recover eligible sources, and retain explicit unresolved obligations for unavailable/ambiguous sources. Do not replay agent work. |
| Tenant is eligible without its volume | External DB and S3 are configured; the original volume remains attached. | Workspaces, local run logs and remaining owner-maintained data must pass the packaged maintenance receipt. | Cloud enrollment owner, after workspace migration is complete. |
| Ordinary upgrades remain available | The no-drain Cloud deployment path is merged and qualified on another enrolled tenant. | Exact final app image qualification and a live deployment on this tenant. | Cloud deployment owner: qualify, enroll, then prove reads, submissions and active-run adoption through an actual replacement. |

## Acceptance boundaries

The first implementation slice supports archived and historical records,
encrypted task-directory restoration, Git restoration recipes, and legacy
branch-deletion receipts. PostgreSQL and real-file tests prove cold restoration
of saved bytes, index state, and unpushed commits, including after pruning the
old Git object store. Invalid or unavailable retained data still blocks import.

Administrative migration can recover a missing empty task-directory payload only
when storage confirms that its object is absent. The existing encrypted key
envelope must authenticate the exact empty payload hash and length, company,
workspace, restore-point ID, and generation. Metadata counters alone never
establish emptiness. This path leaves the original reference and missing object
unchanged and publishes the recovered bytes through the normal verified remote
snapshot owner. Ordinary restoration remains unchanged. Expired checkpoints,
nonempty or forged payloads, unreadable objects, and unknown object absence still
block migration.

An archived isolated checkout can be gone while its recorded deleted commit
survives in the company/project Git cache. After validating the exact successful
branch-deletion receipt, the importer can read immutable objects from that
namespace- and origin-checked cache. It reconstructs only the recorded commit,
never today's working tree. Ordinary private-checkout and restore-point
validation stays strict. Missing/revoked receipts, foreign caches and changed
origins still block publication.
Archived reconstruction of a saved nested linked checkout uses a private
standalone repository at the new path. It reads only the saved commit and
bundle prerequisites from the verified shared cache, and imports authenticated
restore-point history into private refs. Other tasks' branch refs and unrelated
objects do not enter the archive. Missing prerequisites use the approved remote
or block restoration. Root and nested private copies retain all saved extra
commits after portable capture and garbage collection. Ordinary linked recovery
keeps its path-owned branch check and its existing worktree history owner.
Verified local ignore rules preserve the saved classification of recovery files;
unsafe or changed exclude files block import without changing the source cache.

The next slice adds leaf-first offline migration of overlapping folders, verified
nested snapshot dependencies, interruption recovery, and dependency retention.
Recovery-obligation reconciliation remains a separate gap; these slices do not
yet make the whole tenant eligible for enrollment.

- Import existing files or a verified retained source. A missing folder alone is
  not permission to publish an empty workspace or choose a newer Git branch.
- Preserve archived status, task bindings, task history, unpushed Git history,
  staged and unstaged edits, and saved recovery copies.
- Preserve original files and the detached original volume until verified
  migration receipts and the retention interval permit removal.
- Parent roots may omit a nested workspace only with durable, inspectable
  coverage of that exact nested directory. Arbitrary exclusion globs are not an
  acceptable data migration.
- Resume interrupted imports with their original identity; cancellation may
  release an empty reservation only after the producer is stopped and no upload
  was journaled. Preserve an audit receipt.
- Verify restored file bytes independently, including after making the old
  source unavailable in an isolated test. Exercise current and historical
  bindings, archived sources, overlap/writer races, and unavailable sources.
- Unrelated tenants, production services, and agent task execution remain outside
  the migration's mutation scope.

## Legacy recovery storage transition

### Failed controllers with an older warm supervisor

An old failed follow-up can retain a database snapshot while its warm supervisor
still contains the preceding successful turn. Migration preserves the failed
run's database state and archives its available controller and supervisor files.
The archive requires the exact older snapshot to match a completed successful
run in the same company, agent, task, native session, and Runner instance. Its
provider thread must also match the failed source. Existing durable controller
checkpoints, active owners, changed snapshots, and foreign bindings still block
this archive path. The archive remains readable after removing the old home.
Execution recovery continues to require independently valid authority.

The migration owner must distinguish file location from recovery completion.
An offline import can preserve a terminal failed run's local workspace without
claiming that its remote files were recovered. The snapshot and migration
receipt bind the original run and sync descriptor; the failed run, provider
allocation, recovery action, and unresolved state stay recorded.

After publication, the native sync owner must reject copyback to the old local
folder. Explicit recovery still validates the exact provider allocation and
stop evidence, then preserves remote files as an immutable recovery attachment
instead of merging into retired local authority. New remote allocations attach
those verified recovery copies through the existing attachment owner. Missing
or ambiguous remote sources remain unresolved; migration never authorizes
replaying the old agent turn or destroying its allocation.

Publication requires the offline deployment fence, terminal unowned runs,
unchanged descriptors and task bindings, verified local snapshot bytes, and a
single transaction publishing the migration receipt and remote authority.
Failed runs with result-less `observed` or `retryable_failure` coordinators can
also be preserved after their leases expire and the offline deployment fence is
in force. Their coordinator phase, checkpoint, and unresolved copyback remain
intact. Publication journals the original coordinator binding, releases only
that exact expired lease with a recovery-history receipt, and installs a run-scoped
admission fence: a replacement cannot automatically replay that old turn against
the removed local authority. Explicit file recovery and a new task continuation
use the retained sources and remote workspace. This is not successful recovery,
provider termination evidence, or permission to delete the original allocation.
After independently verified sandbox preservation, the task accepts the exact
migrated snapshot receipt for continuation without requiring a fresh workspace.
For older runs without a synchronization descriptor, the migration journals
all declared recovery lease/allocation/directory identities under row locks.
Continuation requires the unchanged complete set and a verified snapshot for
every source. Missing or ambiguous source identity remains held; a partial
archive cannot certify recovery. The recovery journey covers two allocations,
removal of the old filesystem, and the files appearing in the next remote turn.
Accepted results with unfinished copyback remain blockers. Once the original
sync reference is finalized and its successful `workspace_finalize` operation
receipt exists, assessment and status effects can continue from their
existing database coordinator independently of the file storage migration.

Offline maintenance stops writers; it does not silently change workspace
semantics or retire task ownership. `parallel_shared_writers_unsupported` needs
an operator-approved transition to serialized remote workspace writes.
`task_writer_bound` needs the task lifecycle owner to settle its exact checkout
and execution binding, even if the run row is terminal. `task_binding_required`
needs provenance recovery or a separately approved durable archival path for an
orphaned workspace; the importer never invents a task owner. These records stay
on the original volume and block detach. The batch reports its first failed
workspace through the phase/error receipt; it does not claim to aggregate every
possible blocker in advance or skip blocked rows.

Controller leases, in-flight recovery, active writers, and uncertain workspace
operations remain blockers. Tests must prove migration leaves failure state
intact, rejects stale copyback even if the old folder exists, and preserves
recovery source validation and company boundaries.

## Queued turns during offline enrollment

The task drain stops new executions. It does not consume queued turns. After
Cloud has stopped every application deployment, offline maintenance preserves
never-started queued run and wake rows unchanged. Workspace, instruction-file,
and historical-log migration use the same execution predicate at this boundary.
The replacement uses normal queue admission against the migrated authority.

Running executions still block migration. A queued row also blocks if it has
started, retains process/session/controller evidence, or has a coordinator or
environment lease. Task checkout and execution bindings remain separate blockers.
Live migration retains its original queued-run exclusion. The offline flag alone
is not evidence that old deployments have stopped; Cloud owns that provider fence.

PostgreSQL/S3 tests cover queued turns and wake payloads surviving migration and
loss of the predecessor filesystem, plus queued execution evidence that must
remain blocked. The packaged maintenance entry must also retain an unstarted
queued turn while it archives historical run output. The assembled heartbeat
test resumes that same queued run after deleting the old disk, verifies saved
workspace bytes and instructions at provider dispatch, and checks one result and
one wake consumption even after a second queue sweep. Its sandbox transport and
provider session are scripted; database, S3, admission and restoration are real.

A failed follow-up can also have no warm supervisor and retain the preceding
successful run in its controller file. Archive this source only after the Runner
parser validates that older authority and scoped history confirms the same
Runner, session, provider thread and an earlier successful finish. Keep current
snapshots, ownership and typed checkpoints unchanged. The archive cannot become
executable recovery authority. Foreign, invalid and active sources remain blocked.

For a finished failed source with a stale observed coordinator, evidence archival
also requires an expired controller lease, no accepted result or retry deadline,
and no current task ownership. Every remote lease must carry the exact host-owned
termination receipt, confirmed after execution started. Recheck those receipts
before publication. Preserve the coordinator as recorded; this proof permits
evidence storage, not execution or a claim that the coordinator has settled.

Compare retained turn completion to the follow-up execution start, not its queue
creation time. A queued follow-up can predate the prior turn completion. A remote
stop can also predate a later logical failure caused by recovery timeout. These
proofs use the recorded execution start and never rewrite lifecycle timestamps.

A missing managed task checkout can still have its runtime-owned branch in the
verified company and project Git cache. Preserve that exact commit when the
recorded private path matches, no other workspace owns the branch, and Git has
no surviving worktree registration or index for it. Pin and recheck the commit
before publication. This saves the surviving committed tree; it does not
certify recovery of files that were already absent. An active record requires
the existing offline provider fence and keeps its original status. Invalid
restore recipes, live registrations and competing branch owners stay blocked.

For a user-owned retained branch, require its exact successful unforced worktree
removal receipt after archival. Forced removal or a revoked receipt does not
grant this authority. Preserve the branch and its ownership metadata unchanged.
For a deleted private branch, prefer its verified recorded private object source
while it still exists. A missing project cache or a later project-source change
must not hide that original retained commit.

### Existing typed checkpoint authority

When a retained source already has a valid typed database checkpoint, derive its
small recovery metadata from that authority and the current admitted input. Do
not consult a stale or absent local warm supervisor. Validate the same company,
agent, task, normalized session and Runner bindings and retain the checkpoint,
snapshot, owner and session pointer unchanged. Offline warm import without a
supervisor still requires this existing typed authority; normal runtime import
keeps its supervisor and ownership requirements.

For a retired reusable sandbox lease, the existing remote-termination resolver
may prove destruction through its exact successor handoff chain. A stopped
successor, broken chain or competing tip does not grant archival authority.

### Bounded offline harness transfers

The full bundled cold rehearsal reached only 699 of 1,953 local harness backups
before the 25-minute maintenance deadline. Keep every source and its existing
ownership and hash checks. Migrate up to four sources together. Reserve space for
both each tar archive and its encrypted copy before starting a group, with the
same total scratch limit as one maximum-size serial transfer. Use the verified
manifest sizes for a closed directory set; give sources with extra files an
exclusive maximum-size reservation so those files are preserved. Enforce the
reservation while streaming the archive. Ordinary runtime backups keep their
existing maximum archive limit.

Derive tar overhead from the maximum entry count and both maximum path lengths.
PAX can encode a path and symlink target for every entry. The difference between
the global object and content limits is not a safe per-source overhead estimate.
Check the bound against real maximum-path PAX encoding at the full entry budget,
and check streaming at an exact byte limit and one byte beyond it.

On failure, cancel and await every transfer in the group before returning. A
completed publication remains valid for the next attempt. Tests must exercise
real PostgreSQL publication and byte restoration, the four-transfer bound,
failure while another storage call is unresolved, retry, extra-file preservation,
and rejection at the archive limit before any object or row is published. This
finite offline operation adds no idle background work. A resumed rehearsal can
measure the fix but cannot replace fresh full-image migration and empty-home
recovery proof.

During offline migration, known task-only assignment, configuration, deliberate-wait and
disposition warnings can remain unchanged while the owner saves local files.
They do not certify file recovery and are not resolved by migration. An active
system recovery, native execution failure marker, declared workspace recovery
source, export-failure cause or unknown recovery kind retains the existing
blocker unless the importer already records that exact legacy recovery source.
Live migration keeps its recovery exclusion. Recheck recovery evidence before
publishing the saved workspace.

### Online preparation for large provider histories

Parallel offline transfer alone did not fit the copied staging dataset in the
maintenance window. A resumed attempt reached 1,389 of 1,953 sources. Keep the
offline deadline and move successful released history before draining the server.
The inventory contains 1,802 such backups, approximately 48.5 GB of the 54.8 GB
declared source bytes. This is preparatory publication under recorded runtime
authority, not permission to detach a volume.

Run the finite operator entry from a normal released image:

```sh
PAPERCLIP_NATIVE_HARNESS_PRESTAGE=true node --max-old-space-size=512 server/dist-runtime/native-harness-prestage.mjs
```

The entry loads the stored Cloud configuration and requires shared object storage.
It processes one source at a time, has a 90-minute deadline, and stops on shutdown.
It starts no scheduler, does not drain tasks, and always reports
`enrollmentReady: false`. Check serving memory headroom before running a separate
process on a tenant. Keep the deployment on normal releases.

Only a successful, finished source with a released committed coordinator and an
accepted result can publish through this path. At both database fences, hold the
task share lock and recheck its checkout, related queued/running executions,
recorded session and Runner, exact backup-stamp lease, and unchanged local
manifest and suspended state. A concurrent turn, moved source, revoked stamp or
changed owner defers that source. Unrelated executions continue unchanged.
No lease, result, task or lifecycle state is rewritten to make a source eligible.

The final offline migration still stops all writers, verifies every durable
object, imports deferred sources and all other data, and exports only its normal
complete eligibility receipt. Qualification starts from the saved pristine
database, records the separate preparation phase, and then proves the normal
bundled offline entry and empty-home restoration. Preparation alone cannot pass
enrollment or active-agent release acceptance.

The online preparation command loads the configured app key before copying. It
requires a valid existing key and retains that key in its process environment
so a missing file cannot create a replacement during publication. Its database
connections have five-second lock waits and 30-second statement and idle
transaction limits. Cancellation closes the command's clients and has a
ten-second process-exit fallback for a dependency that does not settle.

Workspace archives preserve a resolved Git merge that still awaits its merge
commit. The archive retains the merge heads, original head, message, mode,
automatic merge tree and selected index, and verifies their objects and unchanged
metadata before publication. A restored copy can continue the merge after the
source disappears. Git still protects later unstaged edits during abort.
Conflicted indexes, merge autostash, rerere state, unfinished rebase or sequencer
operations, invalid metadata and concurrent changes block capture and retain the
original workspace. Migration never commits or aborts a user's Git operation.
