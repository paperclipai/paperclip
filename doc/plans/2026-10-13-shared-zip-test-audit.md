# ZIP codec owner consolidation

Date: 2026-10-13. Exact local proof parent: `c1ae082a7a49c239a22e5149e223a41325b0ba2d`.

## Integrated PR scope

PR #16118 now includes the already-reviewed child rollup from #16119, which was
squash-merged into this branch. Its 47-file diff against #16116 also consolidates
adapter upload, DB migration, telemetry/access, server route/interaction/issue,
worktree and onboarding tests. It removes import-only native-runner aliases and
updates their generator/design ownership references. No production behavior or
exports change in this rollup. Each owner has its own dated receipt in
`doc/plans/`; this ZIP receipt documents only the original incremental ZIP proof.
Current-head CI and review cover the integrated PR; the focused historical counts
below do not stand in for integrated validation. Newer master legacy/native
adapter-selection regressions remain intact during the integration.

## Historical incremental ZIP scope

Proof parent is local CLI ZIP delivery commit `c1ae082a7a49c239a22e5149e223a41325b0ba2d`, the candidate for predecessor #16116. The original ZIP child changed only `packages/shared/src/portability-zip.test.ts` and this receipt. The parent already removed the CLI codec replay file and migrated nested blob classification, opaque ASCII blob and invalid archive bytes into shared keepers.

This child adds the exact Unicode path/text to that existing archive keeper, then retires two direct conversion cases. It contains no further CLI deletion and does not alter the predecessor PR. The final shared test bytes match the separately verified combined candidate based on #16075, but the controls below were rerun on this exact child parent.

## Candidate

Retire these shared direct-helper cases:

- `keeps blobs/ entries as base64 octet streams regardless of extension`.
- `decodes valid UTF-8 entries to text and falls back to base64 for invalid bytes`.

Their primary keeper becomes the existing shared `round-trips STORE, DEFLATE, and base64 blob entries byte-exactly and strips the shared root` case. The archive keeper calls the real conversion function through the real reader. It now contains:

- Opaque blob bytes `[0x68, 0x69]`, which must become base64 `aGk=` despite being valid UTF8. This is stronger classification evidence than the removed invalid-byte fixture, which could produce base64 through the decoder fallback after classification broke.
- The exact retired Unicode input, path and expected output: `tasks/pap-1/TASK.md` and `# Notes\n\ncafé ✅\n`.
- Invalid non-blob bytes `[0x68, 0x69, 0xff, 0xfe, 0xc0]`, expected as base64 `aGn//sA=` at `notes/raw`.

The shared classifier also retains the CLI's unique nested-path negative, `blobs/nested/file`, in addition to its original positive and negative paths. Existing STORE, DEFLATE, root stripping and all ZIP security/default/limit cases remain. CLI filesystem filtering and transfer tests remain.

## Reproducible proof

Incremental test diff: 2 added, 23 removed, **21 net test lines removed**. Two registered shared conversion cases are retired. Shared cases go from 15 to 13. Production reduction is zero. `git diff --check` passes.

| Complete-file positive phase | Shared owner |
| --- | --- |
| Untouched parent baseline | 15/15 |
| Incremental candidate | 13/13 |
| Shared test file fully reverted | 15/15 |
| Restored incremental candidate | 13/13 |
| After production mutations restored | 13/13 |

All complete-file positive controls have zero failed, skipped/pending and todo tests. Runs were serial. No active Vitest or Playwright process remained when the supervisor released the test slot. No baseline failures were hidden or disabled.

From a dependency-ready checkout, run the complete owner command for each baseline/candidate/revert/restored phase:

```sh
node node_modules/vitest/vitest.mjs run --no-file-parallelism --maxWorkers=1 \
  packages/shared/src/portability-zip.test.ts
```

CLI transport was not rerun for this incremental child. This child does not touch transport files or production code. The separate combined proof on #16075 recorded 18/18 transport cases before, with and after the same final shared test bytes. Those results are related evidence, not exact-child test results.

## Production falsification and restoration

All four mutations change `packages/shared/src/portability-zip.ts` and are restored byte-for-byte separately. Focused negative controls each select one case, fail that case and skip 12 unrelated cases. Failures reach the selected keeper assertion. The same final test and production bytes also produced the detailed observation diffs in the separate combined proof.

1. Broaden `/(^|\/)blobs\/[^/]+$/` to `/(^|\/)blobs\/.+$/`. Run the shared owner with `-t 'matches blobs/'`. `blobs/nested/file` fails: expected false, received true.
2. Change `if (isBlobStorePath(pathValue)) {` to `if (false) {`. Run with `-t 'round-trips STORE'`. Opaque blob output becomes plain `"hi"` instead of base64 `{ data: "aGk=", encoding: "base64", contentType: "application/octet-stream" }`.
3. Change archive conversion `body: bytesToPortableFileEntry(archivePath, entryBytes),` to `body: isBlobStorePath(archivePath) ? bytesToPortableFileEntry(archivePath, entryBytes) : textDecoder.decode(entryBytes),`. Run with `-t 'round-trips STORE'`. `notes/raw` becomes lossy `"hi���"` instead of base64 `aGn//sA=`. Opaque-blob behavior remains intact, so this witnesses the invalid non-blob archive contract.
4. Change `return Buffer.from(text, "utf8").equals(Buffer.from(bytes)) ? text : null;` to `return text.normalize("NFD");`. Run with `-t 'round-trips STORE'`. The Unicode text fails its exact comparison: composed `café` becomes decomposed `café`. This proves Unicode bytes remain protected after retiring the direct conversion cases.

Final restored production SHA256 matches the original. The final complete shared owner control passes 13/13. Repo-wide typecheck, tests, build, CI and reviewer checks remain pending; no PR-ready claim is made from this focused proof.

## Ownership, history and routing

Production consumers remain in CLI `resolveInlineSourceFromPath`, `resolveChunkedImportZip`, folder conversion/filtering and server `readImportZipArchive`. No tested production seam is dead. #10507 introduced CLI codec tests. #10531 moved the codec to shared and left CLI re-exports. #16075 removes earlier duplicate cases; the predecessor then removes the retained CLI replay file. This incremental child consolidates only the shared conversion cases.

CI runs shared in `general-workspaces-b` and CLI in `general-workspaces-a` through `scripts/run-vitest-stable.mjs` and `.github/workflows/pr-trusted.yml`. This child removes two shared executions. The predecessor already removed three CLI executions and one file. No measured CI time is available.

## SHA256 guards

- Parent shared test: `1664aca9760a18f33ce2657a4ac878a6015c8a6a43b4290dd88cd2b78663b6db`.
- Candidate shared test: `64548931fa808612f3dad4889acb5265cd9344dba8414fc853bc7ed478fc6fc7`.
- Parent and unchanged production owner: `b5860afd9ab301fb9cd44f3b3799c28d6fe6297fc891ebbe330b4b62bc53bd4e`.

- Test patch SHA256: `b0e9fcfbc198d19d679f7a6dd0613b7752ac9e37fcd383143af1631b00890f4f`.
