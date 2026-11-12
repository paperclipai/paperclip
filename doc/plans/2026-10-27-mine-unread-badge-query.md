# Mine unread badge query

The Mine badge ranks the user's visible personal top 100, then checks unread state. Correlated participation and privacy predicates can trigger expensive PostgreSQL JIT compilation. The final change builds the same participant set using native UUID keys, applies fresh visibility before the limit, and ranks a narrow ordered candidate projection with the existing canonical activity expression.

A partial activity index supports the new user lookup: `(company_id, actor_id, entity_id) WHERE actor_type = 'user' AND entity_type = 'issue'`. Activity already covered by creation/assignment is excluded from that branch before deduplication. Legacy text passes an exact lowercase 36-character UUID guard inside CASE. Malformed, uppercase, padded, newline, braced and dashless values still match nothing; the all-zero UUID remains supported. Canonical ordering, ties, archive/resurfacing and the second fresh unread query remain unchanged.

## Final PostgreSQL 17 results

These are ordinary warm local service calls, not hosted request timings. SQL capture and EXPLAIN happen outside the timed calls. Each arm has two warmups and five alternating samples. Complete positional rows from both SQL phases and final returned ID order match in all twelve cells.

| Fixture / visibility / JIT | Baseline ms (range) | Treatment ms (range) | Before / after |
| --- | --- | --- | --- |
| small / unrestricted / on | 4.22 (3.88–4.50) | 4.77 (4.24–5.53) | 0.88x |
| small / unrestricted / off | 3.76 (3.47–4.08) | 4.36 (4.26–4.97) | 0.86x |
| small / scoped / on | 4.87 (4.58–4.98) | 5.06 (4.93–5.37) | 0.96x |
| small / scoped / off | 4.59 (4.33–5.10) | 5.12 (4.93–5.22) | 0.90x |
| dense / unrestricted / on | 18.33 (17.92–18.90) | 25.06 (24.44–28.48) | 0.73x |
| dense / unrestricted / off | 20.99 (20.49–34.83) | 28.73 (27.73–30.88) | 0.73x |
| dense / scoped / on | 909.30 (887.26–915.52) | 221.10 (219.58–224.21) | 4.11x |
| dense / scoped / off | 218.34 (215.13–222.99) | 223.24 (219.44–231.43) | 0.98x |
| sparse / unrestricted / on | 13.64 (13.11–14.10) | 5.84 (5.34–6.45) | 2.34x |
| sparse / unrestricted / off | 12.41 (12.27–13.00) | 4.90 (4.51–6.02) | 2.53x |
| sparse / scoped / on | 719.07 (711.22–761.60) | 10.79 (10.18–11.40) | 66.64x |
| sparse / scoped / off | 23.15 (22.64–27.02) | 12.90 (12.33–13.86) | 1.79x |

The dense scoped path improves 4.11x; sparse paths improve 1.79–66.64x. Dense unrestricted paths remain slower by about 6.7–7.7 ms; dense scoped JIT-off is approximately neutral (218.34 to 223.24 ms). The result is strongest when the old query triggers full JIT or when a small personal set sits among company history. It is not a uniform execution-time improvement.

The baseline-red work assertion fails on the actual captured full-JIT plan. The treatment-green assertion requires at least 1.5x improvement where the baseline performs full JIT optimization/inlining, no such passes afterward, and at most 25% or 2 ms overhead in small/sparse controls. Dense no-JIT cases are reported diagnostics; a stricter 25% dense guard failed, so that regression is explicitly retained. The original optional 60 ms cap still fails on dense scoped reads (221.10 ms). The captured ranking execution retains about 200 ms of privacy-predicate work when half the personal tasks participate through activity alone; the rewrite removes compiler passes rather than that authority work. The failed cap remains in raw evidence. It is not counted as a pass.

## Fixture and isolation

The pinned baseline is `70c864633744cd96c0dc7394d631fc7119cd17d2`. Both owning pre-fix service blobs match the initial baseline. The harness copies the old issue service and participation helper and holds other query dependencies constant. Separate logical databases contain identical IDs, timestamps and payloads. The baseline lacks only the candidate index and its journal row; catalog assertions verify all other index definitions match. The final report hashes both query sources, the schema, migration and runner registration.

- Small: 12 personal issues, 48 activity rows and 24 comments.
- Dense: 1200 personal issues, 60000 issue activities, 240000 unrelated run activities and 24000 comments.
- Sparse: 12 personal issues among 1200 company issues, with the same history.
- Issue activity includes matching and other-human authors; the actor index is populated. The target user has 3600 activity rows in dense and 36 in sparse. Half the personal tasks are created by the user; the other half participate through user activity alone. Fixture assertions verify the complete declared personal set before timing.
- Base activity/comment payloads are 4096 incompressible bytes. Additional run rows carry 256 bytes. History appends across tasks in timestamp order.
- The reported workspace's fresh read-only catalog estimates were about 292k activity rows, 1198 issues and 7632 comments. Estimates are not exact counts. The large fixtures match issue/history scale and exceed its comment history.

Environment: PostgreSQL 17.11 ARM64 Linux Docker, Node 26.4.0, postgres.js 3.4.9, Drizzle 0.45.2, shared_buffers 128 MiB, work_mem 4 MiB, jit on, jit_above_cost 100000 and full optimization/inlining thresholds 500000. Hosted PostgreSQL version/architecture and planner settings match; compute, storage and network differ.

```sh
pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-mine-unread-badge.ts --baseline-ref=70c864633744cd96c0dc7394d631fc7119cd17d2 --history-decoys=240000 --verify-migration --assert-performance --evidence-dir=<directory>
```

The default harness starts disposable embedded PostgreSQL and ignores DATABASE_URL. Recorded runs used a scratch constructor provider for Linux PostgreSQL 17 because the host native runtime can hit semaphore limits. Database creation, schema migration, clients and cleanup remain the normal repository path. A saved report can be checked with `--validate-report=<report>`; source hashes must still match. Add `--validate-baseline` for the original compiler-work red. `--diagnostic` runs one pair per visibility/JIT setting with a plain plan first. `--diagnostic-dense` selects dense instead of sparse. `--fixture=sparse --history-decoys=940000` selects a million-row control. `--hold-after-report=<directory>` retains one selected disposable fixture for bounded query iteration, with a private ready file and explicit release.

## Why an exceptional migration is necessary

The source-only participant set had no actor index and scanned company history. A plain EXISTS rewrite was decorrelated into that scan. A forced existing-entity-index lateral lookup avoided it but regressed the sparse unrestricted case from 56.64 to 66.47 ms with JIT and 12.74 to 18.68 ms without JIT. Both alternatives are rejected. A time cutoff would change historical participation; existing indexes cannot selectively find a user's issue activity without walking tasks/history. The partial index supplies that missing access path and excludes agent/system/non-issue activity from its storage and write maintenance.

Migration `0395_tranquil_firestar.sql` uses the existing top-level concurrent-index runner and its invalid-index repair. No new startup script or live migration is used. The actual normal runner is measured against the pre-index schema with synthetic history. Concurrent reads/writes continue while it builds; a deliberate cancellation leaves an invalid index without a journal entry, then normal retry repairs it.

For the 300k-row upgrade, total first-run wall time was 668.79 ms, rerun 21.83 ms and interrupted-build retry 187.71 ms. The migration has one DDL statement; totals include inspection, lock acquisition, concurrent build/validation, journal write and final verification. Concurrent reads completed in 0.51–6.69 ms and writes in 0.75–3.45 ms. The final partial index was 188416 bytes. Local duration does not guarantee a hosted duration, especially for larger tenants or long-lived transactions.

## Feedback loop and rejected attempts

Initial dependency install took 21.2 s. Frozen pnpm failed on upstream patch/lock metadata; local non-frozen resolution was retained privately and the tracked lock restored. The first service import lacked SDK dist; a narrow SDK dependency build fixed it.

The initial PostgreSQL 18 clustered-history diagnostic took 35.4 s through useful evidence, including 29.3 s fixture setup. Ranking was 96.7 ms with 75.5 ms JIT. Interleaved history and PostgreSQL 17 made the later fixture more representative. An early text-key/grouped-history rewrite won unrestricted but regressed scoped sparse to 392 ms with JIT disabled; it was rejected. A native-key draft exposed an ambiguous Drizzle id alias; an empty-database parse smoke now runs before seeding.

The original query-only 60k-history matrix improved target JIT cases but regressed dense JIT-off by about 17 ms and missed the 60 ms cap. Review exposed the missing actor index. Fresh catalog estimates sized the 300k and million-row controls. The first indexed draft still regressed dense execution. A narrow ordered candidate phase and skipping already-owned activity reduced that overhead. Retaining the seeded fixture shortened the next diagnostic to about ten seconds of actual calls. Repeated SQL capture had inflated timed service work; capture now occurs outside the sample interval in both arms.

Scratch 512 MiB and eager dual-fixture 2 GiB runs hit ENOSPC; those are setup failures, not performance red. Fixtures now seed/measure sequentially. Matched pre-index/indexed databases use an owned 4 GiB tmpfs ceiling. The final full matrix took 113.26 s including both databases and fixture loading. Raw failures, plans and samples remain in private evidence.

## Correctness and deployment limit

Fourteen real PostgreSQL tests exercise ranking before unread, visibility before the top-100 limit, canonical ties, native assignee and exact legacy IDs, archive resurfacing/deleted comments/status changes, request audience/not_creator/dismissal/completion, provider/relay comment exclusions, company boundaries, inherited grants, private project membership, revocation and fresh badge routes. The final production source and strengthened fixtures passed all fourteen focused PostgreSQL 17 tests in 16.37 s. Full workspace typecheck and build passed. Latest-head CI remains required before handoff.

The earlier full local suite remained incomplete after native PostgreSQL startup failures. An independent empty initdb reproduced system semaphore exhaustion at semget. All sixteen failed cases passed through task-owned Docker PostgreSQL 17; that is not a full local-suite pass. Full final-head CI is the broad gate.

Fresh hosted ranking variants averaged 78.8 ms SQL per call. That is the affected serial SQL-time budget, not a promised HTTP saving. Badge HTTP requests averaged 752 ms (p95 1521 ms) without correlated SQL traces. A deployed revision check and comparable fresh query/request window are still necessary after rollout. No merge or deployment is part of this PR.

## Million-row history control

The same mixed-participation sparse fixture also contains 940000 unrelated run activities, for one million initial activity rows. Both arms again have two warmups and five alternating samples, and both complete SQL phases/final ID order match.

| Visibility / JIT | Baseline ms (range) | Treatment ms (range) | Before / after |
| --- | --- | --- | --- |
| unrestricted / on | 13.44 (13.10–14.10) | 5.76 (5.51–6.17) | 2.33x |
| unrestricted / off | 13.45 (13.07–14.34) | 5.77 (5.11–6.84) | 2.33x |
| scoped / on | 807.76 (741.30–825.57) | 11.59 (10.39–12.67) | 69.68x |
| scoped / off | 19.69 (18.78–20.76) | 10.90 (10.06–11.73) | 1.81x |

The activity participant branch uses the partial actor index and visits 36 matching actor rows (18 returned, 18 already-owned rows filtered), rather than scanning the million-row company history. Canonical activity and authority work remain separate. The activity relation is about 439 MB heap / 1.05 GB including indexes and TOAST, exceeding the observed hosted relation's 160 MB / 381 MB. The physical fixture remains synthetic.

The actual normal migration runner completed first run in 255.06 ms, no-op rerun in 20.32 ms and interrupted-index repair/retry in 241.73 ms. The final index is 188416 bytes. Concurrent reads took 0.65–7.83 ms and writes 0.71–2.45 ms, without failures. The full command took 66.90 s including both database fixtures. This validates the missing actor access path above the observed target scale, not an unbounded fleet-wide migration duration.
