# Post-save agent-directory cleanup

Date: 2026-10-25. Parent: captured instruction commit PR #17670 at
`03e1b3cd7270c7438a47562b170b3a9b2dbf112e`.

## One reason and its owner

A stopped agent-directory copy may have saved its files but still owe deletion
of its temporary local or remote materialization. Previously every orphan-reaper
pass called the cleanup portion of `recoverCaptured`, including with no cleanup
owed. This slice moves that reason to the existing delivery coordinator and
scheduler. Captured instruction commits remain the separate parent slice;
stopped instruction collection remains in the reaper for a subsequent slice.

`agent-instruction-working-copies.ts` owns discovery, scheduling and copy writes.
`agent-directory-working-copies.ts` continues to own filesystem serialization,
stop proof, materialization identity, remote lease checks, and physical deletion.
The worker calls that owner; it does not move provider behavior into startup or
the scheduler. No new table, independent timer, or provider branch is added.

## Durable obligation and deadline

The existing copy row owes this cleanup when all of these hold:

- State is saved, unchanged, resolved or unavailable.
- `processStoppedAt` records stop proof.
- Receipt schema is `paperclip.agent-files.v1`.
- Ownership has not transferred through `retainedByRunId`.
- Receipt has a baseline or `cleanupPending: true`, and is not final with
  `cleanupPending: false`.

A final false flag stays final even if an old receipt retains a baseline. This
matches the directory owner's existing no-op rule. Preparation and live warm
copies are not stop proof. Candidate bytes, saved canonical files, storage
warnings, conflict policy and retention semantics are unchanged.

Startup reconstructs pending identifiers and saved `nextAttemptAt` in keyset
pages of 100. It does not transfer baseline JSON or candidate bytes into the
scheduler. Fair batches execute at most 20 entries per pass. The scheduler
retains identifiers for all outstanding entries; memory scales with actual debt.

A due check rereads current state and reserves the existing 30-second retry with
the copy CAS and a due-time guard before I/O. A concurrent later deadline wins.
Physical release joins the existing canonical directory lock and rereads its
current owner. Completion is established by the saved receipt, not a void return
from release. Deferred remote cleanup remains scheduled. If no future retry was
saved, an error retains the shared bounded backoff rather than an immediate loop
or forgotten entry. Failed entries do not prevent other admitted entries from
being attempted. Manual/startup `recoverCaptured` preserves its default behavior
and per-row error handling; only its migrated periodic caller skips this lane.

## Producers and transaction boundary

The common copy patch boundary signals before writes that enter, change or leave
cleanup eligibility. It reuses the short transaction introduced for captured
commits. File operations, merge locks and remote calls stay outside that new
transaction. Nested use retains the existing outer-commit and uncertain-outcome
protocol. A signal only requests inspection of authoritative records.

The producer audit found only these two copy-table owners. Directory preparation
inserts preparing rows; warm handoff inserts prepared successors and supersedes
prior warm rows. Direct adoption requires `unchanged_turn` and no stop proof.
Those direct writes cannot create this post-save obligation. Eligible transitions
use the shared patch. Agent/company deletion invalidates the corresponding
company before run cascades. Worktree execution policy changes reactivate the
worker through the existing settings transaction. Changes to remote termination
proof can make existing pending cleanup executable; the pending row's retry
retains coverage without requiring an independent lease-table scan.

The supported model remains one process with instrumented writes. Independent
SQL writers and additional replicas need their own integration. This PR does
not claim those writers are observed by local notifications.

## Lifecycle and resource safety

Drain and standby retain requested scopes/deadlines without recurring SQL. The
heartbeat facade applies the existing worktree execution policy and task-drain
gate; enabling worktree execution signals a fresh reconstruction. Startup
registration follows existing recovery and respects scheduler disablement.
Shutdown joins admitted cleanup, including a held real filesystem deletion.

Remote cleanup still requires the exact current lease, materialization path and
termination evidence. It never acquires a replacement environment to perform
cleanup. Unknown ownership remains pending. A returned cleanup promise is not
proof that the provider released its resource. Cached transports cannot override
current lease state. Existing owner tests retain these fences.

No host-sleep safety check or Cloud wake capability is relaxed. This migration
establishes worker quiet for settled directory history, not deployed suspension
or measured cost savings.

## Index and migration

Migration `0407_greedy_star_brand.sql` adds a partial `agent_instruction_copies_cleanup_idx` on the
existing table. Its predicate matches discovery and excludes final history.
The migration uses `CREATE INDEX CONCURRENTLY IF NOT EXISTS` and the existing
nontransactional runner, including interrupted-index repair. Schema generation
retains snapshots 0403 through 0407 and preserves all executable migrations.
The original draft used 0395; later regeneration history remains recorded below.

A rolled-back PostgreSQL fixture with 10,000 added completed records and one
pending record used this index: one row, three shared-buffer hits, 0.005 ms local
execution time. This establishes that this plan skips completed history; it is
not a production latency guarantee or constant-cost claim for arbitrary pending
work.

## Verification and failures preserved

- Full directory suite: 101 passed, including 14 new lifecycle/worker cases,
  against fresh PostgreSQL with real temporary files (26.68 seconds).
- Startup suite: 52 passed, including enabled/disabled registration and removal
  of this lane from the periodic reaper.
- Existing captured instruction and heartbeat release consumers: 47 passed
  against a fresh PostgreSQL database (17.03 seconds).
- Workspace typecheck and build passed. Remote CI/review remain to be recorded.
- Migration applied to fresh databases, resumed after a failed application, and
  runner replay passed. Query-plan fixture rolled back.

The first focused worker run had 7 passing and 3 failing cases because the test
imported `idleWorkSnapshot` from the wrong module. The import now uses its owning
`task-admission` module. The first concurrent migration attempt failed because
0395 was not yet registered with the nontransactional runner; registration was
added, then application resumed successfully.

The first full owner/startup run had 148 passing and one failing case. The existing
reservation-failure test intercepted `db.update`, which no longer receives that
write after it moved into a transaction. Its injection now fails the reservation
transaction. The same substantive assertions remain: the first receipt and files
stay intact, and the next copy cleans successfully. The final 101-case owner run
passes this check. New coverage also proves reservation-failure backoff, a later
deadline winning the claim, real collection racing recovery with one deletion,
unknown remote ownership, and actual worktree setting reactivation.

Filesystem suites use fresh databases per full invocation: their teardown removes
temporary roots, so reused retained rows would refer to deleted fixture paths.
The baseline and failure logs are retained under `/tmp/sleep41-*` locally; the PR
records the outcomes for reviewers without requiring access to those files.


## Updated parent and current acceptance (2026-10-28)

The existing duty was merged normally with the verified instruction-commit
parent. Only its unpublished 0399 migration artifacts were deferred while
adopting parent history, then regenerated through `pnpm db:generate` as
`0405_petite_frightful_four.sql`. The concurrent, idempotent index SQL is
byte-identical to the original. Every prior SQL and journal entry and every
retained parent snapshot is unchanged; the five newest snapshots are 0401-0405.
The only snapshot merge conflict was resolved with the exact parent bytes.
Owned domain/schema edits and unrelated upstream blobs are preserved.

Current source `7184877830e2b4f56d61fe7eb6b8c3d92e1353e6` passes **284 cases across six complete files**,
with no skips. The verbose case records give these counts:

| Complete file | Passing cases |
| --- | ---: |
| src/__tests__/agent-directory-working-copies.test.ts | 101 |
| src/services/heartbeat/run-lifecycle.test.ts | 31 |
| src/__tests__/agent-instruction-working-copies.test.ts | 38 |
| src/services/heartbeat/recovery.test.ts | 45 |
| src/__tests__/server-startup-feedback-export.test.ts | 55 |
| src/services/heartbeat/instruction-working-copy.test.ts | 14 |

Instruction copies, directory copies, and heartbeat recovery each use a distinct
new disposable PostgreSQL database migrated before the fixtures. Lifecycle
fixtures retain real embedded PostgreSQL. Database build, production server
typecheck/build, module boundaries, target migration order, and all three fresh
0405 migrations pass. The older failed fixtures and timing findings above remain
part of the record; no passing retry is used to erase them.

A populated 0404 parent database upgraded to 0405: all 403 existing migration
receipts remained identical and exactly one was appended. Replay added none.
The cleanup index is valid and ready on both fresh and upgraded databases.
This verifies safe migration and worker behavior, not deployed sleep or Cloud
alarm delivery. Final publication still requires the actual landed parent
ancestry and fresh current-head review and CI.


## Published parent review cleanup

The published captured-save parent is now `a1a0ae5b02e8a650408bf4c55ae99071c3bff59c`.
Adopting it through a normal merge carries its actual-parent audit and removes
seven parent-owned code-comment lines under CONTRIBUTING.md. Every changed code
file retains its exact non-comment TypeScript token stream; the entire database
source tree is unchanged. This slice adds no code comments relative to that
parent. The 284-case acceptance and 0405 upgrade evidence retain their original
scope, with no runtime or assertion change hidden as a parent update. Actual
landed 0404 ancestry and fresh published-head gates remain required.

## Current parent migration history and corrected acceptance

Current parent `a39d6fe84b582ace7b4a6d20312943d65e750d30` carries the actual
merged webhook-recovery ancestry, the new Coordinator/Runner changes, and
append-only migration 0406. Only this slice's unlanded 0405 artifacts were
removed before a normal merge. Original runtime/schema edits and every unrelated
upstream blob are preserved. The generated snapshot conflict uses exact parent
bytes. The existing index was generated as `0407_greedy_star_brand.sql`, with
identical original concurrent/idempotent SQL. All landed SQL files, prior journal
entries, and retained snapshots remain unchanged. The five snapshots are
0403 through 0407.

An initial local runner mistakenly replaced its database build with a pnpm
filter that matched no projects. Its zero exit was not a build pass. The first
fresh migration then failed because compiled migration assets were absent. Both
logs and the original command receipt remain. No owner tests ran in that failed
attempt. Commands now select the actual database build and current migration
order by name rather than position.

At `e7753d731810ad342468213129ddab4345fb1e4c`, the corrected run passes all
**284 cases in six complete files**, with no skips, in 50.01 seconds. Four unused
PostgreSQL 17 databases migrated through 0407 isolate the destructive fixtures.
The embedded-only lifecycle test temporarily used its own external fixture
because this host cannot start more embedded clusters; its fixture import was
restored byte for byte. Assertions and original timing limits are unchanged.
This is qualified external-database acceptance. Published CI still must pass
with the original embedded fixture. The actual database build, server types and
build, boundaries, and exact current migration-order check pass.

A populated 0406-to0407 upgrade preserves every one of the 405 prior migration
receipts and all 38 companies, adds exactly one receipt, and adds none on replay.
The cleanup index is valid and ready on both fresh and upgraded databases. These
results supersede the earlier local 0405 preparation after master's migration
history advanced. No new published head or current-head review pass is implied;
parent squash ancestry and new published-head gates remain required.

## Published bounded-parent consumer acceptance

A normal merge carries the updated instruction-recovery parent and its bounded
retry-cancellation dependency. Both complete patches and every unrelated upstream
blob are preserved. Source `70a6800eea874bdb87685bf6eea66de79c48b577` passes all
**284 cases in six complete files**, without skips, in 48.88 seconds. Four new
PostgreSQL 17 databases migrated through 0407 isolate the fixtures. The temporary
external lifecycle fixture is restored exactly; all original assertions and
limits remain unchanged. Actual database build, types/build, boundaries and exact
current migration order pass. The complete 0407 database tree is unchanged from
the populated-upgrade proof above.

Adopting published parent `915ef6f20a68fffe89711cc97a6196521ea9885d` records the
actual 0406 parent squash ancestry. The resulting integration
`d8edcd131924b1ad744e232df9b548cf02b1e249` changes only the parent's audit;
complete server, package, UI and test trees equal the accepted source. This slice
remains unpublished. A tree-only probe predicts text conflicts after the pending
instruction parent is squashed, so publication waits for its actual merge and
normal ancestry reconciliation. The probe is not a live merge proof or a reason
to bypass any gate.

## Actual instruction parent landed; publication ready

Parent #17670 merged as `b294de546bf9cd3a8578a7a66d7e8ec0eb939799` with all
58 checks and both current-head reviews at 5/5. Its entire tree equals the
already-adopted reviewed parent `915ef6f20a68fffe89711cc97a6196521ea9885d`.
A normal merge records the actual squash ancestry. The eleven predicted text
conflicts came from duplicate history; the exact parent tree was already in the
accepted branch ancestry. Resolving the inspected conflicts to the accepted
versions leaves the **entire merge result tree identical** to the prior
`c6f53662f4035a69d41f61f1759674de22f3163b`, including automatically merged files
and the 0407 database tree. The integration is
`531058e527fe4601958fbbf02ad2e7bbbf78af48`.

All source covered by the 284-case acceptance remains byte-identical. This final
follow-up changes documentation only. The actual target now contains migrations
through 0406, and this slice adds only append-only 0407. Fresh review and CI must
run on the published head; old draft scores are not current passes. No merge or
instance-sleep completion is inferred from publication readiness.
