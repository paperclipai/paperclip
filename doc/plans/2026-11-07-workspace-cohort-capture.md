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

An apply caller must supply an original `createDb` pool and an `AbortSignal`.
`concurrency` defaults to two and accepts values from one through eight.
`apply: false` checks the selected membership without reserving operations or
capturing files or using storage. A verified read-only transaction can supply
this observation's database reads. It does not attest held source fences or
promise that a later apply will remain eligible. Its generated cohort ID is not
an apply token; a saved journal's complete membership remains authoritative.

## Execution and resource limits

Each member must have the same complete project, issue, and workspace source
component. A selected root cannot contain another selected root. Aliases of the
same root are allowed. Existing nested-import and recovery blockers still apply.
The batch acquires an independent complete source fence, all component lifecycle
locks, and the union of required physical copyback locks. It refuses to borrow
an enclosing transaction because a savepoint cannot confirm the outer commit.

Reservation runs serially on the original pool. Each member makes one archive,
computes its checksums while copying files into it, encrypts it, and
uploads it. Migration trusts a successful upload. It does not pre-hash source
files, download the upload, extract a test copy, or capture the source again.
Encryption computes the ciphertext checksum as it writes, without a separate
read of the encrypted file. These member operations run concurrently.
Under the complete fence, preflight compares every selected workspace fingerprint
with the aggregate source proof's full preimage before the first reservation.
Each reservation repeats its member check before writing a journal. Earlier
source changes refuse the attempt; a fresh attempt can replan when no journal
was reserved. Source changes after a partial reservation remain blocked by the
saved aggregate proof.
One nested-child selector belongs to the complete cohort fence. Its prepare
calls are queued. It uses committed snapshot and operation records to retain
already imported children as dependencies. It does not download, restore, or
recapture those children. Publication still checks their database bindings.
The selector closes after all member work joins, before the fence can leave.
The caller must budget for the number of logical captures, even though there is
only one Node process. The first hosted qualification
uses two same-component leaves without imported children. Eight captures can use much more scratch space, CPU,
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
the batch. Every saved pending member must still be running and unfinished;
cancelled, failed or finished journals are refused before either preflight
eligibility or snapshot work. Publication repeats that check. The owner does
not reset or reopen those journals. A single-workspace import refuses a cohort
journal.

After upload, the owner transaction checks every member's ownership, journal,
recovery binding, and snapshot record before it writes workspace authority.
It does not reconstruct the data to prove the copy. It publishes members
serially. The outer commit must
succeed before the batch returns success or publishes live activity events.
The originals remain intact.

After a failed or interrupted attempt, call the batch again with the **same full
workspace ID set**. A persisted member journal supplies the original cohort and
preallocated operation IDs, including an interruption halfway through
reservation. A changed or incomplete membership is rejected. Fresh physical
source checks still run after a process or volume handover; the durable logical
fingerprint does not treat an inode number as lasting authority.

An acknowledged upload is reused directly. If the previous process lost its
upload reply, a journaled upload found by HEAD is reused. Neither case rebuilds
or downloads the archive. An explicit upload failure remains a failure.

## Archive compatibility

Migration keeps the PCWS1 archive format. The file checksums required by existing
readers are computed during the single source copy, without a preliminary file
read. Their fixed-length fields are filled in the archive header after copying.
The complete archive is checksummed for storage. Existing readers, saved
snapshots, and interrupted upload journals remain compatible. Ordinary run
captures keep their existing mode. Object loading still authenticates and
decrypts the complete encrypted archive when a real restore is needed.

This deliberately trades migration readback and repeat source comparisons for
speed. It relies on the existing source/writer fences and the storage upload
acknowledgement. The original source is retained for recovery.

An uncertain commit must first be observed through the canonical inventory and
journals. An entirely remote set is an idempotent replay only when its selected
snapshots and succeeded journals prove the same complete cohort membership.
A partial, unrelated or changed committed set is refused. A mixed remote/local
set is refused for explicit investigation. The API does not repair or clear
foreign journals, recovery actions, or remote provider obligations.

## Local proof

The focused PostgreSQL and real filesystem suite exercises overlapping uploads,
held source and copyback fences, cold restore after original removal, foreign
journals, journal mutation, partial reservation, caller cancellation, peer
failure, fence connection loss, and an actual deferred outer-commit failure.
The existing single-workspace and recovery suites remain part of the affected
regression check. Local macOS evidence does not replace a source Linux/Node 24
two-member canary or prove a speedup. An earlier six-run macOS comparison was
inconclusive under host contention, including slower cohort runs. Its twelve
cold restores passed, but it is not performance acceptance. Hosted use remains
opt-in: measure two members on the same host, including peak memory and scratch
headroom, before considering a larger cohort. This API adds no caller, scheduler
or automatic batch selection to the running app.
