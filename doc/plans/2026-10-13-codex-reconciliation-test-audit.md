# Codex crash reconciliation test audit

Base: `c1ae082a7a49c239a22e5149e223a41325b0ba2d` (CLI ZIP content uploaded as PR #16118).

Remove only `requires reconciliation for a classified Codex harness crash`,
`server/src/__tests__/heartbeat-retry-scheduling.test.ts:2034–2059`.
Saving: **26 test lines and one registered execution**. No runtime reduction is
claimed. Keeper: `requires reconciliation for an error-code-only Codex harness
crash`, originally lines 2061–2086 (candidate 2035–2060).

## Static preservation evidence

The full fixture helper at lines 186–253 writes the classification only into
`heartbeatRuns.resultJson.errorFamily`. Both cases then update that run with
`resultJson: null` before `heartbeat.scheduleBoundedRetry`. Both persist the same
Codex adapter, active agent, failed status, harness-crash error code, zero retry
attempts, context shape and company defaults. They call with the same random
callback and identical relative `now`/created/updated/finished timestamps. The
remaining absolute 12:00 versus 13:00 difference enters no clock comparison with
another fixture; no retry deadline, active holder or evidence receipt is seeded.

Both have one identical literal disposition/code assertion:
`{ outcome: "not_scheduled", errorCode: "legacy_execution_requires_reconciliation" }`.
No unique assertion needs transfer. The retained error-code-only keeper correctly
names the effective input. The classified title no longer reflects classification
coverage after its result JSON is erased.

Production: the exported heartbeat facade delegates `scheduleBoundedRetry` to
`server/src/services/heartbeat/retries.ts:1835–1850`, which loads the persisted
run with full result JSON and enters `scheduleBoundedRetryForRun`. The real
reconciliation guard is at line 501. Its classifier in
`server/src/services/legacy-execution-recovery.ts:20–64` requires reconciliation
for failed legacy runs without safe bootstrap evidence. Its decision does not
consult error family. The subsequent scheduler would create an actual queued
wake and scheduled-retry row if that guard were bypassed. It does not launch the
provider during this call.

Non-test callers include run completion (`heartbeat/run-completion.ts:859,
1412`), recovery (`heartbeat/recovery.ts:405`), scheduling
(`heartbeat/scheduling.ts:668`) and the heartbeat facade. The existing general
server CI lane owns this test file; the recorded duration inventory lists it.
No new export, injection seam, workflow, production, telemetry or timeout change
is needed.

History: commit `665408c6d01` (PR #10210) added two genuinely different retry
classification cases on 2026-07-24. Commit `35fdc0c66b8` (PR #13075) on 2026-09-09
renamed both to reconciliation cases, reset both result JSON values and replaced
both original assertions with the same reconciliation expectation. That change
collapsed their original classification distinction.

Excluded files from #16114/#16115/#16116/#16075 and the completed UUID-assignee
candidate are untouched. Recent audit receipts contain no prior retirement of
this pair. All test bytes outside the one removed body stay identical.

## Complete proof on the exact child base

| Complete owner/sibling phase | Passed | Failed | Skipped |
|---|---:|---:|---:|
| Baseline | 66 | 0 | 0 |
| Candidate | 65 | 0 | 0 |
| Full revert | 66 | 0 | 0 |
| Restored candidate | 65 | 0 | 0 |
| Final production restore | 65 | 0 | 0 |

The integration owner has 52 cases before and 51 after. The unchanged extracted
retry sibling has 14 cases. All phases run serially in this isolated worktree on
exact parent `c1ae082a7a49c239a22e5149e223a41325b0ba2d`. No test execution overlaps
the ZIP proof; a process scan confirmed its test processes had exited first.

```sh
node node_modules/vitest/vitest.mjs run --project @paperclipai/server server/src/__tests__/heartbeat-retry-scheduling.test.ts server/src/services/heartbeat/retries.test.ts --exclude '**/dist/**' --pool=forks --maxWorkers=1
```

The unmutated selected keeper passes 1/1. The actual mutation replaces the one
`if (await legacyExecutionNeedsReconciliationWithEvidence(db, run))` guard at
`server/src/services/heartbeat/retries.ts:501` with
`if (false && await legacyExecutionNeedsReconciliationWithEvidence(db, run))`.
The same keeper then fails at its exact disposition/code matcher on candidate
`heartbeat-retry-scheduling.test.ts:2057:23`. The real scheduler returns an actual
scheduled successor instead of the required reconciliation result. That run
exits 1 with exactly one selected failure; the other 50 cases are filtered out
and are not claimed as complete coverage. The production file is restored
byte-for-byte before the final complete 65/65 run.

Selected command: the integration file only with
`-t 'requires reconciliation for an error-code-only Codex harness crash'`.
The harness adds default and JSON reporters and a separate output file per phase.
Whole-file byte-slice equality proves every test byte outside the single removed
body is unchanged. No assertion transfers or production edits are committed.

## Setup recovery and practical limits

The first child baseline was rejected: 11 non-database cases passed and 55
cases skipped because Postgres could not create its 56-byte SysV tracking
segment. An isolated initdb diagnostic confirmed shared-memory-ID exhaustion;
`kern.sysv.shmmni` was 32 and all 32 IDs were occupied. This was not a test failure
or disk-space failure.

The authorized guarded recovery removed 18 stale segments. For each segment an
immediate `ipcs` read confirmed NATTCH=0 and a process scan confirmed both creator
and last-user PIDs absent. All 14 attached segments were preserved. No live
Postgres process was stopped, and no kernel limits were changed. Before/after
state and per-ID checks are saved in the proof packet's `ipc-cleanup.json`.
The exact baseline retry succeeded, followed by all accepted controls above.
The rejected setup run is preserved in `rejected-baseline-shm/`.

This worktree uses its own frozen offline dependencies, native Postgres package
symlink hydration, and shared/SDK build prerequisites. The successful source
removal is 26 lines and one execution; no CI wall-time improvement is claimed.
`git diff --check` passes. Broad typecheck/build and unrelated suites were not run
for this narrow test deletion. CI, GitHub duplicate search and reviewer gates
remain open. Related prior audit: PR #16075; its files are excluded here.

Model: OpenAI `gpt-6.1-sol` (GPT-6.1-Sol); context window unavailable. Tool use and
code execution supplied the source inspection and proof.

Original test SHA-256: `92425b672e93810e0de2d21efdcb65c902b1c90926fee2a941322445172a65fe`.
Candidate test SHA-256: `1fcad08c3af36e539e7f2c62d706605f65a70c9394026b0beb4ffb8aecc7c867`.
Unchanged sibling SHA-256: `ad98a02f6112a21a8975235db6a9dec227020221bf048c8dfcbdbb55c6ce2047`.
Restored production-owner SHA-256: `9f29feb6d986f281cbfd849e0152f49cf56e18974c6df1bc801010dcce4c877a`.

Full commands, source hashes, phase JSON/logs and exact failure stack:
`/private/tmp/codex-reconciliation-child-proof/receipt.json` and sibling files.
