# Import spool cleanup without an hourly scan

This is slice 59 of the recurring server work migration, based on slice 58
at `929c86e32e00d219b329741dd2c89c40b1a5f826`. The original inventory includes
abandoned company-transfer files among the remaining application maintenance
loops. This slice does not complete the inventory or certify other stack PRs.

## Problem and ownership

The application previously ran `sweepAbandonedImportTransferSpools` at startup
and every hour. It listed the import directory and queried every transfer with
files, including failed transfers retained for a future retry and applying
transfers owned by live work. These retained files caused SQL indefinitely.

`company-import-transfers.ts` owns filesystem layout and cleanup policy.
`company-transfer-runs.ts` owns all supported production ledger writes, including
compare-and-set cancellation. `import-spool-cleanup-work.ts` connects these
owners to the existing delivery coordinator and scoped deadline helper.
`app.ts` registers the worker and removes its local filesystem subscription at
shutdown. The coordinator owns non-overlap, retries, drain, and joining cleanup.
There is no new table, filesystem watcher, timer, or provider abstraction.

## Durable truth and deadlines

| Existing state | Obligation and next wake |
| --- | --- |
| No directory | None; no ledger read or future scan |
| Pending/running upload with files | Saved `updatedAt + 24h + 1ms`; revalidate and cancel atomically before deletion |
| Failed transfer | Retain verified files for retry; no recurring work |
| Applying transfer | Retain files for its live apply owner; no recurring work |
| Completed/cancelled transfer with files | Delete immediately; failure keeps a bounded retry |
| Directory with no ledger row | Directory mtime plus 24h, rounded to the first millisecond strictly after the cutoff |
| Database or filesystem read error | Keep discovery unresolved and retry; absence is not inferred |

The extra millisecond preserves the existing strict idle cutoff. A resumed
transfer updates its row, so the cancellation guard prevents deletion based on
a stale read. Cleanup uses cancelled, not failed: failed transfers remain
claimable for apply and cannot be used as a deletion claim. Failed files remain
retained indefinitely under the existing policy. Permission errors no longer
count as an empty directory. Only ENOENT means absence. Symlinks and non-UUID
names are not followed as import directories.

Startup still separately recovers stranded applying rows once. The deadline
worker never performs that recovery, because doing so would interrupt live
applies. This migration preserves that startup operation's existing admission
behavior; it does not expand the worker's authority to fail live runs.

## Producer and boundary audit

All production writes to `company_transfer_runs` are in its service. A local
transaction helper registers the existing database-work intent before each
update. It composes with outer transactions; savepoint release does not publish
premature cleanup. The insert allocates its UUID before registering intent in
the existing idempotency transaction. Methods covered are:

- `resumeOrCreate` when it inserts; returning an existing row makes no change.
- `recordManifest`, `start`, `attachCompany`, `notePartUploadActivity`, and `completePart` (activity deadlines).
- `claimApply`, `releaseApplyClaim`, `complete`, `fail`, and `cancel` (eligibility).
- `cancelIfIdle` (deletion claim).
- `recoverStrandedApplyingRuns` (one startup-wide invalidation).

Ordinary hints identify one run. No directory means the worker returns before
reading the ledger, so export writes and declarations without parts do not
trigger global scans or cleanup SQL. The shared ledger now pays transaction
intent overhead on these writes; notifications do not make writes free.

The filesystem owner emits process-local root/run hints after part writes,
part removal, and whole-spool removal, including partial failures. A failed
rename can leave a directory even if the subsequent ledger update never happens.
Startup scans existing directories to reconstruct that obligation. The cleanup
read selects only ID, company ID, status, and update time, not the manifest or
completed-part history. Pre-company imports and orphan directories share an
instance-level fairness group; this label is not an authorization identity.

The supported writer model is the server's existing single-process import and
apply flow. Independent SQL writers, another server sharing these directories,
and external filesystem edits have no live notification contract. Restart
reconstruction still sees persisted files. This slice does not claim otherwise.

## Lifecycle and verification

The worker retains scoped invalidations arriving during discovery or cleanup.
Drain suppresses passive SQL and filesystem discovery without consuming pending
work. A first upload during drain still reconciles on resume. Shutdown removes
the filesystem listener and joins already-running cleanup through the delivery
owner. Failed removals retain the scoped retry floor even when another write
invalidates their run. Empty, failed, and applying states disarm the worker.

A real PostgreSQL regression first reproduced an unsafe preexisting behavior:
a failed ledger read was swallowed as a missing row, and cleanup deleted the
old directory. The repaired test requires the error to propagate and the bytes
to remain. Its first setup attempt could not find a root-level tsx binary;
the repository's CLI-installed runner prepared the dedicated database instead.

All 50 tests across three complete suites pass: import worker lifecycle, import
routes, and transfer ledger. This includes real files and PostgreSQL for strict
expiry, scoped first writes, retained history, orphan reconstruction, outer
commit and rollback, apply-versus-cleanup races, permission errors, partial file
writes, concurrent wakes, retry through drain, and shutdown joining. Existing
route tests cover upload/apply concurrency and successful apply with failed file
cleanup. No tests in these three suites were skipped. Server typechecking passes.

The first lifecycle run passed 10 of 14 cases. Four fixture failures came from
fake time expiring PostgreSQL socket timers, a drain fixture disabling both
execution and transaction reconciliation, counting old filesystem spy calls,
and comparing advanced fake time against real filesystem mtimes. The fixture
now keeps database driver timers out of the simulated lifecycle, models the
production drain contract, and starts fresh observation windows. Product
assertions were retained; three additional lifecycle cases also pass.

Workspace typechecking, full build, and remote PR checks are tracked separately
in the PR. Full local `test:run` remains unverified due to the previously recorded
embedded PostgreSQL capacity limitation. Dedicated `_test` databases were used
for these complete suites. No host semaphore cleanup was repeated.

## Sleep boundary and remaining scope

This proves worker quiet and reactivation, not database or host suspension.
The existing host-sleep proof still treats company transfer rows conservatively.
The Cloud alarm contract has not been extended to import-file expiry. Internal
`nextWakeAt` alone is not proof of a persisted external alarm. Do not remove that
sleep blocker on the strength of this worker migration.

Other original inventory duties, master reconciliation, and existing stack
review/CI debts remain separate work. No stack PR is merged by this slice.

## Review repairs

The first review identified two concrete gaps, each reproduced before its fix:

1. One unreadable child directory rejected the entire startup discovery pass,
   leaving another completed, readable upload untouched. Discovery now retains
   healthy entries and represents the failed child as unresolved work. The
   existing per-entry retry and error path handles that child independently.
   A failure to list the root still retains global discovery, because its child
   inventory is unknown. A database outage likewise never proves absence.
2. Re-running the route suite against the external test database failed on its
   fixed company primary key. Company and actor identities are now unique to the
   fixture. Teardown deletes exactly its actors' transfer rows and its company,
   then closes the database and removes temporary files. It also handles partial
   setup without trying to remove an undefined path.

All 51 owning tests now pass, including 18 worker cases. The full 24-case route
suite passed again against the same database after the combined run. Server
typechecking also passes. The database-drain fault fixture now holds the read
failure until explicitly released: a single transient read failure can recover
on the first per-entry check, so it did not represent an outage through drain.
The assertion that files survive a persistent outage remains unchanged.

PR: [#17835](https://github.com/paperclipai/paperclip/pull/17835).
Remote acceptance and workspace checks remain tracked in that PR; these repairs
do not resolve other stack findings.

## Upload activity ordering

A later review found that the successful file-write hint can arrive before
`completePart` refreshes the ledger timestamp. An already-old running upload
could then lose its newly verified bytes to cleanup. A real route regression
held the part receipt until the actual cleanup claim ran: the upload returned
410 instead of 200 before the repair.

The route now calls the ledger owner's `notePartUploadActivity` after validating
the part's length and hash, and before writing its bytes. This uses the same
transaction notification helper and the same pending/running state guard. It
refreshes activity without recording a receipt for bytes not yet written. The
idle cancellation compare-and-set then misses if upload activity wins. If
cancellation already won, the update cannot revive the run; the existing 410
and stray-file cleanup path remains. Applying and failed states are not revived.
The extra activity write is explicit per verified upload; it is not a new table,
queue, or distributed lock. A failed filesystem write keeps a concrete grace
period before cleanup and still emits its filesystem hint.

All 52 owning tests pass after this repair. The new route test requires HTTP 200,
exact file bytes, and the committed part receipt under the controlled race.
Earlier review repairs and repeatable fixture evidence remain valid.

## Current master integration and spool acceptance (2026-10-29)

Accepted source `87549234b125464dc7fa216227fc9bfa1d93f3d7` contains reviewed parent `fb252c8b0e52ce355e7d98db2e392e4831f99c61`.
The parent merged as `c8b7afee06c183ab922d097de1183d61c0bc4387`. A normal merge adopts the actual squash
after proving complete parent-tree identity. The complete accepted child tree
stays unchanged; only this audit follows in the publication.

The composition proof preserves 1,237 parent-only paths, eight owned-only paths,
11,521 identical paths, and two shared automatic merge results: app registration
and delivery queue names. The sole manual conflict is in the documentation
ledger. It keeps the parent's landed Grok status and the owned import-spool PR
entry. There is no manual production resolution. Newly added narration and an
orphaned old startup comment fragment were removed without changing behavior.
Packages equal the parent byte for byte, including profile 80 and preserved
historical profile fixtures. Other native worker services are unchanged.

All 293 cases across eight complete server files pass with zero skips:

- 18 real spool worker lifecycle cases exercise filesystem and database work.
- 25 HTTP import-transfer cases cover uploaded bytes, receipts, and lifecycle.
- Nine transfer-ledger cases cover its write and recovery contract.
- Eight cloud capability-floor cases preserve disabled import behavior.
- 114 portability cases preserve actual import/export consumer contracts.
- 92 startup cases preserve lifecycle wiring and readiness.
- 26 coordinator cases and one scoped deadline case cover shared mechanisms.

This includes quiet absent and retained spool states without SQL or directory
scans, strict saved deadlines, resume/apply races, nested commit/rollback, restart
reconstruction, failed writes, permission and database errors, root/symlink
boundaries, shutdown joining, and first/concurrent writes during drain. Storage
is isolated with a task-owned PAPERCLIP_HOME and temporary spool roots. Three
fresh PostgreSQL 17 databases use all 412 journal entries through tag/index
0413_tired_kronos. No source adaptation, assertion, or timeout changes were needed.
All eight test-file hashes remain exact.

Database build, server production typecheck/build, module boundaries, migration
order, and current Copilot identity pass. The test command takes 12.28 seconds.
The parent's 4,192 selected native/resource cases belong to its recorded source;
they are not presented as rerun or added to this slice's 293 cases. No full local
repository, live provider, or deployed sleep acceptance is claimed.

Earlier remote trusted-runner and Greptile service errors remain historical
evidence. Neither is treated as a fresh pass. Publication must obtain current
CI, security, and exact-head Greptile 5/5. The older Ponytail Ship verdict names
a different head and is not current review evidence. Actual findings must be
resolved; an older verdict cannot replace the current gate.

Supported ledger writes use their transaction-aware notifications. Supported
filesystem mutations use the spool owner callbacks. Direct writes from another
process need their own ingress and can otherwise be discovered only at startup.
Internal cleanup deadlines do not prove an external Cloud wake. Existing sleep
blockers remain; no database suspension, external alarm coverage, or cost savings
is claimed.

## CI concurrency test repair (2026-10-29)

Current-head CI on `284294a9ab453406cfb6d4ff4bafc9c403dd1c80` passed 2,192 server-shard cases and failed
one tool-access audience race case. The test assumed that two 50 ms sleeps
queued member suspension ahead of an empty audience replacement. That ordering
was not established. If the explicit empty replacement wins while membership
is still active, its company-wide audience is the authorized result.

The repair changes only that three-case test fixture. Dedicated backend PIDs
are observed, and each queued writer must be blocked by the exact first
transaction before its lock is released. Cleanup is proved to queue first.
All original inactive-audience, HTTP denial, and no-token assertions remain.
Finally releases transaction gates, joins pending work, and closes dedicated
clients if a readiness assertion fails. Production authorization is unchanged.

A controlled 500 ms delay before cleanup issues its lock query reproduces all
three old timing failures. The old fixture permits empty replacement to finish
first; observed rows confirm a successful explicit replacement and an empty
audience after membership cleanup. With the same controlled delay, the repaired
fixture passes all three suspension/archive/removal cases. The artificial delay
and diagnostic logging are not committed. The final test keeps its original
15-second limit and uses bounded real PostgreSQL lock observations.

The complete 472-case tool-access file passes on source `5d974e5eb28fc3e28b5e75e36fb18c61582348d5` in 20.86
seconds, with zero skips. The eight earlier consumer files remain hash-identical
and their 293 passing cases remain source-scoped evidence. This yields 765
distinct passing cases across nine complete files; controlled reruns are not
counted again. The first local full-file run passed 471 cases and timed out one
separate stdio-administration HTTP case at 15 seconds. A single fresh full-file
diagnostic run, with sanitized database wait-state capture, passes all 472.
That local timeout's cause was not established. It remains a failed command in
the record; no timeout or assertion changed and no first-run aggregate pass is
claimed. Fresh publication-head CI and reviews must pass again.
