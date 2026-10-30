# Queued-comment consumption query proof

The execution blocker counts saved user comments that no run has consumed.
It must not make consumed input eligible for replay. This change keeps the same
read and cancellation rules. It projects the two wake-comment fields before
PostgreSQL repeats the anti-join for each candidate comment.

## Cause and scope

A recent hosted sample had 99 calls of the eight-comment query. They returned
eight rows per call, used about 8,002 shared buffer hits per call, and averaged
131.14 ms of SQL execution. PostgreSQL reported no JIT work. These are SQL
statistics, not correlated request timings.

The old local plan already scans the matching run relation once. It materializes
raw context values and then reads their large TOAST values again for each
comment. A 1,400-run stress fixture removed 11,200 join pairs and used about
166,645 shared buffer accesses. The hypothesis that there were eight underlying
run scans was rejected before changing production code.

The replacement subquery selects `wakeCommentId` as text and `wakeCommentIds` as
JSON. `OFFSET 0` prevents PostgreSQL from pulling these expressions back into the
outer anti-join. The local plan materializes these small extracted values. It
still reads lazily and can stop at an early matching consumed run. There is no
new table, index, migration, cache, timestamp cutoff, or extra database round trip.

The company condition, exact JSON `issueId` text condition, singular `->>`
comparison, array `@>` predicate, user author condition, deletion condition, and
cancelled-before-start exception are unchanged. Native and first-class run issue
IDs do not replace the JSON authority in this path. No JSON arrays are expanded
or cast to UUID. Non-array JSON therefore retains the original meaning.

## Reproduction

Use a disposable PostgreSQL database with current repository migrations. An
explicit external database must have a `queued_comments_` name. The script
clears its company graph before setup and after each fixture. Without the
external URL the benchmark starts a disposable embedded PostgreSQL database.

```sh
QUEUED_COMMENT_BENCHMARK_DATABASE_URL="$DISPOSABLE_QUEUED_COMMENT_DATABASE_URL" \
  pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-queued-comment-consumption.ts \
  --baseline-ref=8279c990080b15abdcd9981f5793290fab37f9ad --require-budget
```

Repeat with `--jit-off` for the planner control. `--representative-only` selects
the forty-run case. `--wait-for-slot` waits once after initial setup so concurrent
local workers can stop before timing starts.

The script loads the pinned original `execution-blocker.ts` from Git. It rewrites
relative imports to the same unchanged dependencies as the treatment. It rejects
other runtime dependency changes. The report records the source hashes, database
version and settings, every sample, SQL and parameters, full positional rows,
full execution blocker result, and execution plans. SQL results have no promised
order, so equality compares complete row multisets. Service objects compare
exactly. Capture, assertions, and `EXPLAIN ANALYZE` are outside the timed calls.
Each arm has two warmups and five alternating measured samples.

## Fixture fidelity

The hosted PostgreSQL version is 17.11. Anonymous aggregates over 1,198 task
groups gave 2, 11, and 40 runs at the median, 90th, and 99th percentiles, with a
maximum of 69. These groups use native or first-class bindings; the changed query
uses JSON issue bindings, so the counts are a sizing guide rather than exact
query selectivity. A bounded block sample of 262 stored contexts gave 27,075,
71,979, and 201,832 bytes at those percentiles. Stored sizes are not decompressed
logical JSON sizes. Synthetic random Base64 payloads avoid repeated-string
compression and are close to the selected stored-byte envelopes.

The benchmark includes zero comments, empty history, two runs with 27 KiB
contexts, eleven runs with 72 KiB contexts, forty runs with 72 KiB contexts,
and a joint tail of sixty-nine runs with 200 KiB contexts. It separately checks
one queued comment, eight immediately consumed comments, half consumed comments,
and sixty-four queued comments. It also retains a 1,400-run stress case, which
exceeds observed task history and is not called representative. Each nonempty
history has 1,400 unrelated runs with approximately 27 KiB contexts. This checks
that the existing company and JSON issue index can limit the target task.

The first-consumed fixture inserts its matching run before physical history
rows, with a newer creation time. Thus a sequential scan and the existing
creation-time index can both find it first. This prevents a misleading fast-path
control in which the matching run is actually last in physical storage.

## Acceptance and selection timing

The original eight-comment, 300-run regression fixture used 35,711 shared buffer
accesses. The pre-change guard failed against a budget of 10,600, which permits
32 accesses per run plus 1,000 fixed accesses. Five semantic controls passed at
that same revision. The preliminary single-scan assertion passed the baseline
and is not counted as a red result.

After the initial projection trial, the final timing criteria were selected
before the quiet measurement matrices. The explicit local benchmark requires
at least a 1.5-fold SQL improvement for
the forty-run, eight-unconsumed-comment case. Zero/empty/small/one-comment and
immediately consumed service controls must add no more than 25 percent or 2 ms,
whichever permits more overhead. These wall-clock limits belong to the explicit
benchmark, not the uncontrolled CI test environment. The CI regression uses
query work and exact behavior instead.

## Final local measurements

The final quiet measurements used PostgreSQL 17.11 on ARM64 Linux, with 128 MiB
shared buffers and 4 MiB work memory. JIT was enabled at its default 100,000-cost
threshold for the primary matrix, but no measured query used JIT. The control
explicitly disabled JIT. Two warmups and five alternating samples were used for
each arm. The initial matrix had eleven cases. Review added a twelfth deep
first-consumed case and repeated the two existing consumed cases with a wide
consuming-run context. All twenty-four final fixture/JIT cells returned equal
complete positional SQL rows and equal full service objects. Every selected
budget passed. The initial thin consuming-row results remain in private raw
evidence and are superseded by the wide-row controls below.

| Fixture | SQL before → after, ms | Full blocker before → after, ms | Shared buffers before → after |
| --- | ---: | ---: | ---: |
| No saved comments | no query | 17.24 → 17.46 | no query |
| Empty history | 2.39 → 4.23 | 26.07 → 29.97 | 1 → 1 |
| 2 runs, 27 KiB | 2.33 → 3.02 | 20.99 → 26.02 | 196 → 28 |
| 11 runs, 72 KiB | 8.35 → 5.05 | 37.60 → 35.13 | 2,116 → 268 |
| 40 runs, 72 KiB | 11.47 → 3.82 | 29.48 → 18.85 | 7,686 → 966 |
| 69 runs, 200 KiB | 43.35 → 8.41 | 68.43 → 31.60 | 31,623 → 3,959 |
| One saved comment | 4.31 → 4.63 | 29.09 → 29.00 | 965 → 965 |
| Eight immediately consumed, wide run | 1.60 → 1.28 | 13.90 → 16.59 | 196 → 28 |
| Half consumed, wide run | 3.13 → 1.75 | 14.44 → 11.49 | 4,038 → 990 |
| 64 saved comments | 80.88 → 6.98 | 111.08 → 39.90 | 61,446 → 966 |
| 1,400-run stress | 172.82 → 44.27 | 212.60 → 73.94 | 175,089 → 37,889 |
| 1,400 runs, first wide run consumes all | 1.54 → 1.99 | 19.00 → 18.23 | 122 → 24 |

The forty-run SQL samples ranged from 10.36–12.33 ms before and 2.83–4.30 ms
after. Full blocker samples ranged from 27.34–33.22 ms before and 18.58–21.81 ms
after. This is a 3.00-fold SQL gain and a 36 percent service reduction. Its buffer
work is close to the hosted eight-comment shape, but hosted execution time is
much higher. These local times do not predict a 131 ms hosted saving.

Small and empty-history service medians rose 5.03 ms and 3.90 ms with JIT enabled.
The accepted control budget is 25 percent or 2 ms, whichever permits more
overhead. Small and empty-history medians are inside that budget. This accepts
a possible small-path cost; it does not claim a universal improvement. The small
service ranges overlap: 18.49–36.48 ms before and 17.29–41.89 ms after.
These observations do not isolate the cause of the service difference. The
higher medians remain visible as accepted local costs. Hosted before/after
correlation still requires deployment acceptance.
The unchanged no-comment path runs no changed SQL; its 0.21 ms difference cannot
be attributed to the projection. One-comment results are neutral. The widened immediately consumed service
median rose 2.69 ms (19 percent), inside the selected control budget; its ranges
overlap at 13.34–27.72 ms before and 13.18–18.10 ms after. These controls remain part of the report, not omitted slower cases.

With JIT disabled, the forty-run SQL median was 10.96 → 3.63 ms and the service
median was 32.18 → 24.75 ms. Small service medians were 15.58 → 14.68 ms; empty
history was 18.74 → 18.23 ms; the widened immediately consumed control was 13.59 → 14.64 ms. Plans had
no JIT work in either matrix, so this change addresses repeated JSON reads.

The reviewer-requested 1,400-run first-consumed case reads exactly one underlying
run row in both arms. Each materialization returns one row and is revisited eight
times; neither arm eagerly reads the remaining history. Shared buffer accesses
fall from 122 to 24. Its JIT-on SQL ranges overlap at 0.86–2.79 ms before and
0.77–4.38 ms after, so this is an early-exit work proof, not a latency win.
With JIT disabled it is 1.08 → 1.07 ms of SQL and 11.36 → 11.53 ms of service
time, with the same buffer counts. The consuming row has the same 32 KiB random
payload as the deep history. The forty-run consuming controls use 72 KiB random
payloads on the consuming row too. This fixes the original thin-row fixture.
`--fixture=deep-consumed-first` selects this case; repeat `--fixture=` to select
more than one case. The six affected review-control cells passed in a coordinated
40-second quiet window. Production source did not change during this follow-up.

The final runtime source SHA-256 is
`f750b3d12be73ed49b0a3be9ca9c769514eb561b98a17c1ff0bb909d9f880809`.
The original source SHA-256 is
`c0fa9a2c27af3d97d8775cfe0489e651efddb1c10402c0f177eef33d23961767`.

## Validation and remaining limits

The real PostgreSQL regression suite covers exact scalar, array, nested-array,
object, null and missing JSON behavior; noncanonical JSON issue IDs; conflicting
native IDs; cross-company rows; deleted and agent-authored comments; duplicate
array entries; cancelled-before-start and started-cancelled runs; and queued
runs that already carry a consumed comment. It checks complete execution blocker
objects and verifies that reads do not create runs or replay input.

Local improvements establish this SQL mechanism and its service effect on
synthetic data. They do not establish an equal change in hosted request latency.
A successful deployment still needs a fresh equivalent SQL window and correlated
request timings. PostgreSQL can choose a different plan as data or versions
change; the plan-work regression protects the repeated-context mechanism on the
provided fixture.

## Feedback-loop record

The first attempted scan-count regression passed the original code. Profiling
showed that repeated TOAST reads, not repeated relation scans, were the relevant
work. The revised buffer-work guard failed before the source change: 35,711
accesses against a 10,600 budget. The projection then passed the same guard and
all semantic cases.

Initial direct test invocations spent 44–70 seconds, mostly rebuilding unchanged
module transforms. A private Vitest configuration enabled the existing persistent
transform cache. The assembled route and regression suites then completed 91
cases in 128.21 seconds, with transforms accounting for 18 percent. That larger
suite checks integration rather than comparing an identical timing loop. No
repository test configuration was changed to get this result.

Scratch setup first failed on a TypeScript module extension and then on a URL
string replacement that changed the username. Both setup errors were corrected
before the real red result. These are not performance regressions. Native
PostgreSQL startup was unsupported on this host, so its default focused run
skipped six cases. Docker PostgreSQL 17.11 then ran all 91 targeted and assembled
cases through the repository database allocation, migration and client path.
Only the native server process constructor was replaced in private test setup.
These local runtime limitations remain distinct from the Linux CI result.

The required full native test command was attempted. Its unchanged execution
suite completed 940 cases with 16 PostgreSQL startup failures and 924 passes.
The command was stopped at that infrastructure boundary, so the full local run
is incomplete and is not counted as a pass. An independent empty native initdb
failed with `semget: No space left on device`, which identifies the macOS
semaphore limit. Exactly those 16 cases then passed under Docker PostgreSQL
17.11 in 181.22 seconds. The full workspace typecheck and build passed. Complete
Linux CI remains a separate gate on the final PR head.
