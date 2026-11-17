# Windows native skill filesystem preparation, 2026-11-17

Native skill collection and staging previously processed individual files
sequentially and repeated recursive parent-directory creation per file. The
filesystem owner now processes at most eight file payloads concurrently across
skills in the process and creates each distinct parent directory once. The
runtime context builder delegates to that owner; authorization, version pins,
publication locks, asset digests, read-only publication and verification stay
with their existing owners. In-flight writes drain on failure before cleanup.

Windows content verification is deliberately unchanged: every source and delivered
file is still read and SHA-256 checked. No timestamp-only reuse was enabled.
The 10,000-file and 64 MiB native asset bounds remain enforced; declared sizes
are also checked before dispatching parallel content reads.

## Comparison

Windows, Node v26.12.1, real local skill bundle: 671 files, 10,980,431 bytes.
Five samples per implementation, alternating baseline/current order, fresh
destination trees for each sample, with source and destination integrity checks
inside each timed sample. The original collection/staging functions were loaded
directly from commit `ac65bd22e25c85097f4fc8527872c20e8b038c85`.

| Cold filesystem preparation | Baseline median | Updated median | Reduction |
| --- | ---: | ---: | ---: |
| Read, stage, make read-only, verify both copies | 5,593 ms | 3,300 ms | 41.0% |

The updated implementation was faster in each paired sample. Host load varied
considerably: baseline totals ranged from 4.74 to 15.47 seconds, updated totals
from 1.97 to 10.41 seconds. These local measurements establish a filesystem
improvement, not a promise about overall agent startup. See the
[raw samples and source hashes](2026-11-17-windows-skill-preparation.json).

Database skill resolution, publication locks, warm asset-cache reuse, provider
startup and model latency are outside this benchmark. In particular, the earlier
216-second `runtime_context.skills` span was not reproduced as a full live run.
No running Paperclip server or agent was restarted for these measurements.

## Reproduce

```sh
node --import ./server/node_modules/tsx/dist/loader.mjs server/scripts/benchmark-skill-materialization.ts --baseline-ref=ac65bd22e25c85097f4fc8527872c20e8b038c85 --samples=5 --source=<existing-skill-directory>
```

The source is read only. Omit `--source` for the default synthetic 671-file,
10,993,664-byte fixture. The benchmark owns and cleans only its temporary trees.
Both modes use the unchanged production manifest verifier, and the fixture's
manifest digest must match across every sample.

## Verification

- Red/green: native runtime regression initially observed only one source read
  at a time; the updated code passes the concurrency assertion.
- Red/green: an oversized-file test initially loaded bytes before rejecting;
  it now rejects the declared size before reading the file.
- 22 focused Vitest tests passed across `runtime-context.test.ts`,
  `runtime-asset-files.test.ts` and `file-manifest-cache.test.ts` on Windows.
  Coverage includes source changes, corrupt/missing delivered copies, edits of
  equal length with restored mtime after a warm pass, extra/missing files,
  junction rejection, cross-bundle concurrency and draining writes on failure.
- A strict TypeScript check of the filesystem owner, its tests, manifest tests
  and benchmark passed. The full server typecheck/build were not run.
- `pnpm verify --base HEAD` reported broader coverage required (exit 2) because
  the new benchmark script is a broad input. Required CI remains outstanding;
  focused passes do not replace it. Unrelated concurrent workspace edits were
  preserved.
