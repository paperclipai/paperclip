# Task privacy ancestry query proof

The shared task privacy predicate belongs to `authorization.ts`. Detail reads,
list/search/count filters, unread badge phases, and derived authorization all use
this predicate. This change preserves that owner and the current access rules.

## Cause and change

Measured baseline commit: `8279c990080b15abdcd9981f5793290fab37f9ad`.
The branch was later replayed onto `71b448b9cb841e6fa18fe883585430c5081245da`.
Both commits have byte-identical pre-fix authorization, issue-service and
participation-helper sources. The reproduction command uses the newer equivalent
pre-fix baseline so unrelated upstream voice-schema changes stay constant in
both arms. The measured source hashes below are unchanged by that replay.
The previous recursive join can scan every company task and check its project
for each privacy frontier. In the 1,200-open-task regression this reads 1,440,000
task rows even though every parent is NULL. The semantic ID assertion passes;
the deterministic work assertion fails at the unchanged baseline.

The replacement skips NULL parent frontiers and reads the exact same-company
parent through a correlated lateral lookup. The existing unique task ID and
company/ID index support the lookup. No schema or migration change is needed.

Both `LIMIT 1` clauses are redundant under the current schema and anchor:

1. The anchor selects at most one row by the outer task's ID and company.
2. Each task has one scalar privacy parent ID. That ID selects at most one
   same-company parent. The lateral limit prevents the planner from replacing
   the parameterized lookup with a company-wide hash scan.
3. Inductively, each recursive generation has at most one row. The recursive-arm
   limit exposes this fact to the planner. It does not limit chain depth.
4. `UNION` still removes visited rows and terminates cycles. An open parent
   outside a private project still stops traversal at the same place.

A first lateral-only draft removed repeated scans but raised estimated ancestry
rows from 11 to 101. This retained JIT compilation in the representative callers.
The per-generation cardinality fence addresses that estimate. Tiny tables can
still use a cheap sequential lookup for a real parent. The work guard prevents
company scans for absent parents; it does not force every small-table index plan.

Implicit principals, live task grants, private project membership, responsible
user and external authorizer intersections, and company membership checks use
the same expressions. There is no cached permission result or visibility check
moved after pagination.

## Local proof and reproduction

Run the real service benchmark with a pinned source baseline:

```sh
pnpm --filter @paperclipai/server exec tsx scripts/benchmark-task-privacy.ts \
  --baseline-ref=71b448b9cb841e6fa18fe883585430c5081245da \
  --evidence-dir=/tmp/task-privacy-proof
```

It uses disposable embedded PostgreSQL by default. An explicit
`PRIVACY_BENCHMARK_ADMIN_URL` selects an isolated loopback PostgreSQL server.
The harness creates and removes only its own `privacy_ancestry_*` database.

Adding `--assert-performance --max-dense-ms=60` reproduces the retained failed
stretch-goal command. It must not be used as evidence of a green performance gate.

The harness loads old `authorization.ts` from Git, rewrites only its relative
imports, and uses the unchanged real `issueService` for both arms. It rejects
unisolated runtime dependency changes. Both arms use one identical database,
index set, user, task IDs, clock inputs and session settings. It records source
hashes, baseline revision, PostgreSQL and dependency versions, settings, and
fixture sizes.

Ordinary service timings exclude SQL capture, assertions, and EXPLAIN. Each case
has two warmups and five measured calls per arm in alternating order. Capture
runs afterwards. Every positional SQL field and row order must match across all
captured queries. The entire final badge output and list objects must also match.
The badge runs both ranking and unread phases. The list includes its ordinary
post-query enrichment. These are local service measurements, not HTTP latency.

The matrix includes small, dense and sparse participation with JIT on/off, plus
64-level private ancestry, 1,200-task private fan-out, and a 32-task cycle. Dense
and sparse fixtures contain 1,200 tasks, 60,000 task activity rows, 240,000 unrelated
run activity rows, and 24,000 comments. Their activity/comment payloads use 4 KiB
Base64 text from 3 KiB of random bytes per value. Half of personal participation comes from the creator and
half from user activity. The dense fixture has 1,200 personal tasks; sparse has
12. Controls also omit the privacy predicate entirely.

Acceptance was set before the final run: no recursive task reads for absent
parents, at least 2x gain on representative scoped dense/sparse callers, complete
output equality, and small/open controls within 25% or 2 ms. The original 60 ms
dense scoped badge target is a separate explicit check. It is not treated as
passed without the final measured result.

## Correctness and failures retained

The dedicated real PostgreSQL tests cover NULL parents, child-to-descendant grant
flow, sibling/ancestor denial, revocation, a 64-level root-only grant, cycles,
public traversal barriers, foreign-company parent pointers, all three agent/user
principals, inactive user membership, private project membership, and access
checks before list pagination. Existing production privacy, creation visibility,
and unread badge tests exercise the shared consumers and HTTP routes.

The first baseline work test failed as intended: 1,440,000 rows against the 3,600
bound, after semantic equality passed. A wrong relative-path edit then reran the
old query; that failed command is retained and is not a treatment pass.

The first four-suite lateral-only run passed 35 tests, but eight creation tests
did not run because their real database setup exceeded its 20-second hook limit.
That command failed. Final-runtime checks and the normal CI result are recorded
separately below. Exploratory service times collected during other builds are
retained as diagnostics and are not the published final benchmark.

## Feedback loop

The first deterministic red command took 24.31 seconds including PostgreSQL
setup and the plan assertion. The baseline dense caller capture took 89.81
seconds including 11.96 seconds of database setup. The first lateral-only dense
comparison took 93.37 seconds including 12.22 seconds of setup. The small
cardinality smoke kept the next query experiment narrow. A reserved quiet slot
is required for the final published measurements; other agents pause builds,
tests and seeds during that slot.

## Final measured result

The full matrix completed in 107.20 seconds, including 8.22 seconds of database setup. Other agents paused builds, tests and seeds. PostgreSQL was 17.11 on ARM64 Linux with 128MB shared buffers, 4MB work memory, default 100,000 JIT threshold and 500,000 full-optimization thresholds. Node was v26.4.0, postgres.js 3.4.9, and Drizzle 0.45.2.

All 36 cells passed complete positional SQL and final service output/order comparison. All absent-parent recursive arms read zero task rows. The deterministic work regression is green.

**The combined strict benchmark command exited 1.** The 60ms dense scoped badge goal remains unmet at 77.11ms. Four full-service cells also miss the predeclared2x goal: dense JIT-off list 1.82x, sparse JIT-on/off badges 1.60x/1.71x, and sparse JIT-off list 1.10x. These criteria remain in the harness and are not reported as passed. The deliverable is the independently proven query-work optimization with preserved results.

Warm ordinary full-service timings below are milliseconds, median(min–max), with five measured calls per arm after two warmups. The list page limit is 100.

| Fixture | Scope | JIT | Caller | Baseline | Treatment | Ratio |
| --- | --- | --- | --- | --- | --- | --- |
| small | scoped | on | badge | 6.54 (5.27–7.60) | 5.74 (5.53–7.01) | 1.14x |
| small | scoped | on | list | 13.24 (11.67–15.46) | 12.06 (10.57–14.84) | 1.10x |
| small | scoped | off | badge | 10.02 (8.09–11.62) | 9.26 (6.91–11.89) | 1.08x |
| small | scoped | off | list | 16.18 (14.36–17.22) | 18.78 (13.23–22.03) | 0.86x |
| small | unrestricted | on | badge | 6.53 (5.51–7.56) | 6.93 (5.96–7.90) | 0.94x |
| small | unrestricted | on | list | 16.59 (15.28–17.60) | 19.02 (14.90–20.94) | 0.87x |
| small | unrestricted | off | badge | 5.01 (4.99–6.70) | 6.49 (5.20–7.38) | 0.77x |
| small | unrestricted | off | list | 12.43 (10.19–17.69) | 11.54 (10.66–12.70) | 1.08x |
| dense | scoped | on | badge | 645.33 (607.50–1184.54) | 77.11 (54.52–121.13) | 8.37x |
| dense | scoped | on | list | 214.77 (186.22–264.03) | 29.87 (24.21–33.64) | 7.19x |
| dense | scoped | off | badge | 427.80 (323.86–452.47) | 59.91 (55.82–75.45) | 7.14x |
| dense | scoped | off | list | 55.69 (54.20–66.11) | 30.62 (29.64–37.22) | 1.82x |
| dense | unrestricted | on | badge | 41.05 (34.52–42.89) | 40.30 (36.24–42.94) | 1.02x |
| dense | unrestricted | on | list | 34.99 (28.71–92.45) | 43.25 (29.16–83.33) | 0.81x |
| dense | unrestricted | off | badge | 39.27 (37.17–50.13) | 42.41 (35.10–43.88) | 0.93x |
| dense | unrestricted | off | list | 30.33 (28.02–55.84) | 28.33 (27.35–44.69) | 1.07x |
| sparse | scoped | on | badge | 10.98 (10.11–11.67) | 6.84 (6.08–8.13) | 1.60x |
| sparse | scoped | on | list | 117.92 (114.43–127.75) | 13.22 (12.97–18.58) | 8.92x |
| sparse | scoped | off | badge | 10.77 (10.59–10.91) | 6.30 (5.76–6.51) | 1.71x |
| sparse | scoped | off | list | 16.61 (15.68–16.97) | 15.12 (12.08–16.08) | 1.10x |
| sparse | unrestricted | on | badge | 5.57 (5.12–7.80) | 6.81 (5.40–8.29) | 0.82x |
| sparse | unrestricted | on | list | 12.70 (11.74–15.09) | 13.19 (11.27–14.80) | 0.96x |
| sparse | unrestricted | off | badge | 6.11 (5.15–7.44) | 6.74 (6.58–6.96) | 0.91x |
| sparse | unrestricted | off | list | 15.79 (13.76–17.04) | 14.55 (12.96–16.51) | 1.09x |
| deep | scoped | on | badge | 7.78 (6.82–8.55) | 7.24 (6.72–8.35) | 1.07x |
| deep | scoped | on | list | 14.64 (13.10–15.62) | 14.50 (13.24–16.47) | 1.01x |
| deep | scoped | off | badge | 7.66 (6.76–8.50) | 7.12 (6.30–7.87) | 1.08x |
| deep | scoped | off | list | 16.06 (14.11–18.64) | 16.22 (14.04–17.86) | 0.99x |
| fanout | scoped | on | badge | 134.75 (120.71–163.75) | 19.76 (17.04–22.47) | 6.82x |
| fanout | scoped | on | list | 140.22 (133.39–149.43) | 18.03 (16.14–32.12) | 7.78x |
| fanout | scoped | off | badge | 16.68 (16.33–18.35) | 17.81 (16.99–18.59) | 0.94x |
| fanout | scoped | off | list | 19.95 (17.12–22.53) | 21.19 (16.64–57.80) | 0.94x |
| cycle | scoped | on | badge | 9.26 (7.75–10.56) | 8.46 (7.82–8.79) | 1.09x |
| cycle | scoped | on | list | 15.01 (13.85–16.24) | 15.72 (13.81–16.45) | 0.95x |
| cycle | scoped | off | badge | 7.17 (6.87–8.04) | 7.09 (6.61–8.29) | 1.01x |
| cycle | scoped | off | list | 14.78 (12.63–18.77) | 16.29 (13.92–17.36) | 0.91x |

Every small and unrestricted control stays within the original 25% or 2ms allowance. Their overlapping spreads and identical unrestricted SQL make these controls neutral. The dense unrestricted JIT-on list median rose 8.26ms, with wide overlapping 28.71–92.45ms and 29.16–83.33ms ranges; this is not a measured query change. The small scoped JIT-off list median rises 16.18→18.78 ms. Fan-out JIT-off service medians rise about 1.1–1.2 ms; the cycle JIT-off list rises 14.78→16.29 ms. These modest, overlapping controls are neutral/inconclusive. There is no claim that all paths improve.

In the dense JIT-on ranking plan, recursive task inspections fall 720,000→0 and recursive project probes fall 720,000→0. Estimated statement cost falls 103,000.61→20,458.73. The captured EXPLAIN execution falls 524.04→34.34ms and JIT 110.12ms→none. The dense JIT-off list statement EXPLAIN falls 29.52→1.89ms, while the complete service falls 55.69→30.62ms because the remaining enrichment and application work stays intact. EXPLAIN figures are separate diagnostic executions, not median SQL samples.

The first lateral-only draft estimated 101 ancestry rows. The final arm estimates 11, matching the one-node-per-generation contract. Both badge phases and all list enrichment statements are retained. This proves no hosted latency, CPU-capacity, or rollout claim. The local serial service savings are 568.22ms for the dense default-JIT badge and 184.89ms for the list. Request latency can recover only the affected serial work on its actual critical path; there is no correlated hosted request proof here.

Measured production source SHA-256: `a99faf974070a35f2786c92407e023c668c1f7b99b6604f6281c89bce089b1a8`. Baseline and treatment share the same index catalog, database, `issues.ts` hash `702674a98b82579078e9b4516e4a61c2043199fd89c1c2eb24c20d48cb3f8dde`, and participation-helper hash `9260d27bb3653aaaff6052cfc57a5877ed55069ee9cc7906458939899cd26173`.

## Verification status

The final-runtime focused PostgreSQL 17 run passed 44/44 tests across the dedicated work/ancestry suite, production privacy review, unread badge, and creation visibility suites in 70.44 seconds. This resolves the earlier skipped creation suite without discarding its 20-second setup failure. The scratch provider replaces only the native PostgreSQL process; normal repository database creation, migrations, clients, SQL and cleanup remain real. It is not part of this change.

Workspace typecheck and full build passed before replay. The full local
`pnpm test:run` attempt completed 940 native executor cases with 16 database
bootstrap failures, then was stopped with exit 143. An independent empty native
`initdb` failed with `semget` semaphore exhaustion before Paperclip schema or SQL
ran. This is a failed/incomplete local full-suite result, not a pass. A focused
Docker PostgreSQL retry and exact-head CI results are recorded in the PR.

## Review follow-up

The review requested a direct test of project-based ancestry. The added case
uses a private child, an open parent in a private project, and a grant on the
private grandparent. It checks access, changes the parent project to open and
back, and revokes the ancestor grant. The six-test ancestry suite passes.

The benchmark now lives in `server/scripts/` and imports `sql` from the package
name. A small real-PostgreSQL smoke verifies the relocated command. Runtime and
query-owner source hashes stay unchanged, so the original 36-case measurements
and the retained failed stretch goals still apply.
