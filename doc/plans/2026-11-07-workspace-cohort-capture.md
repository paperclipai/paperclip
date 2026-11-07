# Bounded workspace cohort capture

`migrateRemoteWorkspaceCohort` in `server/src/services/remote-workspace-migration.ts`
imports one through eight leaf workspaces from one proven physical source
component. It uses the same online source, lifecycle, recovery, archive, storage,
and publication owners as `migrateRemoteWorkspace`. It does not stop unrelated
work or replay a provider turn.

```ts
await migrateRemoteWorkspaceCohort({
  db,
  storage,
  companyId,
  workspaceIds,
  apply: true,
  concurrency: 2,
  signal,
});
```

The caller must supply an original `createDb` pool and an `AbortSignal`.
`concurrency` defaults to two and accepts values from one through eight.
`apply: false` checks the selected membership without reserving operations or
capturing files. It does not promise that a later apply will remain eligible.

## Execution and resource limits

Each member must have the same complete project, issue, and workspace source
component. A selected root cannot contain another selected root. Aliases of the
same root are allowed. Existing nested-import and recovery blockers still apply.
The batch acquires an independent complete source fence, all component lifecycle
locks, and the union of required physical copyback locks. It refuses to borrow
an enclosing transaction because a savepoint cannot confirm the outer commit.

Reservation runs serially on the original pool. Capture, encryption, upload,
authenticated readback, restore, and recapture run concurrently on that pool.
The caller must budget for the number of logical captures, even though there is
only one Node process. Eight captures can use much more scratch space, CPU,
storage bandwidth, and database capacity than one capture. Start with a
two-member canary and measure the actual host before increasing concurrency.

The first failure aborts the shared internal signal. The batch stops taking new
members and waits for every active capture and its scratch cleanup. It retains
the complete fence until those peers settle. Cancellation does not promise an
instant return from a storage callback that ignores its signal.

## Publication and resume

Each reserved operation stores the same versioned cohort identifier, logical
source fingerprint, and exact sorted workspace/operation membership. Only those
exact journals are admitted together. Other running or uncertain journals block
the batch. A single-workspace import refuses a cohort journal.

After capture, the owner transaction locks and freshly validates every member,
source, journal, recovery binding, and uploaded snapshot before it writes any
workspace authority. It then publishes members serially. The outer commit must
succeed before the batch returns success or publishes live activity events.
The originals remain intact.

After a failed or interrupted attempt, call the batch again with the **same full
workspace ID set**. A persisted member journal supplies the original cohort and
preallocated operation IDs, including an interruption halfway through
reservation. A changed or incomplete membership is rejected. Fresh physical
source checks still run after a process or volume handover; the durable logical
fingerprint does not treat an inode number as lasting authority.

An uncertain commit must first be observed through the canonical inventory and
journals. An entirely remote set is an idempotent replay. A mixed remote/local
set is refused for explicit investigation. The API does not repair or clear
foreign journals, recovery actions, or remote provider obligations.

## Local proof

The focused PostgreSQL and real filesystem suite exercises overlapping uploads,
held source and copyback fences, cold restore after original removal, foreign
journals, journal mutation, partial reservation, caller cancellation, peer
failure, fence connection loss, and an actual deferred outer-commit failure.
The existing single-workspace and recovery suites remain part of the affected
regression check. Local macOS evidence does not replace a source Linux/Node 24
two-member canary or prove the speedup at eight captures.
