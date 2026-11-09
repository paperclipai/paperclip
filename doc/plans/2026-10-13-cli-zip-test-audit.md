# CLI portability codec test audit

Date: 2026-10-13. Proof base: `06c1b2035df44fa03c065ddd69e8bf8df8513b86` (the preceding audit stack). This candidate changes tests only.

## Decision and preserved contracts

Retire `cli/src/__tests__/zip-codec.test.ts` after moving its unique observations into `packages/shared/src/portability-zip.test.ts`:

| Retired declaration | Shared keeper |
| --- | --- |
| `matches blobs/ entries at the archive root and under a package root` | Same named classifier keeper, now also rejects `blobs/nested/file`. |
| `decodes valid UTF-8 entries to text` | `decodes valid UTF-8 entries to text and falls back to base64 for invalid bytes`, with identical Unicode text/path/result. |
| `round-trips blob and invalid UTF-8 entries byte-exactly` | Existing STORE/DEFLATE archive keeper, now using the retired valid-UTF8 blob bytes `[0x68, 0x69]` and adding `notes/raw` with `[0x68, 0x69, 0xff, 0xfe, 0xc0]`. |

The valid-UTF8 blob is necessary: arbitrary invalid binary bytes can still become base64 through the decoder fallback if opaque-blob classification breaks. The keeper now demands base64 `aGk=` for the ASCII blob, and `aGn//sA=` for invalid non-blob UTF8. Existing STORE, genuine DEFLATE, shared-root, direct UTF8, truncation, descriptor, central-directory, duplicate-path and decompression-limit assertions remain.

The CLI module is a production re-export of the shared codec. Real consumers remain in `resolveInlineSourceFromPath`, `resolveChunkedImportZip`, folder conversion/filtering (`cli/src/commands/client/company.ts`), and server uploaded-archive parsing (`server/src/routes/companies.ts`). No production exports or code are deleted. CLI file/transport/filtering tests remain in `company-import-zip.test.ts` and `company-import-transfer.test.ts`.

History: #10507 (`916c13501f`) introduced CLI codec tests. #10531 (`5ec7ce76e5`) moved the codec into shared, retained CLI re-exports, and introduced the primary shared-owner tests. This candidate removes the replay left behind by that ownership move.

## Reproducible verification

From a dependency-ready checkout at the proof base, the complete baseline/revert owner command is:

```sh
node node_modules/vitest/vitest.mjs run --no-file-parallelism --maxWorkers=1 \
  packages/shared/src/portability-zip.test.ts \
  cli/src/__tests__/zip-codec.test.ts
```

For the candidate/restored owner, omit the deleted CLI file. Run transport proof separately:

```sh
node node_modules/vitest/vitest.mjs run --no-file-parallelism --maxWorkers=1 \
  cli/src/__tests__/company-import-zip.test.ts \
  cli/src/__tests__/company-import-transfer.test.ts
```

| Phase | Complete owner | Separate transport |
| --- | --- | --- |
| Untouched baseline | 18/18 | 18/18 |
| Candidate | 15/15 | 18/18 |
| Full test-file revert | 18/18 | Not repeated |
| Restored candidate | 15/15 | Not repeated |
| After production restoration | 15/15 | 18/18 |
| After verbose mutation receipts | 15/15 | Not repeated |

All complete-file positive runs have zero failed, skipped/pending and todo tests. `git diff --check` passes. No tests were disabled or weakened because of failures.

## Actual production falsification

Each mutation changes only `packages/shared/src/portability-zip.ts`, is run separately, and is restored byte-for-byte before the next mutation. Focused negative runs select one keeper and therefore skip 14 unrelated cases; each selected case fails at the intended assertion.

1. Broaden the classifier regex from `/(^|\/)blobs\/[^/]+$/` to `/(^|\/)blobs\/.+$/`. Run shared owner with `-t 'matches blobs/'`. The migrated `blobs/nested/file` assertion fails: expected false, received true.
2. Replace `if (isBlobStorePath(pathValue)) {` with `if (false) {` in the conversion function. Run shared owner with `-t 'round-trips STORE'`. The migrated archive assertion fails because `blobs/4f2d1c9a` becomes plain `"hi"` instead of `{ encoding: "base64", data: "aGk=", contentType: "application/octet-stream" }`.
3. Replace archive entry conversion `body: bytesToPortableFileEntry(archivePath, entryBytes),` with `body: isBlobStorePath(archivePath) ? bytesToPortableFileEntry(archivePath, entryBytes) : textDecoder.decode(entryBytes),`. Run shared owner with `-t 'round-trips STORE'`. The migrated `notes/raw` assertion fails because lossy text replaces the expected base64 bytes. This preserves the blob branch so the failure specifically witnesses the non-blob invalid-UTF8 archive contract.

Production SHA256 before and after all mutations: `b5860afd9ab301fb9cd44f3b3799c28d6fe6297fc891ebbe330b4b62bc53bd4e`.
Original shared test SHA256: `7d48436c195120e9717d9ee1b99f10c808c976088b6c2306cbfad3990053893a`.
Candidate shared test SHA256: `1664aca9760a18f33ce2657a4ac878a6015c8a6a43b4290dd88cd2b78663b6db`.
Deleted CLI test SHA256: `e3634f25fa66544937cf12d30432ff8d109fbfbd578b5a6548df5aef1625f8ef`.
Candidate patch SHA256: `172b2e5fa01f369cb07edf19a133680c82bb239cdbd44ccb878bf1ef0ea98071`.

## Cost and limits

Diff: 9 added and 52 removed test lines, **43 net test lines removed**. Three registrations and one CLI Vitest file are retired; the shared owner stays at 15 cases. Production reduction is zero.

`scripts/run-vitest-stable.mjs` routes CLI to `general-workspaces-a` and shared to `general-workspaces-b`; `.github/workflows/pr-trusted.yml` executes those groups. This removes duplicate CLI collection/import/case work. No wall-time or CI percentage savings are claimed.

This is focused local evidence, not a repo-wide PR-ready result. Repo-wide typecheck, full suite, build, CI and reviewer checks were not run by this proof agent and must be attributed separately by the delivery supervisor. No commit or PR was created by this agent.
