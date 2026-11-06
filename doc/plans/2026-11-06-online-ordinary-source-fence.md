# Online ordinary workspace source fences

The importer can preserve an idle legacy source while unrelated object-backed
turns continue. This change does not assert `writersStopped` and does not use the
instance-wide offline admission gate.

## Ownership

`workspace-source-lock.ts` retains the existing per-company/task source advisory
key and adds a managed-project key. The project key covers the physical project
namespace, including new issues that have no workspace row yet. Heartbeat source
selection/materialization and workspace lifecycle owners retain the same key.
Configured aliases of canonical isolated task directories retain that directory's
original task key. Cross-company aliases are rejected.

The filesystem materializer keeps its database-free API. It retains physical
keys when called inside an admission owned by the database service. The runtime
call sites that can write these controller namespaces have these owners:

| Mutation entry | Source admission |
| --- | --- |
| Heartbeat preparation and its source/repository resolvers | Task keys and dynamically retained physical roots for the full preparation |
| Workspace reopen, expiration and cleanup | Existing task/source and lifecycle gateways |
| Rehome and nested-clone conversion | Shared move gateway retains task and project keys through the move |
| Runtime commands with a workspace record | Workspace lifecycle gateway |
| Project runtime commands without a workspace record | Physical project/task keys before provisioning and command startup |

Standalone materialization and source-resolution callers retain their existing
filesystem API. The source fence is established at the database-owning mutation
entry rather than inferred as a new requirement of that helper API.

The importer derives a bounded physical alias closure rather than accepting a
caller-supplied proof. It holds every existing alias's task and lifecycle keys,
plus the project key where applicable. It checks the closure and its ordinary
writer, service, operation and repository blockers again before publication.
Future preparation waits at its first project key; acquiring another physical
project while already holding one fails instead of creating a lock cycle.
Migration admission uses nonblocking lock acquisition.

The authority update commits on the connection holding the source fence. The
activity publication follows that commit. A dropped fence connection cannot
publish through another pool connection. Preparation also refreshes a selected
local workspace if migration published remote authority while selection waited.

## Capture and recovery

The archive owner retains all stable-read, mutation, cancellation, normalization,
restore and digest checks. Scoped ordinary captures reject included Git metadata
before reading it. Bare repository shapes, detached Git administration and
object-store alternates also require the larger Git fence. The self-contained
remote script contract remains intact.
The existing nested imported-child gate remains in force.

Terminal native recovery sources use the canonical online preservation helper.
The importer holds the finalizer's existing physical advisory key, re-inspects
after acquiring it, and compares journaled fingerprints under publication row
locks. Coordinator ownership must be null, including an expired owner. Provider
allocations, finalization checkpoints and task warnings remain present. Unknown
file recovery and other aliases' unproven recovery remain blockers.

The finalizer's known failed-export watchdog can retain a prepared source. Its
company, task, run, failure cause and canonical action fingerprint must match.
The coordinator must have a terminal failure with no owner or future retry.
The board-owned action must have no wake policy or separate file-recovery marker.
The proof retains `preparedSource` explicitly and never calls it finalized. The
original action, prepared descriptor and allocations remain unchanged. Its full
action/source fingerprint is checked under the same physical finalizer lock.

The separate company-scoped `reconcileOnlineWorkspaceOperations` entry retires
only a superseded operation with an exact later successful finalization receipt,
an accepted result and a committed ownerless finalizer. It reuses the canonical
row/advisory locks and writes the audit in the same transaction. It does not run
workspace work, settle recovery or change provider/task authority. The offline
entry retains its global deployment prerequisites. Inventory remains read-only.

## Measured cohort

The read-only inventory initially found 45 ordinary aliases blocked only by
physical overlap. A second bounded source probe on
`4d554f08218b04df49ec0f2a0d5c5dfdfaf65660` at
`2026-11-06T22:14:40.198Z` checked the three exact managed `_default` roots:

| Project | Workspace aliases | Source tasks | Root `.git` | Imported nested children |
| --- | ---: | ---: | --- | ---: |
| Shared root A | 40 | 13 | absent | 0 |
| Shared root B | 3 | 1 | absent | 0 |
| Shared root C | 2 | 1 | absent | 0 |

These are observational counts, not live migration results. A full included-tree
capture still rejects embedded Git or source changes. There are no live holds,
imports, cancellations or source filesystem writes in this qualification.

## Verification and remaining work

The focused fixtures exercise the actual importer, storage/archive restore,
heartbeat preparation, PostgreSQL source/lifecycle/finalizer locks, an unrelated
running remote turn, closure mutation, lost exclusion and retained provider
obligations. Run from `server/`:

```sh
node ../cli/node_modules/tsx/dist/cli.mjs ../packages/db/src/test-postgres-command.ts -- \
  node ../node_modules/vitest/vitest.mjs run \
  src/services/remote-workspace-online-source.test.ts \
  src/services/isolated-remote-workspace-source-lock.test.ts \
  src/services/remote-workspace-migration.test.ts \
  src/services/remote-workspace-migration-concurrency.test.ts \
  src/services/heartbeat/workspace-preparation.test.ts --fsModuleCache
```

The full goal still includes the remaining Git/shared and recovery workspaces.
The next extension must derive the Git administrative/common-object/alternates
physical closure and make actual preparation, reopen and cleanup owners retain
its keys before admitting those sources. Exact immutable nested-child coverage
can then use the existing archive owner under that closure. Git stores are not
assumed immutable, and completed or unreferenced history is not discarded.

The runtime-control route reacquires the same source/lifecycle fence for the
filesystem restore after it publishes admission. Its visible running operation
continues to block migration between admission and restore. The later service
start retains its existing independent lifecycle fence.

`reconcileOnlineWorkspaceOperations(db, { companyId, signal })` is an explicit
operator apply entry. The source qualification console can call this owner
with one exact company before online imports. Inventory never invokes it and
never settles operation rows as a side effect. The existing offline maintenance
entry retains its independent all-writers-stopped prerequisites.

Alias inspection bounds the company cohort to 1,000 records. A separate
minimal-path scan checks foreign physical aliases in pages of 256, up to
10,240 records. This safety bound remains conservative because lexical-prefix
filtering could hide a foreign symlink alias. Foreign rows do not consume the
company cohort bound. An inaccessible path or scan limit leaves the managed
source explicitly unproven. It cannot fall back to a weaker singleton import.
No foreign metadata is returned.

Runtime service exclusion also uses the physical working directory. An active
project service can have a different project-workspace ID and no execution
workspace ID. The company-scoped service scan checks up to 1,000 unsettled
rows; local path uncertainty blocks the import. Both runtime startup owners
hold the workspace, base and configured service source keys before provision
or persistence. The final rendered service CWD must already be fenced before
workspace link updates or spawn. Runs with no services retain their previous
filesystem-free path.

A read-only source observation at `2026-11-06T23:20:49.282Z` found 254 pending
legacy records and zero unsettled local-process services. No service handoff was
required by that observation. This is not a coherent or locked migration proof.
