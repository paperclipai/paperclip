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
