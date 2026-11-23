# Prepared GitHub review-wait read

Date: 2026-11-04.

`readInheritedGitHubReviewWait` builds a fixed seven-table selector on every
read. A sampled production window attributed 6.3% of SQL serialization CPU to
the matching shape (29 samples, mean 204 microseconds). This is a share of
serialization CPU, not total server CPU.

## Change and preserved contract

The GitHub owner prepares the existing Drizzle selector once per exact supplied
`Db` object. A `WeakMap` retains only the compiled query and decoders. Company,
issue, agent and source-comment IDs are placeholders filled on every execution.
Database transactions and nested savepoints have different object identities
and therefore own separate prepared queries and sessions. No database rows,
results, promises or authorization decisions are cached.

Provenance still runs before the selector, and publication still runs after it.
The SQL, field order, JSON `->'reviewedCommit'` projection, latest-review ordering,
company boundaries, connection/repository/agent checks and publication lookup
are unchanged. This does not change postgres.js driver preparation settings.

## Reproduction

Install the locked dependencies, then run with the repository's supported Node:

```sh
node --import ./server/node_modules/tsx/dist/loader.mjs \
  server/scripts/benchmark-prepared-github-review-wait.ts \
  --baseline-ref=e54f9fbf828e06e385e0c62dc381ccb46190aa30
```

The script imports the complete baseline service from that explicit commit,
verifies the unchanged provenance dependency, seeds disposable real PostgreSQL,
and compares the complete result and every generated query, parameter and query
count. It records main-selector compilation counts separately from timed runs.
The timed path calls the actual owning service, including provenance and
publication reads, with no replay driver or substituted authorization result.

## Accepted measurement

Baseline: `e54f9fbf828e06e385e0c62dc381ccb46190aa30`.
Treatment source SHA256: `fe647e7fe2aed82609e8f1d66a0109e7a10ee28313ae2ef218ba3ab39b5cd105`.
Runtime: v24.22.2, darwin/arm64.
Database: PostgreSQL 18.1 on x86_64-apple-darwin23.6.0.
Fixture: one synthetic completed review and its full live binding/publication.

The final measurement used an exclusive build/benchmark window, 500 warmup
reads per version and nine alternating pairs of 100 sequential reads each.
CPU measures the Node process; it excludes PostgreSQL process CPU. It includes
SQL construction, driver work, row decoding and the rest of the service.

| Median per complete service read | Baseline | Treatment | Reduction |
| --- | ---: | ---: | ---: |
| Process CPU | 1.00336 ms | 0.75908 ms | 24.35% |
| Wall time | 2.87089 ms | 2.38731 ms | 16.84% |

Main-selector compilations per ten warm service reads: **10 → 0**. All service
results, generated SQL, bound parameters and query counts matched. Connection
revocation was observed by both versions after the cache was warm.

Each sample below totals 100 service reads; odd pairs run baseline first and even
pairs run treatment first. No samples were discarded.

| Pair | Baseline CPU ms | Treatment CPU ms | Baseline wall ms | Treatment wall ms |
| --- | ---: | ---: | ---: | ---: |
| 1 | 109.301 | 82.314 | 301.860 | 326.252 |
| 2 | 110.681 | 98.892 | 310.177 | 248.191 |
| 3 | 102.627 | 94.743 | 314.427 | 317.478 |
| 4 | 98.198 | 78.979 | 287.089 | 323.037 |
| 5 | 100.336 | 75.908 | 288.454 | 232.344 |
| 6 | 91.043 | 63.248 | 247.297 | 238.731 |
| 7 | 72.471 | 59.875 | 223.578 | 206.735 |
| 8 | 93.542 | 54.337 | 252.195 | 219.263 |
| 9 | 119.050 | 65.356 | 265.733 | 220.582 |

The smallest and largest CPU samples per read were
0.72471–1.19050 ms for baseline and
0.54337–0.98892 ms for treatment.
These are local synthetic service measurements. They do not predict a
production request latency percentage or measure database execution savings.

## Correctness and setup record

The focused real-PostgreSQL suite covers malformed JSON and strict type equality,
current connection/publication/provenance changes, company and agent boundaries,
repository/thread checks, a newer queued head after a warm completed review,
changing company/issue/agent/comment bindings on a shared handle, and independent
transaction/savepoint visibility through rollback.

An initial sandbox run could not bind loopback. The next run exposed missing
macOS library aliases in the freshly unpacked embedded-Postgres dependency.
The fixture ran after restoring aliases to existing identical library bytes in
`node_modules`; no application source or package lock changed. The first short
warmup benchmark and the next long warmup benchmark overlapped another fixture
and are diagnostic only. The accepted numbers above come from the final
exclusive-window run. Setup failures are not counted as passing tests.

The first shared-consumer integration import and direct server typecheck lacked
built workspace SDK/Runner outputs. Building `@paperclipai/plugin-sdk` (including
its shared-package prerequisite) resolved the SDK import. An overly broad run of
the full external-chat integration file was interrupted to run only its affected
consumer test. That interrupted run is not a passing suite. Full repository
validation is tracked separately from the focused tests and benchmark.

Focused verification passed: `github-review-wait.test.ts` (16 tests), plus
`external-chat-wait.integration.test.ts -t 'reads small current external review waits without saved prompts'`
(four affected consumer cases; 269 unrelated cases skipped).
