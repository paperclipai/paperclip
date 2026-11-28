# Native pending status-effect recovery

Branch: `codex/sleep-47-native-pending-effects`.
Current published parent: #17687, `b28399babac72ba9db1c4a4ef882c5e87aded38c`.
Original draft parent: `b9fe9e2e40ab48104cf18822b5302a740d1957a7`.
Status: implemented and locally verified; remote PR acceptance remains required.

## Duty and existing ownership

The native finalization reconciler reads pending/failed `status_decision_effects`
for each candidate's current decision before other finalization work. When any
exist, it calls `dispatchPendingNativeStatusEffects` and skips the remaining
candidate processing for that pass. This slice moves only that duty. Response
presentation, evidence reassessment, and accepted-result/workspace settlement
remain separate migrations.

The existing dispatcher owns the recovery transaction. It locks the coordinator,
checks the exact company/issue/run/decision binding, locks pending effects, and
checks that their materialized targets exist. It then marks the ledger delivered,
increments attempts, clears retry/error state, updates delivered-effect IDs, and
signals chat milestones. It does not recreate targets or arbitrate status again.
A missing target remains an error with an owned retry, never successful cleanup.

## Source of truth and scheduling

The only current production insert creates effect targets and delivered ledger
entries atomically in `commitNativeStatusDecision`. Both production effect-update
paths also settle to delivered. No current pending/failed producer was found.
Historical rows and the schema default still require recovery. Ordinary successful
commits therefore discover no pending-effects timer.

The worker reconstructs existing pending/failed effects belonging to the exact
current coordinator decision. It requires native runtime, an existing issue,
a saved result, and a phase other than terminal_failure. Superseded decisions and
terminal-failure history remain dormant. Its deadline is the later of the saved
coordinator retry and a held lease's expiry. An owner without an expiry preserves
the old reconciler's immediately eligible behavior. The ledger's nextAttemptAt
was not an eligibility fence in the old dispatcher and this slice does not invent
one. Actual errors use the shared bounded retry backoff.

Discovery uses keyset pages of 100. The existing scoped deadline helper coalesces
commit hints, handles dirty generations/drain/failures, and fairly dispatches 25
entries per batch. Empty, delivered, and dormant history leaves no recurring SQL.
The dispatcher rechecks eligibility under its existing coordinator lock so a
concurrent lease or retry extension cannot be bypassed.

Startup registration respects the existing maintenance toggle and task-drain,
shutdown, and warm-standby gates. Periodic finalization excludes pending-effect
candidates and retains a late pending-effect guard to preserve ordering. Explicit
and startup recovery retain the old dispatcher default. The remaining finalizer
can process a candidate after its effects settle; this slice does not remove its
other polling duties.

## Producer audit and shared boundaries

Notifications carry only company and optional run IDs. They register intent before
the write and use the existing outer-transaction/uncertain-outcome protocol.

| Mutation owner | Why it matters |
| --- | --- |
| Status decision commit/replay | Can restore the current decision and phase; new effects already delivered remain quiet. |
| Pending-effect dispatcher/materializer | Retires an existing obligation and refreshes remembered deadlines. |
| Preserved-result finalization | Reactivates accepted-result history. |
| Workspace export retry and historical export recovery | Restore accepted-result eligibility. |
| Persisted-attention replay | Rebinds an existing decision and clears its lease/retry. Its DB-only write now has an explicit transaction. |
| Finalizer claim and retryable failure | Claim can clear a later retry; failure releases ownership and changes the next retry. |
| Coordinator-store claim/renewal and retry | An existing owner can shorten its lease; release can move eligibility earlier. |
| Retained-session cleanup success/failure | Releases the coordinator lease. |
| Native execution failure/release | Can leave a saved result eligible and release its lease. The final DB-only release now has an explicit transaction. |
| Abandoned execution-control recovery | Releases ownership of an already accepted result. |

The audit enumerated 34 coordinator writes that change phase, result, decision,
lease, or retry fields, then inspected their guards. Provider execution claims,
restart recovery, session resumption, and stopped-execution checks reject saved
results or explicitly require resultId null. Terminal-failure writes disable
eligibility; safe replacement keeps that terminal phase. Retained cleanup claims
and normal session renewals only postpone eligibility, which is rechecked at the
remembered deadline. Claim/renewal paths that can shorten it are signaled.

The accepted-result insertion cannot expose an existing pending decision without
a result: schema checks require decision -> assessment -> result, and replay of
an existing accepted result returns before replacing the coordinator. Runtime-mode
writes occur in initial native preparation or the signaled status-decision owner.
Deleting records removes work; a scheduled lookup drops a missing candidate.

This remains the supported single-owner client notification model. Independent
SQL writes and other processes do not produce these local signals; startup can
reconstruct their durable records but this change does not add live cross-process
delivery. No new queue table, provider protocol, or host-sleep exemption is added.

## Query and migration evidence

Captured the actual worker SQL using the PostgreSQL client's debug hook. A fixture
added 10,000 delivered effects and 10,000 completed coordinators, with one eligible
pending effect. The committed fixture matters: an earlier rolled-back experiment
could not consistently use the newly built partial index under its old snapshot.

| Discovery | Existing indexes | Pending-effect index only | Both new indexes |
| --- | ---: | ---: | ---: |
| Global startup | 2.247 ms | 1.080 ms | 0.036 ms |
| Company scope | 1.807 ms | 1.048 ms | 0.015 ms |

Without the indexes, discovery filtered 10,809 delivered effects and scanned 10,353
coordinators. The partial effect index selects pending/failed rows; the partial
coordinator index resolves their current company/issue/decision owner. Both plans
used index access for those relations after the change. This fixture establishes
history cost for this query, not universal tenant-size or fleet performance.

Current migration 0411 uses concurrent IF NOT EXISTS index builds through the existing
nontransactional migration owner. Generated snapshots retain the newest five
(0407–0411). Fresh schema application, migration replay, direct SQL replay, and
valid/ready index checks pass. The first replay command failed before SQL because
the tsx evaluator rejected top-level await; the corrected promise-chain command
passed. Logs: `/tmp/sleep47-query-plan-committed.log`,
`/tmp/sleep47-migration-replay-v2.log`.

## Verification and remaining gates

The pre-change corpus passed 72 cases. Initial worker verification passed 86.
Two initial test failures compared epoch scheduler deadlines to Date objects;
the assertions were corrected and passed without weakening production behavior.
Worker/startup wiring passed 154 cases. The expanded owner and consumer selection
passed 680 cases across 15 files on fresh external PostgreSQL. Workspace types
and build passed. The later producer audit identified a shortened-lease signal
gap; its regression and final verification are recorded below before acceptance.

Tests exercise delivered/empty/terminal history quiet, pending/failed recovery,
no duplicate decisions or targets, missing-target failure, future retry/lease
quiet, concurrent deadline extension, real replay, outer commit/rollback, real
lease release, company-scope isolation, drain/resume, restart reconstruction,
103-candidate paging, and periodic/manual owner ordering. Existing consumers cover
finalization, export recovery, execution control, lifecycle, and chat delivery.

The full local suite is not claimed green. The parent attempt encountered embedded
PostgreSQL initialization failures and was intentionally stopped; that failure is
preserved in `/tmp/sleep46-full-tests.log`. This slice uses fresh external databases
for affected suites. Remote CI/review must pass at the final PR head. Actual host
or database suspension and the remaining recurring-server duties are not covered
by this worker's quiet proof.

## Final local acceptance

The real-store shortened-lease regression failed before the missing claim signal:
recovery waited beyond the old deadline. After notifying at the two claim owners,
the regression passes. A concurrently saved ten-second deadline now remains ten
seconds rather than being rounded up to the fallback retry. The saved lease-owner
check preserves SQL null semantics, including legacy empty-string owners.

The final worker/startup selection passes 158 tests (94 corpus, 64 startup),
including all 22 cases added to the corpus by this slice. The finalizer selection
passes 29 tests on a fresh database. A first rerun reused the TLM company-prefix
fixture and failed setup with companies_issue_prefix_idx; it did not pass, and
its log remains `/tmp/sleep47-owner-final.log`. The fresh rerun is
`/tmp/sleep47-finalizer-final.log`. Combined with unaffected consumer cases from
the 680-case run, 683 distinct cases have passed. The final worker log is
`/tmp/sleep47-deadlines-final.log`.

Final source verification: `pnpm typecheck` and `pnpm build` pass after the near-term
deadline repair (`/tmp/sleep47-deadlines-typecheck.log`,
`/tmp/sleep47-deadlines-build.log`). The final worker/startup run now passes 158
cases, giving 683 distinct passing cases with the earlier unaffected consumers.

## Remote acceptance

Published as [#17690](https://github.com/paperclipai/paperclip/pull/17690).
Exact head `56c3601ea605b333141e86e0a810ed790fb6ce48`: all 53 checks pass;
Greptile 5/5 with no actionable findings or review threads; mergeable parent.
The PR remains draft and unmerged. This accepts slice 47 only, not the full stack.

## Current migration411 integration and complete acceptance

Only this slice's unlanded 0403 migration artifacts were deferred before a
normal merge of the verified current unsafe-export parent. No conflicts occur.
The complete original runtime/schema patch and every unrelated upstream blob
are preserved. The migration directory and client matched the exact parent
before generation. `pnpm db:generate` produced `0411_real_scrambler.sql`. Both
concurrent, idempotent index statements are byte-identical to the original.
All earlier SQL, journal entries and retained snapshot bytes remain unchanged,
with five snapshots 0407 through 0411. No new code comments are added.

Source `ba38ee465df02b6026286b5d5e15ae49fe07a367` passes **2284 distinct
cases in 25 complete files**, without skips. The main selection passes 2225
cases in 203.94 seconds and safe-replacement passes 59 in 26.03 seconds.
The complete 94-case status-authority corpus then passes again on the same
database in 16.03 seconds. The repeat is not double-counted. Three preexisting
PSC/OUT/sentinel company rows remain unchanged in their inspected ID/name/prefix
fields after both runs; each invocation appends two distinct UUID-derived
fixture prefixes. Current per-file counts:

| Complete file | Passing cases |
| --- | ---: |
| src/__tests__/issue-recovery-actions.test.ts | 89 |
| src/__tests__/native-finalization-recovery.test.ts | 32 |
| src/__tests__/native-interaction-bridge.test.ts | 7 |
| src/__tests__/native-status-arbiter-corpus.test.ts | 94 |
| src/__tests__/native-workspace-sync.test.ts | 10 |
| src/__tests__/recovery-stale-issue-lock-sweep.test.ts | 40 |
| src/__tests__/server-startup-feedback-export.test.ts | 67 |
| src/__tests__/slack-conversation-lifecycle.test.ts | 41 |
| src/modules/run-dispatch/adapters/postgres.test.ts | 69 |
| src/modules/wake-queue/adapters/postgres.test.ts | 93 |
| src/modules/wake-queue/adapters/queued-comment-postgres.test.ts | 5 |
| src/services/execution-control-reconciliation.test.ts | 10 |
| src/services/explicit-native-continuation.test.ts | 335 |
| src/services/heartbeat/queue.test.ts | 32 |
| src/services/heartbeat/recovery.test.ts | 45 |
| src/services/heartbeat/run-control.test.ts | 51 |
| src/services/heartbeat/run-lifecycle.test.ts | 31 |
| src/services/heartbeat/upgrade-readiness.test.ts | 7 |
| src/services/legacy-execution-recovery.test.ts | 15 |
| src/services/native-runtime/native-restart-recovery.test.ts | 25 |
| src/services/native-runtime/native-run-finalizer-telemetry.test.ts | 29 |
| src/services/native-runtime/native-safe-replacement.test.ts | 59 |
| src/services/native-runtime/native-session-executor.test.ts | 968 |
| src/services/native-runtime/native-workspace-export-retry.test.ts | 80 |
| src/services/native-runtime/native-workspace-reconstruction.test.ts | 50 |

Twenty-one separate fresh PostgreSQL 17 databases migrate through 0411 before
setup. Four embedded-only fixture imports temporarily use their own external
database on this IPC-exhausted host and are restored byte for byte: interaction
bridge, workspace reconstruction, Slack lifecycle and wake-queue PostgreSQL.
All assertions and timing limits remain unchanged. Other suites use their
existing supported external-database paths. This is qualified external-database
acceptance, not an unmodified embedded CI reproduction. Actual database build,
server types/build, module boundaries and exact-head migration order pass.

A populated 0410-to0411 upgrade preserves all 409 prior migration receipts and
all 38 companies, appends exactly one receipt and appends none on replay. Both
partial indexes are valid and ready on fresh and upgraded databases. Earlier
failures above retain their original scope and causes. These checks verify
current worker and producer/consumer behavior, not deployed host/database
suspension, external Cloud wakes or fleet savings.

Normal merge `6cc9e0f4a05ac7aee225b8ac7dce119c31799257` adopts prepared parent
`d64d307484633485716124b24ad8bbdbea61f399`, carrying the published automatic-review
ancestry and parent documentation. Complete server, package, UI and test trees
remain identical to the accepted source, including the whole 0411 database
tree. Publication stays held for the actual unsafe-export prerequisite merge
and ancestry reconciliation. Fresh published-head CI and reviews remain required.


## Inherited CI correction checked in native-effect context

Normal integration `5f7cd7bc589ad0169dfb5f33df611ead56510ca3` carries the
upstream GitHub observation-bound correction and independent cleanup assertion.
Only those two previously unselected test files and parent audits change.
All production source, all packages including migration 0411, and all 25 files
in the accepted 2284-case selection remain byte-identical. That acceptance and
its 94-case same-database repeat retain their original source scope.

Both focused native-presentation GitHub idle variants pass in 15.26 seconds.
All six cases in the complete cleanup-removal suite pass in 8.47 seconds. Two
separate fresh PostgreSQL 17 databases migrate through 0411; supported external
URLs require no fixture source adaptation. The other 1779 cases in the large
chat file are outside this focused selection. The full parent 274-case workflow
is not claimed as executed here. The parent audit preserves the original CI
failure and controlled comparison, including its limit on exact CI causality.
Actual prerequisite ancestry and fresh published-head CI/reviews remain required.


## Published unsafe-export parent

Normal merge `01ff4da4457bf2afc3d2e5e65fa33c16d56a4e6f` adopts published prerequisite
`b28399babac72ba9db1c4a4ef882c5e87aded38c`, including the actual automatic-review
squash ancestry. Complete server, package, UI and test trees remain identical
to the accepted child. The whole 0411 database tree and all earlier acceptance
scopes remain unchanged. Publication remains held until the unsafe-export
parent lands and its actual ancestry is reconciled. Fresh current-head CI
and review are still required.


## Actual unsafe-export squash ancestry

Unsafe-export prerequisite #17687 merged as
`4e715eb7ea56d49a099530c3dce59e61e698077c`, reviewed at
`b28399babac72ba9db1c4a4ef882c5e87aded38c`. Its entire squash tree equals
the reviewed parent, which was already an ancestor of this prepared child.
Normal merge `45a1f20c8830efb0d60794f01fd7a5013ff41198` resolves duplicate
squash ancestry while preserving the complete held child tree byte for byte.
All accepted source, all migrations through 0411, and all earlier validation
scopes remain unchanged. The only following edit records this proof. Fresh
published-head CI and exact-head Greptile 5/5 are still required.
