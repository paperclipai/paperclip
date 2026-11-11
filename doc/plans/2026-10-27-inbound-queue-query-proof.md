# Inbound queue query proof

## Contract and cause

Paperclip's inbound queue discovers its next deadline, selects each conversation
head, and selects ordinary ready deliveries. A retained processed delivery can
still own the head while an issued or processing `inbound_wakeup` action remains.
This work keeps that obligation, company and endpoint scope, lease expiry,
retry timestamps, ordering keys, lifecycle dependencies, and provider exclusions.
It adds no cache, migration, producer, worker, or timer.

The two open-work selectors used a correlated `EXISTS` inside an `OR`. PostgreSQL
17.11 already used a hashed subplan in the measured fixture. The original
hypothesis of repeated physical action scans was wrong. The estimate still
included a large correlated alternative. It can enable JIT at the normal 100000
cost threshold. The deadline query also evaluated JSON conditions on retained
processed history before rejecting rows with no pending action.

The treatment uses a set of `(company_id, endpoint_id, delivery_id)` for pending
ownership. Null delivery IDs cannot match and are excluded, so the predicate
still returns a boolean. Duplicate actions do not multiply delivery rows.
Ready-only probes retain their original scoped `EXISTS`. This keeps the
readiness and retry parsing boundary outside this optimization.

## Reproduction

Run from the source checkout with its dependencies built:

```sh
pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-inbound-queue-discovery.ts --baseline-ref=09ad9adce2cf4742944353a3707a2f908e9bb35e --require-work-budget
```

The harness starts disposable PostgreSQL through the repository test helper.
It does not read a live database URL. It loads the pinned pre-fix queue,
entry-point, and ledger sources. Other runtime helpers and dependencies must
match. It captures the complete SQL and parameters through the real service,
including projections, ordering, limits, and the head probe's lease path.
It stops before provider effects. Every selected column is compared as a
positional row on one reserved SQL connection. Fixture deadlines are fixed. The small control has 20 completed deliveries
and actions. The retained-history case has 1500 of each, two open deliveries,
and 32 KiB of synthetic incompressible message text per historical delivery.

Two warmups precede five alternating samples per arm. Plans use
`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` outside the timed samples. The explicit
fixture work budget rejects JIT for the two changed selectors and more than
1000 shared buffer accesses (hits plus reads) for the deadline selection. It has no CI timing threshold.
Use `--jit-off` for a diagnostic control.

Local evidence uses Node 26.4.0 and Linux ARM64 PostgreSQL 17.11 in a disposable
Docker container, matching the hosted major and minor version. The normal
settings are shared_buffers 128 MiB, work_mem 4 MiB, JIT on, jit_above_cost 100000,
and random_page_cost 4. Native macOS PostgreSQL could not start because the host
had exhausted its SysV semaphore allocation. The scratch provider replaces only
the test PostgreSQL constructor. Schema migrations, clients and query execution
remain real. No persistent database is used.

## Results

Matched pre-fix baseline: `09ad9adce2cf4742944353a3707a2f908e9bb35e`.
An earlier baseline at `96727b3` had identical ledger and conversation-queue
sources. Master changed an unrelated health notification import in the service
entry-point, so the final comparison was repeated from the newer pre-fix base.
The ordinary-ready selector is an unchanged control. The head query still reads
its existing JSON ordering/filter fields; do not claim it reduces physical
history scans. Local SQL timings do not prove a hosted request speedup.

Final quiet PostgreSQL 17.11 comparison, in milliseconds. Each arm has two
warmups and five alternating samples. Parentheses show minimum–maximum.

| Actual selector | Baseline median (range) | Treatment median (range) | Ratio | Equality |
| --- | ---: | ---: | ---: | --- |
| deadline | 18.78 (18.43–20.41) | 1.58 (1.14–1.75) | 11.90x | 2 complete rows equal |
| head | 5.71 (5.38–6.40) | 6.18 (5.56–6.72) | 0.92x | 1 complete rows equal |
| ready | 9.23 (7.97–9.41) | 8.33 (7.72–9.21) | 1.11x | 1 complete rows equal |

- deadline: shared buffer hits 10662 → 455; JIT present → absent.
- head: shared buffer hits 10600 → 10600; JIT absent → absent.
- ready: shared buffer hits 66 → 66; JIT present → present.

The matched small control is neutral (overlapping sample ranges). The JIT-off
control remains diagnostic under other local build load: deadline 9.72 → 2.17 ms;
head 9.32 → 9.08 ms; ordinary ready 1.52 → 1.56 ms. The last two ranges overlap.
It separates deadline physical work from an earlier JIT-only head improvement.
The earlier small-then-large fixture put the head estimate at 100369.79 and
enabled JIT. The final pristine retained-only fixture put it at 98866.79, below
the threshold. Its head timing is neutral. Plan-cost threshold crossings are
data-sensitive; do not claim a head speedup for the final fixture.

## Feedback loop

| Question | Loop | Measured elapsed | Decision |
| --- | --- | --- | --- |
| Can the real source run locally? | Cached offline install, isolated build | 27.7 s install; 141 s build log span | Reuse the built checkout for each narrow attempt |
| Does the initial scan hypothesis hold? | Captured queries and real PG plans | 4.0 s inside the instrumented baseline harness, plus module loading | Reject repeated physical scans as the cause |
| Does the set improve the actual selectors? | Red work budget, alternating pair, JIT-off control | 28.36 s for all three processes, including module and DB setup | Exploratory variant identified JIT cost; final scope keeps ready-only unchanged |
| Does a selective ready probe remain scoped? | Original and treatment SQL with unrelated malformed retry data | 12 s focused attempt; 28 s after replay/module rebuild | Direct head probes return empty; actual OR selectors both return error 22007; keep readiness unchanged |

Coordination waits for a quiet benchmark interval are separate from these command
measurements. They are not a reason to run noisy parallel timing samples. The
small real-database regression loop takes about 11 seconds including transforms
and startup. Full repository checks and exact-head CI remain required.

## Scope of benefit

The discovery sample attributed 4.731 summed SQL seconds to 90 deadline
selections and 4.681 seconds to 97 head selections over about five minutes.
The final pristine fixture proves a deadline improvement; the head is neutral
at that data point. The ordinary-ready control accounted
for a further 1.389 seconds over 90 calls. These are background selectors, not a
correlated request critical path. The maximum improvement to a single affected
selection cannot exceed its observed SQL duration (about 49–53 ms on average).
No end-to-end latency or rollout claim follows from adding those overlapping
aggregate times. The change is small and avoids a recurring cost under the
hosted planner defaults, so it is worth shipping with the other proven fixes.

## Correctness and failure accounting

Five real-PostgreSQL tests cover tuple scope, duplicate/null actions, exact
boolean results, full payloads, future head ownership, independent reactions,
paused/attention/agentmail exclusions, retry/processing deadlines, and provider
sequence ordering. Six existing assembled chat tests also pass. They cover
lease renewal failure, reverse-arrival Slack and Telegram events, lifecycle
retry, edit/admission races, and deadline restoration.

An exploratory malformed-retry test compared an actual OR selector against an
AND-only oracle. That comparison was inconclusive. It must not be presented as
proof of an introduced defect. The complete actual old and new OR selectors
both return PostgreSQL error 22007 for unrelated malformed pending actions in
the measured fixture, including other-company and null-delivery controls. The
selective direct head probe returns empty on both versions. The final fix leaves
ready-only evaluation unchanged.

The initial repeated-action-scan hypothesis was also rejected. Both arms scan
action history once in the measured plans. The benefits come from query costing
and filter order, rather than fewer physical action scans.

## Final verification

- `pnpm -r typecheck`: pass.
- `pnpm build`: pass.
- New and selected existing assembled PostgreSQL 17 suites: 11 passed.
- Complete local suite: not run because the native host PostgreSQL startup
  blocker is already established; complete final-head CI remains the gate.
- Final retained-history benchmark work budget: pass, complete positional
  equality for all three selectors.
- The final benchmark process took 34.19 seconds from
  its instrumented setup through proof. This includes the coordination wait after
  the fixture and queries were ready. The actual timing phase was brief.

The PR contains the source, fixture and harness. Raw local JSON includes every
sample, query, parameter and plan. No hosted rollout was performed.

## Additional failures retained

Greptile's first review found two proof gaps: the budget counted only cache
hits, and the payload test read the row again instead of checking the captured
selection. Both are fixed. The budget includes hits plus reads. The test compares
the captured row's complete normalized payload with its seeded object.

A prepared timing attempt lost its idle pooled connection while waiting. Its
now()-derived fixture value differed between queries, so equality stopped the
run before samples. The harness now reserves its timing connection and uses an
explicit follower deadline. The final quiet comparison passes.

The first CI head failed e2e shard 3 in `agent-chat-projects` cleanup: cancelling
a heartbeat run timed out on a row lock and returned HTTP 500. This is outside
the changed queue selector. The final head must still pass that check. The
original log remains at https://github.com/paperclipai/paperclip/actions/runs/40624302918/job/122605509182.
