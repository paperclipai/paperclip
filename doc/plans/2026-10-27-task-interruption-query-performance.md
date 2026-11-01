# Task interruption latest-run query performance

The issue list displays a current interruption state for each visible task.
`taskInterruptionPresentations` owns that read-only projection. Its old latest-run
query grouped `coalesce(native_issue_id::text, issue_id::text,
context_snapshot->>'issueId')` across company history. That expression cannot use
the existing individual binding indexes to find a small page of tasks.

The query now probes the native, first-class, and legacy text indexes separately.
Each branch supplies its newest candidate. A lateral query selects the newest
candidate across those three branches by `created_at DESC, id DESC`. The final
join reads the same interruption fields for that winner in one SQL snapshot.
No history is deleted or hidden. This changes only the latest-run enrichment;
the main issue-list query and external-conversation state gates are unchanged.

## Contract and regression proof

Native binding takes precedence over first-class binding, then legacy JSON text.
A non-null mismatching native or first-class binding prevents legacy fallback.
A guarded UUID parameter keeps uppercase and noncanonical caller strings from
matching a UUID where the former text comparison would not. Legacy text keeps
PostgreSQL `->>` behavior for empty, missing, scalar, array, object, and null data.
Company boundaries, duplicate inputs, absent runs, and timestamp ties are covered.
The existing project-access interruption tests exercise real repair and retry
consumers. Presentation remains read-only; execution rechecks its own authority.

The baseline work regression selects six runs from a two-task page but inspects
1,506 run rows. The treatment meets a deterministic bound of fewer than 30 rows
in any run-table scan on that same fixture. The regression has no timing gate.
The baseline semantics test passes before the optimization.

## Local measurement

Run the actual old and new query builders against disposable PostgreSQL:

```sh
pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-task-interruption.ts --baseline-ref=09ad9adce2cf4742944353a3707a2f908e9bb35e
```

The pinned pre-fix service is loaded from Git. The harness rejects changed runtime
dependencies. Its service source is identical to the original discovery baseline
`96727b3cfefb61f85ffe1fbc29a9b6dd6837efe8` (Git blob
`eb489f1ef6d35c9c243307e60e4c31d58afddfa3`). Both arms use the same current dependencies.
The treatment service SHA-256 is
`4607c8382aea8ec9cc76f628caa9b4a031b19dd43ff4beff12e596079742b763`.

The fixtures use a second company, unrelated histories, mixed binding types,
fixed dates, and incompressible random context/result bodies. Mixed fixtures
retain historical null bindings by disabling only the fixture database's modern
scope-fill trigger during insert. The modern control leaves that trigger enabled.
The harness captures complete generated SQL and parameters, compares every
positional SQL field and row order, and compares full service maps. It warms each
arm twice, alternates five measured samples per arm, and saves local
`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` plans.

PostgreSQL 17.11 Linux aarch64 matches the observed hosted major/minor version.
Local settings: 128 MiB shared buffers, 4 MiB work memory, JIT enabled. These are
warm local SQL timings, including driver round trips, not deployed HTTP timings.

| Page × history per task | Unrelated runs | JSON noise bytes per field | Before median (range) ms | After median (range) ms | Speedup |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 × 1 | 0 | 128 | 0.61 (0.55–0.88) | 1.04 (0.90–1.92) | 0.58× |
| 100 × 1, mixed | 1,200 | 24,576 | 6.99 (5.89–8.41) | 2.59 (2.49–2.79) | 2.70× |
| 100 × 12, mixed | 1,200 | 24,576 | 17.17 (16.79–17.48) | 3.00 (2.64–4.28) | 5.72× |
| 1 × 120, mixed | 1,200 | 24,576 | 5.05 (4.39–5.89) | 2.45 (2.31–2.88) | 2.06× |
| 100 × 40, mixed | 1,200 | 12,288 | 31.51 (30.68–31.61) | 3.05 (2.50–3.23) | 10.32× |
| 100 × 40, modern | 1,200 | 12,288 | 26.78 (25.79–27.40) | 3.82 (3.47–4.78) | 7.02× |
| 1,000 × 1, modern | 1,200 | 12,288 | 9.99 (9.51–10.79) | 14.11 (13.72–16.33) | 0.71× |

All seven pairs have exact positional SQL and full service equality. The 100 × 12
plan drops shared buffer hits from 30,033 to 3,400. The modern dense control drops
45,563 to 7,537. The tiny control adds about 0.43 ms. The maximum-size shallow
modern page adds 4.12 ms (9.99 to 14.11 ms), with buffer hits increasing from
15,467 to 22,008. The extra probes cost more for such wide, shallow history.
These absolute costs are retained as tradeoffs; no adaptive threshold is added.
Each branch can still inspect a task's own history. The native index lacks
creation-time ordering and must sort native candidates. First-class and legacy
indexes also contain native-bound rows; the precedence guards can discard those
rows only after fetching them. A deeply native-bound task can therefore cause
three per-task history walks, even though each branch returns at most one row.
The modern 40-run control includes this effect; it does not establish constant
work at 10,000 runs per task.

Immediate follow-up for that remaining cost: profile a synthetic 10,000-run,
mostly native-bound task with complete result equality and per-branch
`EXPLAIN (ANALYZE, BUFFERS)` counters. First test a migration-free selection that
avoids repeated walks while retaining precedence and timestamp/ID ties. If an
index is still necessary, evaluate a company/native-issue/creation-time index,
a first-class binding index restricted to `native_issue_id IS NULL`, and a legacy
binding index restricted to both native and first-class bindings being null.
Measure the complete index builds and blocking on a production-size disposable
fixture. If a build exceeds the one-to-two-minute budget, first optimize it and
flag the remaining cost for human review. No partial index or startup DDL is
included in this PR.

## Feedback loop and practical limit

| Question | Environment and loop | Measured elapsed | Result |
| --- | --- | --- | --- |
| Does coalesced lookup inspect unrelated history? | Actual service SQL, disposable PostgreSQL | Initial red test 13.55 s | 1,506 inspected rows; semantic oracle passes |
| Does indexed selection preserve the contract? | Two real PostgreSQL regressions | 5.09 s repeated local test loop | Both pass |
| Is the first batched union enough? | Pinned source pair, PostgreSQL 18.6 | 3.73 s inside benchmark | 1.62× at 100 × 12; scans remain |
| Is selective lateral lookup better? | Seven paired PostgreSQL 17.11 cases | 8.39 s full command; 2.68 s database setup | 5.72× representative, 7.02× modern dense |

Dependency setup took 22.1 s. The baseline's patch configuration did not match its
committed lockfile, so the isolated install needed a local non-frozen resolution.
The lockfile is unchanged in this PR; its effective dependency record is retained
with private raw evidence. A larger existing consumer suite initially failed to
load because plugin-sdk had not been built. After normal build setup, all 19
focused query and authority-consumer cases passed. Full recursive typecheck and
build passed too. The full local suite was stopped after repeated native
PostgreSQL bootstrap failures; all 16 affected executor cases passed with the
Docker PostgreSQL 17 substitute. The full local suite is not counted as a pass.
The first Linux CI attempt also had one failure in an unchanged Runner close
fixture. One targeted job retry passed. A separate macOS diagnostic of that close
fixture still fails; its cause is not diagnosed by this query optimization.

The affected hosted query averaged about 110 ms in the discovery window. Even
eliminating that query can save at most its serial critical-path contribution;
other enrichment reads run concurrently. The local measurements do not establish
that contribution or explain the whole issue-list request. This bounded change
is useful alongside the other measured query fixes. Deployed latency remains to
be measured after rollout. No migration, startup job, deployment, or hosted
mutation is part of this PR.
