# Heartbeat recovery test audit — 2026-10-12

Parent: #16086 (`codex/test-audit-r15-environment-runtime`), exact head
`c0414ac02e625a1e635857895b74581c37201500`.

## Change and keeper

The standalone `re-enqueues continuation for stranded in-progress work with no active run`
case at `heartbeat-process-recovery.test.ts:11192–11221` repeats the existing
`re-enqueues stranded in-progress work after a failed/process_lost run before escalating`
table row at 10360.

Both call `seedStrandedIssueFixture` with `status: in_progress` and
`runStatus: failed`. The standalone test omits `runErrorCode`; the helper at 1132–1136
persists `process_lost` as its default. The table supplies that same value.
Every other supplied argument, default, and owner action matches. Generated
record IDs vary between independent fixture runs.

Move five unique assertion lines into the keeper: a truthy retry ID and
`{ status: scheduled_retry, scheduledRetryAttempt: 1 }`. Existing keeper checks
retain zero dispatch, one continuation, no escalation, exact issue IDs, two
agent runs, `transient_failure`, and absent `modelProfile`. The keeper also
checks source task/run binding, no recovery children, and eventual settlement.
The failed/adapter_failed and timed_out/adapter_timed_out rows remain and gain
the durable retry assertions.

One test file: +5/−31 lines, net 26 fewer test lines. One registered execution
is retired (399→398). This is execution retirement, with no production change.
Crash/restart, ownership, cancellation, persistence, retry-budget, and failure
isolation contracts remain. No CI time saving is claimed from local samples.

## Exact-parent sequential proof

| Phase | Passed | Failed | Filtered/pending |
|---|---|---|---|
| Full baseline | 399 | 0 | 0 |
| Full candidate | 398 | 0 | 0 |
| Full revert | 399 | 0 | 0 |
| Temporary production mutation, exact keeper | 0 | 1 | 397 |
| Owner restored, full candidate | 398 | 0 | 0 |

The mutation changes the real scheduler write at `heartbeat/retries.ts:1049`
from `schedule.attempt` to `schedule.attempt + 1`. The exact keeper fails at
the moved retry-state assertion, candidate line 10386, expecting attempt 1 and receiving 2. Only that keeper is
selected; other cases are filtered. The persisted attempt feeds durable
failure-retry accounting in `execution-recovery-attempt.ts:40–49`.
The recovery/scheduler owner is not mocked. The mutation is absent from this PR.
After restoring the owner, all 398 candidate cases pass. Both source files were
then restored byte-for-byte and the checkout was clean before branch creation.
The final patch is the exact candidate bytes that passed restoration.

Runtime-title comparison removes only the standalone registration and adds
no cases. The original full-file ledger contains 249 declarations / 399 runtime
cases; the candidate has 248 / 398. All declarations were reviewed. Near-overlaps
with different queued wakes, timer claims, continuation ancestry, or crash points
were retained.

```sh
PAPERCLIP_HOME=/private/tmp/r16-hbr/h \
PAPERCLIP_CONFIG=/private/tmp/r16-hbr/h/config.json \
PAPERCLIP_INSTANCE_ID=heartbeat-recovery-audit TMPDIR=/private/tmp/r16-hbr/t NODE_ENV=test \
node node_modules/vitest/vitest.mjs run --project @paperclipai/server \
server/src/__tests__/heartbeat-process-recovery.test.ts --exclude '**/dist/**'
```

Full repository typecheck/build/test preflight is delegated to isolated CI,
as in the parent audit. The local worktree uses shared external dependency
symlinks, and preflight rewrites workspace links. Every CI gate must pass
before a green handoff. The full owner uses the checked-in server configuration
and its real embedded Postgres.

## Hashes and receipts

- Parent test SHA-256: `bf7c888eaba44a56d12823bb948026d5db44f2249a75a6cf083343edbd7c0673`.
- Candidate test SHA-256: `645fd53b52e513e97c83f1e074dc1bded0749be18fb086138d154c19ea18d1d6`.
- Restored production retry owner SHA-256: `9f29feb6d986f281cbfd849e0152f49cf56e18974c6df1bc801010dcce4c877a`.

Machine receipts are in `2026-10-12-test-audit-r16-heartbeat-recovery-controls.json`.
Full JSON/log output, patch, exact keeper map, and whole-file ledger are in
`/private/tmp/r16-heartbeat-recovery/`. The earlier read-only discovery is in
`/private/tmp/heartbeat-recovery-full-audit/`. This parent replay uses fresh
sequential controls; it does not reuse the earlier parent proof.

Model: OpenAI `gpt-6.1-sol`; the host does not expose its context-window size.
