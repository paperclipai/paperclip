# Instruction recovery sleep audit

Inspected from slice 39 head bd490ee50b303187f0ae6f8fe2aa95477d66a40f.
Master inspected 5a28f7acf8. The following is the initial audit; implementation
and acceptance evidence for slice 40 are recorded below.

The apparent two calls in heartbeat/recovery.ts hide at least three reasons:
1. recoverStopped: collect/dispose registered instruction copies after terminal run
   AND independently established local/remote process stop. Never infer stop from
   terminal status. Temporary staging failure has its own pre-launch guarantee.
2. recoverCaptured pending loop: retry saving durable candidate bytes, state
   pending_commit, attempts <=2, nextAttemptAt null or due. Canonical authorization
   and base comparison remain in agentInstructionRevisionService.commit.
3. recoverCaptured cleanup loop: release temporary agent directories after a
   terminal save receipt plus processStoppedAt, baseline/cleanupPending marker,
   and due nextAttemptAt. Preserve remote identity and cleanup authority.

Keep one reason per PR. Captured commit is the smallest independent next slice;
stopped collection and post-save release must remain on the existing reaper until
separately migrated. Do not retire recoverCaptured wholesale with only save covered.

Durability already exists in agent_instruction_working_copies, defined in
packages/db/src/schema/agent_instruction_revisions.ts. Existing index
agent_instruction_copies_pending_idx(state,next_attempt_at) may suffice; inspect
EXPLAIN before adding an index. No new table needed. Attempts and nextAttemptAt
are business recovery state; do not reset the three-attempt bound.

Producer map:
- agent-instruction-working-copies.ts::patch owns CAS writes with state, attempts,
  baseHash, retainedByRunId predicates. Add before-write signal in short existing/
  new DB transaction, without enclosing file/network work.
- collectStopped captures bytes via patch(pending_commit) before calling commit.
  commitCandidate updates saved/conflict/retry state via patch; resolve also patch.
- prepare inserts preparing rows; no captured work until patch. acknowledgeExplicitSave
  only advances prepared baseline, not pending work.
- agent-directory-working-copies.ts receives patch for ordinary mutations. Its
  direct inserts/adoption/deletes need explicit audit but currently create prepared
  or staging rows, not pending_commit. Do not assume legacy candidate payloads
  and agent-directory receipts have the same semantics.
- Run/company/agent deletion cascades can remove obligations: signal exact scope
  before supported deletion to disarm stale entries.

Concurrency risk to test before relying on events:
A pending_commit write can wake recovery while foreground commit is still active.
Revision commit serializes through its owner and explicitly deduplicates exact
candidate bytes before testing baseline equality. Copy CAS can lose to a competing
attempt counter update; a later worker must recover the receipt without falsely
reporting conflict or saving twice. Test actual producer plus held foreground
commit and verify canonical bytes, one durable activity receipt, and final state.
No transaction should contain process/file collection just to emit a signal.

Stopped-copy producer audit is wider:
- terminal run transitions (including direct recovery writers)
- copies.processStoppedAt and retention/handoff state
- native.local_process_stopped via recordNativeLocalProcessStop in heartbeat,
  native restart recovery, and native-local-process-stop itself
- later process-start/identity events invalidate local stop receipts
- environment lease remoteExecutionTermination receipts and removal/reacquisition
  via environment-runtime, environments, task runtime, workspace recovery/export
- stalled unconfirmed owners are real pending obligations; preserve safe backoff
  or a complete notification replacement. Never claim quiet by dropping them.

Testing planned:
Real managed instruction file and authorization, actual collectStopped producer;
no-config/prepared/history/exhausted/conflict quiet; exact saved deadline; transient
save error; rollback/outer commit; foreground race; restart; drain/standby; shutdown;
more than one page and company fairness. Assert file bytes and save receipts, not
only callback invocation. Existing test harnesses currently require embedded DB;
use guarded external disposable URLs here as needed, maintaining embedded default.

Remaining acceptance of 39 and older stack gates stays outstanding. No merge
is authorized. No claim about host suspension or expanded Cloud alarm coverage.

Baseline acceptance before changing production behavior:
- 20 instruction working-copy tests passed in 6.83 seconds.
- 87 persistent agent-directory tests passed in 18.27 seconds.
- Suites used separate dedicated PostgreSQL databases through the guarded external
  test URL helper. Their embedded default and temporary filesystem isolation remain.
- This only establishes a baseline. No periodic instruction duty is migrated yet.

## Slice 40 implementation: captured commit only

Parent: slice 39 at `ecef7776a4b38e0c7e0b86d7009fcd01ed7658e5`.
Remote master remains `5a28f7acf8a8c86536c4f5c5369bfeb49a46c41a`.

The instruction service owns eligibility, saved retry times, and save attempts.
The existing scoped delivery worker owns coalescing, company-fair batches of 20,
reconstruction, pause/resume, failure backoff, and shutdown. Inventory uses scalar
fields and keyset pages of 100. Candidate bytes are read only for an actual attempt.
No table, migration, provider-specific scheduler, or Cloud alarm contract is added.

The pending predicate remains `state = pending_commit` and `attempts < 3`.
The actual `nextAttemptAt` is used; null means due now. Completed copies,
prepared/live copies, permission conflicts, and exhausted candidates are quiet.
The three-attempt bound and preserved-candidate policy are unchanged. A bounded
business retry is distinct from a database/inventory failure: the latter retains
shared recovery backoff rather than discarding an unconfirmed obligation.

The existing copy mutation boundary emits intent before writes that enter or
leave pending commit. Other copy mutations keep their existing query boundary.
The notification and update share a short transaction, including a caller-owned
outer transaction. Filesystem reads, file replacement, directory merge locks, and
provider transport operations are not enclosed in that new transaction. Company
and agent deletion signal company scope before cascading run deletion. Worktree
execution settings signal reconstruction; the heartbeat facade reads that policy
fresh and gates drain/standby. Local process signals do not cover independent SQL
writers or another replica; this remains the existing supported writer model.

A worker rereads the candidate and atomically claims an attempt using the existing
state, attempt, baseline hash, and retained-owner guards. It also requires the
saved deadline still to be due at claim time. A newer future deadline wins without
consuming an attempt. Manual/startup recovery delegates to this same owner. The
existing revision service retains permission checks, canonical-file locking,
exact-byte replay receipts, and baseline conflicts. Shutdown joins a save already
admitted; it does not discard the persisted candidate to become quiet.

Only the commit portion of `recoverCaptured` is excluded from periodic reaping.
Stopped-copy collection and post-save directory release keep their prior recovery
path for separate slices. The existing directory release after a successful save
remains part of that foreground settlement; its independent crash-recovery sweep
is not claimed migrated.

## Evidence and failure record

- Final instruction suite: 33 passed, including 13 worker cases, in 10.23 seconds.
  Covers quiet prepared/completed/conflict/exhausted history, real capture after a
  filesystem failure, actual saved deadline, restart, drain, standby, outer commit
  and rollback, existing attempt cap, permission conflict, foreground save race,
  shutdown join, newer-deadline race, worktree setting reactivation, and 103 saved
  candidates across multiple inventory pages. Tests verify canonical bytes and
  the save receipt, including one activity receipt after concurrent exact saves.
- Existing directory and startup acceptance: 137 passed on fresh fixtures.
- Final startup and heartbeat instruction-release wiring: 64 passed. Startup is
  counted in both selections; the three final suite groups cover 184 distinct tests.
- Workspace typecheck/build passed. Final server typecheck passed again
  after the manual recovery path adopted the common owner.
- Existing pending-copy index plan: with 10,000 synthetic completed rows and one
  eligible candidate, PostgreSQL used `agent_instruction_copies_pending_idx`, read
  one candidate and filtered two exhausted rows, with five shared buffer hits and
  0.011 ms execution. The fixture transaction rolled back. This only demonstrates
  that completed history need not be scanned; it is not a fleet benchmark or a
  constant-cost claim for arbitrary exhausted-pending history.
- Initial worker run: 26 passed, one drain fixture failed. The fixture disabled
  transaction reconciliation as well as work admission, so the intent hold correctly
  remained active. Drain now permits reconciliation; a separate standby case keeps
  it disabled and verifies no passive SQL while retaining the hold.
- First repeated directory run: 106 passed, 29 failed because its reused external
  database retained rows naming the prior run's removed temporary directories.
  Fresh database plus fresh filesystem fixtures passed all 137 tests. The production
  source was not changed to hide those failures. These filesystem suites require
  a fresh external database for each full run, as embedded mode already provides.
- A new race regression failed with the candidate incorrectly saved before a
  newly postponed deadline. Adding the due-time predicate to the attempt claim
  made the focused regression pass, followed by all 33 instruction cases.

## Boundaries and remaining acceptance

Related warm-directory ownership work: #14695. Its stop/retention guarantees stay
with the directory owner. No terminal status is promoted into process-stop proof.
No provider is launched to recover a captured legacy instruction candidate.

Current PR CI and fresh review are still required. Host suspension, database
suspension, external wake delivery, the two remaining instruction duties, the
other run-reaper duties, and the complete original stack inventory remain open.
The later stack campaign authorizes an ordinary protected merge only after exact-current-head Greptile 5/5, clean CI, and required review findings are resolved.

## Foreground ownership correction (2026-10-27)

Review of PR #17670 found that the original foreground race assertion accepted
an extra recovery attempt while the first save still held the canonical-file
operation. Exact-byte deduplication prevented a duplicate write but did not protect
the copy receipt: an incremented attempt invalidated the foreground failure CAS
and could lose its 30-second retry deadline.

The instruction-copy service now serializes collection and captured recovery per
company/run using the existing database work scope. Separate service instances and
dedicated connections belonging to that scope share the same in-flight owner.
Recovery joins the live operation, then rereads durable state and its deadline
before claiming an attempt. Rejected operations release ownership; no elapsed-time
lease, new table, polling loop, or transaction around filesystem work is added.
This is process-local ownership within the existing supported writer model, not a
cross-replica lock. Persisted candidates still reconstruct after process restart.

Regression evidence against owner head d1a7c64c8b03ada0741c7c5ebb8ff9cb5190479b:
- The six-case real-save barrier regression failed in five cases before the fix:
  attempts advanced from one to two while foreground file replacement was held.
  The shared-service success case passed; the result is not described as six failures.
- With the fix, all 38 instruction-copy tests and 14 heartbeat helper tests pass.
  Tests cover successful and failed foreground saves across shared, separate, and
  dedicated-connection services, a two-minute held operation, the preserved retry
  deadline, eventual canonical bytes, and exactly one file-update activity receipt.
- All 87 persistent agent-directory tests pass on a separate fresh PostgreSQL
  database, covering the existing directory consumer of the collection boundary.
- Server typechecking passes with the expanded regression tests.
- Four embedded-only heartbeat integration cases were skipped by their existing
  support gate; they are not included in the 139 passing cases above. This is not
  evidence of full repository CI or deployed host/database suspension.

## Retry fixture timing correction (2026-10-27)

A later CI run exposed a test race, not a different production retry policy.
The attempt counter is written before filesystem replacement completes. The old
attempt-cap test waited for that counter, advanced a fixed 31 seconds, and could
move the clock before the pending save recorded its next retry deadline. It then
expected attempt three before that newly recorded deadline was due.

Holding the second filesystem replacement across that clock advance reproduced
the exact CI assertion: expected three attempts, received two. The test now waits
for the completed attempt's persisted deadline and advances to that deadline.
It retains the deliberate slow-save barrier, the three-attempt cap, the original
canonical bytes, the captured candidate, and the absence of later retries. The
captured-commit group also retires its own company fixture during teardown, so a
failed test cannot leave retry debt in the next test's global reconstruction.

All 38 instruction-copy cases pass on a fresh PostgreSQL 17 database with the
owner branch's 396 migrations. The controlled reproduction fails without the
fixture correction. No production retry code, timeout, or assertion is weakened.


## Current parent composition and acceptance (2026-10-28)

The existing slice was integrated with the updated cancellation parent
`d9da519b32bd7e5ecaf2156c3de217fc47187f50` by a normal merge, yielding
`77cd93fa08310ecdc834964e9a4326f794c2be87`. All substantive owned edits remain
identical after excluding unchanged context and hunk coordinates. The literal
patch comparison initially rejected the updated context; zero-context comparison
and inspection establish that the edits themselves are unchanged. Every unrelated
upstream blob is preserved. The entire database source tree is identical to the
parent: this slice has no migration or table.

All six complete files passed, **268 cases with no skips**, in 46.26 seconds:

| Complete file | Passing cases |
| --- | ---: |
| Instruction working copies and captured commits | 38 |
| Persistent agent directory working copies | 87 |
| Server startup and feedback export | 53 |
| Heartbeat instruction-copy boundary | 14 |
| Heartbeat recovery | 45 |
| Heartbeat run lifecycle | 31 |

Instruction copies, directory copies, and recovery each used a separate newly
created PostgreSQL database migrated through the current 0404 parent history
before fixture setup. The lifecycle suite retained its real embedded database.
No reused filesystem database, skipped suite, increased timeout, or narrowed
case-name selection is counted as acceptance. The earlier failures above remain
part of the record.

Database build, production server typecheck and build, module boundaries, target
migration-order validation, and all three fresh migrations passed. File collection
and replacement stay outside the short pending-state transaction. Foreground
ownership, the persisted next deadline, attempt cap, authorization, exact-byte
receipt and drain/shutdown contracts retain their owners. No provider turn is
started to replay captured bytes.

This is local worker and integration evidence. Final publication must carry the
actual landed parent ancestry, followed by fresh current-head CI and review.
It does not establish host or database suspension or a durable Cloud alarm.


## Review style correction and interrupted CI

Greptile reviewed `cffe70b42b7b41f0b69c548dc47b8f1d5b753de5` at 5/5 but left
an actionable P2: CONTRIBUTING.md prohibits new code comments. Seven new
comment lines in the instruction-copy owner and tests are removed. The
foreground ownership, attempt-cap barrier and fixture isolation explanations
remain in this audit. TypeScript parsing verifies that both affected files have
exactly the same non-comment token stream before and after removal. All other
source bytes remain unchanged; this does not reinterpret the 268-case source
acceptance as a new whole-suite run. Fresh head CI and Greptile are required.

The first cffe CI server shard 9 stopped after receiving a runner shutdown
signal at 23:50:45Z, then reported cancellation at 23:50:57Z. It has no final
assertion verdict and is not counted as passing. The log is retained; no old-head
retry is requested because the required style correction creates a new head.
The full new-head CI must run independently.

## Current master and append-only parent adoption

The parent retry-cancellation slice now carries actual #17666 squash
`7afee8f0622e273d10506b0febfb68f143d168b1`, the new Coordinator and Runner
changes, and the regenerated append-only migration 0406. A clean normal merge
preserves both complete added/removed patches and every unrelated upstream blob.
The complete database subtree equals parent
`48b3fcb83f305616df02a4337a42ec0867bb4b80`; this slice adds no migration.
The parent audit follow-up changes documentation only.

Source `654c4694d5fad8ebfcc1219bc4a76ec94f4516b8` passes all **268 cases in six
complete files**, with no skipped cases, in 45.38 seconds. Four separate fresh
PostgreSQL 17 databases migrated through 0406 prevent fixture interference.
Instruction, directory, and recovery suites use their supported external paths.
The embedded-only lifecycle suite temporarily used its own external fixture
because this host cannot start more embedded clusters. Its fixture import was
restored byte for byte afterward. All assertions and original timing limits were
unchanged. This is qualified external-database acceptance; fresh CI still must
pass with the original embedded fixture. Database build, server typecheck/build,
module boundaries, target migration order, and all four fresh migrations pass.
No new code comments remain relative to this parent.

Prior head `a1a0ae5b02e8a650408bf4c55ae99071c3bff59c` had passing CI, Greptile
5/5 and Ponytail 5/5. Those results become historical when the new head is
published. Keep the old runner interruption and all earlier failures in the
ledger. The current parent must merge first, and the new published head needs
fresh exact-head reviews and CI. These results do not establish deployed sleep.

### Local validation command correction before publication

A cloned local runner selected its first command by position, but this slice's
first command was the database build rather than migration order. It replaced
the build with a pnpm filter that matched no projects and exited zero. That was
not evidence of a database build. The migration-order command also retained old
revision arguments. The next unpublished slice exposed the error when its first
fresh migration could not find compiled migration assets. Publication stopped.
The original command receipts and logs remain; no product pass is inferred from
the no-match command or the failed migration.

The runner now selects commands by their names. It executed the actual database
build and migration check against the exact current parent and head. The full
six-file acceptance then ran again at audit-only descendant
`b25636e6261f98f1e53ff28a1f259ea03b9c41a8`: **268 cases pass without skips in
40.97 seconds**, using four new disposable databases migrated through 0406.
Types, server build, boundaries, and the actual current migration-order check
also pass. The lifecycle fixture qualification above still applies; the file was
restored exactly. The already-published parent used a different, correct command
layout and was not affected by this runner error.

## Bounded retry-cancellation parent acceptance

A clean normal merge adopts published parent
`405e533394b26215e22d0452e9b0207d3f784a79`, including its bounded reconstruction
and durable browser reply check. Both complete added/removed patches and every
unrelated upstream blob are preserved. The entire database subtree still equals
that parent: this slice has no schema or migration change.

Source `9fb75e508f06b05b740099403ce021a61e7c6603` passes all **268 cases in six
complete files**, without skips, in 41.89 seconds. Four unused fresh PostgreSQL 17
databases migrated through 0406 isolate the fixtures. The same qualified temporary
external lifecycle fixture is restored byte for byte. Actual database build,
server types/build, module boundaries and exact-current migration order pass.
The earlier local runner failure and corrected evidence remain in the preceding
section; this run uses commands selected by name.

Stacked publication may run this non-migration slice's independent CI while the
parent finishes. It does not allow merging into an unmerged parent. At merge,
the exact reviewed parent must have landed, the target must be master, and the
actual combined tree must preserve the complete owned patch and upstream changes.
The subsequent index-bearing child still needs the actual parent migration squash
ancestry before publication. Old reviews on this slice's prior head do not count
for the new published head.

## Landed retry-cancellation squash ancestry

Parent #17667 merged as `27270e9bf8b7a294cf03f8b84f4857f1b1ff05c7` after
all 58 checks and both current-head reviews passed. Its entire tree equals the
already-adopted reviewed parent `405e533394b26215e22d0452e9b0207d3f784a79`.
The ordinary merge probe still found nine overlapping text conflicts from the
squashed ancestry. A normal merge records that actual ancestry. The exact parent
was already an ancestor of the accepted descendant; restoring the accepted
versions of the inspected conflicts leaves the **entire result tree identical**
to the previously published `fc5cee9fa00923a2d6fba27386ad7a6ab0ef101e`.
This proves all automatic and manual resolutions preserve tested code and parent
changes. The follow-up here changes documentation only. The 268-case source
acceptance and database proofs remain applicable, but the new SHA needs fresh
CI and exact-head reviews. Prior stacked-head results are not reused as passes.
