# Pipeline bulk review test audit — 2026-10-13

## Scope and parent

This change owns only `server/src/__tests__/pipelines-routes.test.ts` and this receipt. Its exact parent is `e09990e009b1042c9fff212e24429a732853c324`, the current head of [PR #16175](https://github.com/paperclipai/paperclip/pull/16175), on `codex/test-audit-r19-adapter-utils-upload-case`. The dedicated branch is `codex/test-audit-pipeline-bulk-fixture`. No production file, lockfile, workflow, or held audit branch is changed. Do not merge this PR.

## Repeated fixture and retained proof

`bulk reviews partial successes without aborting stale items` previously created 50 independent cases and transitioned each to review. Rows 0–2 then received stale versions. Row 3 requested changes. Rows 4–49 all approved an otherwise identical case.

Keep rows 0–4. Change the fixture bound from 50 to 5 and the successful result count from 47 to 2. Preserve the HTTP 200 response, all three failures, every failure's `version_conflict` code, and the persisted request-changes stage `in_progress`. Add a persisted `done` stage assertion for row 4 after the bulk response. Thus both success paths still execute after multiple stale failures. The same actor, company, pipeline stages, versions, and complete request shape are retained.

This removes 90 setup HTTP mutations and 45 per-item review service calls. The new approval-detail read makes the net difference 134 operations. This is an operation count, not a measured time saving. The owner retains all 19 test cases. Test source changes by four inserted and two deleted lines; it gains two net lines.

## Historical intent and limits

Commit `43b005b704f80aea3ce37cab8136920749c73ee6` introduced the same fixture in [PR #7903](https://github.com/paperclipai/paperclip/pull/7903). Its title and assertions describe partial success. The introduction records no stress-test requirement or timing target. Both the original schema and current `server/src/routes/pipelines-schemas.ts:134` limit bulk review to 100 items. The 50-row fixture is not that limit.

The current route at `server/src/routes/pipelines.ts:827` processes each item independently and catches each item's error. `reviewCase` receives no batch-size input. Cases in this fixture have no parent, blocker, or linked execution relationships. Rows 5–49 differ only in unique case key/title/id and repeat row 4's approval input state.

A cross-check of all named pipeline tests in server, CLI, UI, shared, DB-schema, and tutorial E2E code found no independent 50-item bulk-review contract. The owner has explicit event-pagination and large-history tests at lines 727 and 776. Those tests remain unchanged. The original bulk fixture gave incidental medium-batch execution coverage; the smaller fixture preserves its asserted functional proof.

## Local validation and database blocker

Local database tests and production mutations were deliberately not started. The host still has 31 allocated SysV shared-memory IDs against `kern.sysv.shmmni = 32`. A prior isolated initdb failed with `could not create shared memory segment: No space left on device`. One remaining slot is not clear test headroom. No global IPC resource or other owner's process was changed.

Passed: `pnpm --config.manage-package-manager-versions=false --filter @paperclipai/server typecheck` (exit 0), including required Runner vendor and shared/plugin build dependencies. Passed: TypeScript AST/syntax validation, all 19 cases retained, all other 18 declarations AST-equivalent, and reversal of the two scalar edits plus the two added assertion lines exactly reconstructs the original test bytes. Passed: `git diff --check` and exact two-file scope review. Production source remains unchanged. The server typecheck excludes test files; the AST/syntax check separately covers this test edit.

Local owner, sibling, full tests, mutation proofs, and causal timing remain unverified. The authorized stacked PR delegates owner/sibling runtime validation to hosted CI. Repo-wide local tests and build were not run because the request permits non-DB verification and requires avoiding local database tests.

## Exact parent CI baseline

[PR CI run 38411804432](https://github.com/paperclipai/paperclip/actions/runs/38411804432) tested the exact parent SHA. Its [serialized shard 4/9](https://github.com/paperclipai/paperclip/actions/runs/38411804432/job/115345896667) passed the owner with 19 tests:

- Bulk-review case: 1,134 ms.
- Owner tests and hooks: 4,239 ms.
- Owner Vitest duration: 24.60 s.
- Serial owner interval between suite-start markers: 25.519 s.
- Shard test window from its start banner to final suite duration line: 309.323 s.
- Full job interval from GitHub check timestamps: 375 s.

The [general server shard 12/12](https://github.com/paperclipai/paperclip/actions/runs/38411804432/job/115345897543) passed `pipelines-service.test.ts`, 32 tests, 4,272 ms for tests and hooks. Its grouped execution makes an isolated owner-duration comparison unavailable from that completion line alone.

The old serialized manifest weight is 20,408 ms, sampled on September 12. The general manifest sibling weight is 13,114 ms, averaged on October 10. These weights are historical balancing inputs, not a local baseline or a causal estimate of this change.

Capture candidate owner/shard logs from hosted CI and compare with this parent. Report tests/hooks, isolated owner duration, serial marker interval, and shard/job intervals separately. Unchanged sibling/neighbor costs can help expose runner variability. A single parent/candidate CI pair cannot establish causal speedup; transforms, imports, scheduling, runner load, and startup dominate owner wall time. The PR's Verification section and follow-up report will carry the candidate result once available.

## Deferred mutation proof

When local capacity permits, use the original and candidate bulk case with a clean owner/sibling run. Deliberately abort the bulk loop on the first stale item, and separately stop before the final retained approval. Require failures at the intended partial-success and approval assertions. Restore production byte-for-byte after each mutant. These mutation experiments are not claimed as completed by this PR.

Model: OpenAI `gpt-6.1-sol`; context window unavailable; repository analysis, shell tooling, TypeScript AST inspection, and non-DB verification.
