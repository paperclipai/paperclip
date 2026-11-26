# Local performance and correctness proof

The test must answer both questions: does the changed query do less work, and
does the surrounding feature still behave correctly?

## Start from the existing harnesses

Search `scripts/benchmark-*.ts` and `packages/db/src` before creating a harness.
This work produced these examples; use those present in the current checkout:

- `scripts/benchmark-slow-queries.ts`: chat notices, provenance, redaction,
  candidate indexes, and an unchanged history control.
- `scripts/benchmark-run-history.ts`: baseline service loading, captured history
  SQL, wide JSON projection, complete positional-row comparison.
- `scripts/benchmark-recovery-queries.ts`: ownership/blocker/delivery queries and
  baseline helper dependency isolation.
- `startEmbeddedPostgresTestDatabase` from `@paperclipai/db`: disposable real
  PostgreSQL lifecycle, used by these benchmarks and service integration tests.

Inspect a harness before running it. Use disposable synthetic fixtures by default;
for exceptional migration timing, use an authorized isolated production-size clone
or create an equivalent production-size database as described below. Do not reuse
the developer's persistent database or a live cloud `DATABASE_URL`. Planner,
index, UUID, and TOAST claims need real PostgreSQL, not mocked query builders.
Prefer the hosted major version when practical and disclose version differences.

Set `SLOW_QUERY_BASELINE` to a verified pre-fix commit and pass it explicitly:

```sh
pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-run-history.ts --baseline-ref="$SLOW_QUERY_BASELINE"
```

Resolve the ref to a SHA in the report. `origin/master` may already contain the
fix after merge, so it is not a durable historical baseline. Capture treatment
SHA plus any uncommitted diff, dependency versions, DB settings and fixture size.

## Capture the query actually used

Invoke the real service/query builder and capture `.toSQL()` plus parameters at
execution. Stop before dispatching notifications or starting runs. If the
service reads an issue before an expensive action query, capture the correct
subsequent query and include the first read in an endpoint benchmark if claimed.

Do not benchmark only an exported eligibility predicate and label it a complete
blocker query. Projections, joins, ordering, limit, and intermediate result sets
can materially change the result. Measure application post-processing separately
if the claim includes redaction or end-to-end request latency.

Load baseline source with `git show` or a separate checkout. When dynamically
loading old modules against current dependencies, include every changed helper
that can affect SQL. An old recovery module importing the new conversation
helper contaminates the baseline. Record which dependencies were held constant.

For index-only changes, use the same SQL in both treatments. Isolate index sets
in disposable databases or explicitly toggle only candidate indexes there;
record the definitions. Never drop indexes on a live database for a benchmark.

## Construct a fixture that exercises the cost and the contract

Match the mechanism observed in the cloud: candidate counts, match selectivity,
status distribution, tenant distribution, history depth, and payload width.
Include a small control and a representative stress case when size changes the
plan. Run `ANALYZE` after loading equivalent data.

For large JSON, repeated filler compresses unrealistically well. Use synthetic
incompressible content so TOAST reads resemble the actual workload. The original
fixture used 1,400 runs with approximately 192 KiB contexts; these are examples,
not universal sizes. Historical resolved recovery actions also matter: an empty
or tiny action table can hide the expensive join.

Fix timestamps and distinguish ordering ties. Include cross-company decoys,
empty results, duplicates, missing JSON keys, null/scalar/array/object contexts,
malformed/noncanonical IDs, and conflicting native/legacy bindings where the
affected contract permits them. Seed only relevant cases in each test.

## Keep complete results

Compare positional rows, for example `postgres.js` `.values()`, or give every
projection a unique alias. Object rows can overwrite duplicate column names,
silently hiding changed values. Matching row counts or IDs alone is insufficient.

Compare exact order where the API promises it. Otherwise compare multisets of
complete rows, preserving duplicates; do not sort away a pagination bug. Keep
parameter values, company/user scope, limits, and stable clock inputs equivalent.
Assert equality outside the timing interval and fail the harness on mismatch.

For intentional behavior changes, specify an explicit oracle. A bounded history
API may return fewer rows by design; prove those are the correct ordered page,
that requested limits are honored/clamped, and that older by-ID navigation still
works. Benchmark projection changes with the same limit on both versions.

## Measure and decide

1. Confirm baseline results and the suspected slow plan before applying the fix.
2. Warm both versions. Use several measured iterations; start with two warmups
   and at least five timed samples, expanding if the result is noisy.
3. Record all samples, median and range or quartiles. Alternate baseline/treatment
   or repeat in reverse order to check cache bias. Keep noisy full-suite/build
   work out of the timed interval. Do not claim cold-cache results from warm runs.
4. Capture `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` on the local fixture outside
   ordinary timing samples. Inspect actual rows/loops, filtering, sorts/spills,
   buffer accesses, and index use. Explain why the plan supports the measured gain.
5. Report baseline/treatment medians, speedup `before / after`, row equality,
   sample count, and limits of the claim. If spread overlaps materially, repeat
   or label the result inconclusive rather than selling a small fluctuation.

Keep semantic assertions in deterministic regression tests. Keep noisy timing
thresholds in the explicit benchmark unless the CI performance environment is
controlled. A test proving an index exists is weaker than real SQL results plus
plan/performance evidence. A proposed optimization can be neutral or slower:
our initial status-delivery rewrite repeated JSON reads and regressed until it
was simplified; the final path was reported as neutral.

## Time an exceptional migration at production size

Migrations are normally a non-starter for this workflow. First establish the
serious reason one is unavoidable and why query rewrites, existing indexes, or
caller changes cannot solve the problem. New boot scripts or startup migrations
are not an alternative to that requirement.

Prefer an authorized, isolated clone of a production-size database. If none is
available, create a production-size test database rather than timing a tiny
fixture: thousands of tasks plus representative related runs, events, comments,
JSON payloads, indexes, and history depth for the tables the migration touches.
Use observed aggregate sizes/distributions to size synthetic data when a real
clone is unavailable. Keep copied tenant data in its approved environment and
out of logs, fixtures committed to git, and public PRs.

Run the actual migration through its normal runner against the pre-migration
schema. Record total wall-clock time and per-step duration, including index
builds, backfills, lock waits, and commit. Record table/row sizes, PostgreSQL
version, compute/storage characteristics, and blocking time under representative
concurrent reads/writes where relevant. A concurrent index build can still take
too long even when it does not block writes. A fast laptop run is not proof of
an equally fast deployment on smaller compute.

Restore the starting state before timing an optimized version; an already-applied
or resumable no-op is not a first-run measurement. Also test interrupted execution
and rerun safety where applicable. Report first-run and rerun timings separately.

Treat durations above roughly one to two minutes as a flag, not an acceptable
cost to hide behind a query speedup. First optimize and repeat the production-size
timing. If an acceptable duration cannot be achieved, flag it for a human with
the serious reason, measured duration/blocking, attempted improvements, and
alternatives. Do not move the work into boot, run it against the live database,
or label the migration ready to deploy while that decision remains unresolved.

## Anticipate the compatibility traps

- Casting JSON text to UUID can reject malformed values or broaden matches for
  uppercase/noncanonical text. Preserve the former text-comparison semantics
  deliberately; guard casts and keep the indexed UUID side unwrapped.
- A native first-class ID may take precedence over legacy JSON. Do not change
  fallback order, cross-company access, or ownership holds while improving joins.
- A single JSON expansion must preserve legacy `->>` conversions and non-object
  inputs. Returning fewer projected keys can break redaction or downstream UI.
- History limits can break older deep links. Verify the actual run panel with
  an older selected run, including an empty recent list, fetch failure/retry,
  company/agent mismatch, and navigation while a lookup is pending. Check all
  shipped page variants and relevant desktop/mobile branches.
- Query-builder mocks may need new joins, but mock updates do not replace a real
  database test or justify removing a retry/disconnect regression test.

If PostgreSQL startup or a broad suite hits local shared-memory/resource limits,
save the real error, reduce concurrency, and clean up only this task's resources.
Re-run the affected proof. Report remaining limits honestly and distinguish
completed CI from incomplete local commands. Do not skip a failing assertion as
an environment issue or terminate another worktree's tests.

## Evidence to carry into the PR

Retain the reproducible command, baseline/treatment identity, synthetic fixture
definition, database version/settings, full samples and plans, equality result,
focused regression commands/results, and broader gate outcomes. Summarize:

| Caller/query | Before median | After median | Samples/spread | Complete output/contract check | Scope |
| --- | --- | --- | --- | --- | --- |
| Measured query | ms | ms | recorded | pass/fail and rows | SQL only, service, or request |

Preserve raw evidence in the task's artifact location and put the useful summary
in the PR. Re-run affected proof after a review fix that changes the query or
contract. Source correctness, local speed, final-head CI, and deployed behavior
are separate conclusions; report each only as far as the evidence supports it.
