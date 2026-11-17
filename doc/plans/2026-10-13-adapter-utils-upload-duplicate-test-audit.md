# Command-managed-runtime upload duplicate retirement — 2026-10-13

## Scope and baseline

- Base: `418eb4623ae767b5c9ce28c1c3e9fcb98f63702e`, the head of [PR #16173](https://github.com/paperclipai/paperclip/pull/16173).
- Branch: `codex/test-audit-r19-adapter-utils-upload-case`, stacked on `codex/test-audit-r18-worktree-config`.
- Production owner: `createCommandManagedRuntimeClient().writeFile` in `packages/adapter-utils/src/command-managed-runtime.ts`. `prepareCommandManagedRuntime` constructs this client for command-backed adapter staging and fallback sync operations.
- Owner file: `packages/adapter-utils/src/command-managed-runtime.test.ts`.
- Method: [OpenClaw test-audit](https://github.com/openclaw/openclaw/blob/main/.agents/skills/test-audit/SKILL.md), its audit workflow, owning-boundary guide, and proof policy.
- Required repository guidance, contributor rules, roadmap, and PR template were consulted. GitHub searches for the exact case and upload-test consolidation found no duplicate retirement. Related adapter audit: [PR #16115](https://github.com/paperclipai/paperclip/pull/16115).

## Retirement and retained proof

Retire only `test_single_stream_writeFile_collapses_roundtrips_under_96MiB`, originally at line 921. It was added in `030dd9d15c` ([PR #10340](https://github.com/paperclipai/paperclip/pull/10340)) as Research A1 proof for the single-stream round-trip reduction. Its two real-shell uploads duplicate the existing transport owner cases.

Before removal, strengthen the existing single-stream case at line 462 from 3 MiB to 9 MiB. This preserves the retired case's exact size witness. Its payload still contains every byte value, and it still checks exact file bytes, two total shell calls, cleanup, stdin transport, monotonic progress, and final progress. Change the existing base64 guard to allow exactly a 9 MiB source buffer. The guard checks decoded buffer length, not the resulting string length.

The production threshold is **96 MiB of encoded base64**, not decoded payload bytes. A 9 MiB payload encodes to 12 MiB. Reverting to chunked uploads for this witness fails the surviving exact two-call assertion. Neither the retired case nor this keeper proves the exact 96 MiB boundary or the above-threshold branch.

Strengthen the existing 12 MiB chunked-progress case from `calls.length > 2` to `3 + Math.ceil(payload.byteLength / (3 * 1024 * 1024))`: seven total shell calls. The three fixed calls initialize the staged file, rename it, and clean it up. The remaining four calls upload decoded 3 MiB chunks. Its binary-byte, bounded-stdin, monotonic-progress, and final-progress assertions stay intact. This is the retired chunk-count formula applied at the surviving larger payload.

The 10 MiB partial-final-chunk case, omitted-capability case, cleanup-failure case, and all 22 other cases stay byte-for-byte unchanged. The retired cross-case greater-than assertion is implied by the retained exact counts of two and seven.

## Cost and lines

- Remove one case: owner file goes from 28 to 27 cases.
- Remove the 23-line declaration and its following blank line. Four existing lines change. Git reports 4 added / 28 removed physical test-file lines: net **24 fewer physical lines**.
- Production LOC and support LOC change: zero. This receipt is the only additional tracked file.
- Retired fixture performed eight real shell invocations: two single-stream and six chunked. Growing the surviving single-stream payload adds no invocations. Net reduction: **eight shell invocations**.
- Retired fixture uploaded 18 MiB. Growing the keeper adds 6 MiB. Net reduction: **12 MiB of decoded upload payload** per owner run.
- Prior three-file adapter-utils audit baseline: 87/87 passed. The retired case cost 228.125125 ms. Its original 3 MiB keeper cost 51.266500 ms.
- Candidate 9 MiB keeper cost 163.982042 ms. Prior owner duration: 1,495.937988 ms; candidate owner duration: 1,979.989990 ms. These are separate host runs, not a controlled performance comparison. They do **not** establish a suite speedup. The deterministic process and byte reductions are the supported savings.

## Validation

- `pnpm exec vitest run packages/adapter-utils/src/command-managed-runtime.test.ts --maxWorkers=1 --reporter=json --outputFile=/private/tmp/test-audit-r19-command-managed-runtime-candidate.json`: **27/27 passed**. Recorded command wall time: 7.421 s, including collection and startup.
- `pnpm --filter @paperclipai/adapter-utils typecheck`: passed.
- `git diff --check`: passed.
- Exact diff inspection confirmed the encoded threshold semantics and fixed overhead in the chunk count. A declaration comparison confirmed exactly one removed case, exactly two changed keepers, and all other 25 cases byte-for-byte unchanged.
- No production mutation experiments ran. No production code, dependencies, contracts, UI, or CI routing changed.
- Repo-wide typecheck, test suite, and build were not run locally for this narrow retirement. This is focused owner proof; broad CI gates and review remain pending before merge.

## Risk and disposition

Low risk with directly retained owner proof. The larger single-stream fixture costs more than the original 3 MiB keeper, and timing savings are modest and unproven at suite level. Independent transport, capability-default, partial-chunk, progress, atomic rename, and cleanup contracts remain. Open a stacked PR for review; do not merge.
