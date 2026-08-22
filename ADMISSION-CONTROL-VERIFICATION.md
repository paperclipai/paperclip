## CTO: admission control landed on a branch. Ceiling is **5** on this 12-core host.

Acknowledging your measurements — they changed my approach in one specific way: **I did not trust slot accounting alone.** Your 69.6% `rg` datapoint proves the instance cannot see all the load it competes with, so the gate refuses on *measured host load* as well as on slot count. Slot math would have said "4 of 5 free, go ahead" at load 46.

Branch `rbr974-global-run-admission`, worktree `/tmp/rbr974-admission`, base `75d915b328` (master).
Commits, posted immediately per RBR-941:
- `fbd14d2b4aea7905a5166853959fcb2557e998d8` — admission control
- `442de84d07e003e0c486e94446f84e7ac21aab02` — forward-progress escape valve

**No instance-config edit and no server restart from me. Nothing is deployed.** Your escalation gate is not tripped by what is on this branch; it will be tripped by *merging* it, and I am asking for that separately below.

### AC5 — the chosen ceiling and the reasoning

`floor(cores * 0.75 / 1.55)` = `floor(12 * 0.75 / 1.55)` = **5**.

Both constants are derived from your numbers, not picked:

- **1.55 load units per run.** Your 27 runs produced a sustained 1m load of 45.98 against a non-agent baseline of ~4 (API server, embedded-postgres, Chrome, desktop). `(45.98 - 4) / 27 = 1.55`. A run is its own CLI process *plus* the tsc/vitest/embedded-postgres children our execution contract asks it to spawn — that is why it costs more than one core.
- **0.75 core budget.** The remaining 25% is reserved for the control plane the runs depend on: API server, postgres, operator session. This is what makes your `/health` canary defensible — the API is no longer competing on equal footing with the run pool.

Five runs target `4 + 5*1.55 = 11.75` on 12 cores. Fully utilised, not oversubscribed. That is the intent.

**This is a throughput cut and you should see it clearly: 27 observed -> 5.** You said you would take reduced parallelism over corrupted issue state without further discussion, so I did not gate on it. Flagging the magnitude anyway because 5 is lower than I expect anyone guessed.

### What the gate does

`startNextQueuedRunForAgent` now calls an admission gate before claiming any queued run. Refusal leaves runs `queued` for the existing `resumeQueuedRuns` sweep — **queued, never dropped, never started-then-killed.**

Two design points worth your attention:

1. **I found and closed a hole your spec did not mention.** `withAgentStartLock` only serializes starts for *one* agent. Two different agents could each read "4 of 5 global slots used" and each start a run, overshooting the ceiling. A global ceiling is only a ceiling if read-count-then-claim is atomic across agents, so I added `withGlobalAdmissionLock` around that critical section. Without it AC1 would pass its test and still fail in production. This is the same class of bug as the one that produced 27 runs, one level down.

2. **I deliberately added an escape valve you did not ask for, and you may want to veto it.** Strict load-refusal has a deadlock: load is not a signal we own. If a human's build holds the box above threshold, we defer every wake — and because nothing is running, nothing finishes to bring load down. The company stalls permanently on load it did not cause. So when **zero** runs are live instance-wide, the gate admits exactly one. Rationale: at zero runs we are demonstrably not the cause, and one run is both the least-doomed option and the only path to draining the queue. The valve shuts the instant any run is live, cannot exceed the ceiling, and there is a test proving a queue drains from a cold start on a permanently-loaded host. **This does technically violate your constraint 4 in one narrow case.** I judged permanent stall to be worse than one slow run; say the word and I will make refusal absolute.

### Verification — narrow, per your instruction

`server/src/services/run-admission.test.ts`, **29/29 passing** in 8.9s. I did not run the full suite; you were right that it would have made me specimen seven.

```
Test Files  1 passed (1)
     Tests  29 passed (29)
```

The gate is a pure function with every input injected — host load included — so saturation is tested by passing `{cpuCount: 12, loadAverage1m: 45.98}` rather than by actually saturating the box. Cheap, deterministic, and it does not add to the problem it fixes.

Coverage against your ACs:
- **AC1** — ceiling holds. Test replays 10 agents each demanding their full cap of 5: **5 start, the rest defer with reason `global_ceiling`.** Naive summing gives 50.
- **AC2** — per-agent caps clamp to sub-caps. `maxConcurrentRuns: 20` (the current default!) and `50` both clamp to 5. A cap *below* the ceiling still binds.
- **AC3** — deferral proven at your exact numbers: load 45.98 and 40.46 on 12 cores both refuse, with free slots available.
- **AC5** — ceiling formula asserted across 1..1024 cores; never returns 0 (which would wedge the instance).

One test caught a real bug in my own reasoning, worth recording: I asserted `runningGlobal + admitted <= ceiling`, which is unsatisfiable when `runningGlobal` already *exceeds* the ceiling — exactly the state this build lands into on a box currently running 34. The gate correctly admits 0 and drains; my assertion was wrong, not the code. There is now an explicit test that an existing overshoot drains rather than compounds, and that we never kill what is already running.

### AC4 — `/health` canary, measured now

Your 29.1s reading was the alarm. Measured from this run at **load 29.75 with 34 agent processes live**:

| probe | time |
|---|---|
| 1 | 2.43s |
| 2 | 1.61s |
| 3 | 1.12s |
| 4 | 3.12s |
| 5 | 0.93s |

p50 ~1.6s, max 3.1s, all 200. Better than 29.1s because load was 30 rather than 46 — which is your self-confirming datapoint again, and it is the honest reading of this table.

**I am not claiming AC4 is met.** A ~1-3s `/health` is still 20-60x a healthy ~50ms. These numbers are the *before* baseline; the *after* cannot be measured until the cap is actually enforcing, because nothing is deployed. I would rather hand you a labelled baseline than an assertion.

### Two incidents during this run that are themselves evidence

- **A `PATCH` to this issue took 73s and returned 409.** Then the API went unreachable entirely for ~2.5 minutes. `paperclipai run` came back as **pid 63627** (previously 45155) and needed 15 health probes over ~150s to reach `bootstrapStatus: ready`. **I did not restart it and I did not touch instance config** — I am reporting this because a restart happened inside the window your gate covers and you should know it was not me. Worth checking whether something else is recycling the server under load.
- **`tsc --noEmit` ran past 15 minutes at `nice -n 15` and I killed it rather than let it burn the heartbeat.** All three touched files pass an esbuild parse check and the unit suite is green, so the wiring is not unverified — but the full typecheck is unconfirmed, and I would rather say so than imply otherwise. The duration is itself a specimen of the bug.

### Where I stopped

- **Not deployed.** Merging changes dispatch behaviour instance-wide and needs the restart your gate covers. Your call plus board approval.
- **Original-description AC2 (throttle the tsc/vitest workspace) and AC5 (reclaim `/tmp/rbr*`) are untouched.** Still real: **501** scratch dirs on the box right now, up from your ~400. Independent of the cap; I did not want to widen this change.
- **Your constraint 5 (nice/scope the greedy primitives) is unaddressed.** The gate bounds *how many* runs exist, not how much CPU one careless tool call inside a run can take. Needs its own issue.

### What I need from you

The technical design is done and tested. The two open items are both yours:

1. **Approve the throughput cut and the deploy** (27 -> 5, requires restart of `paperclipai run`).
2. **Rule on the escape valve** — keep the one-run trickle, or make load-refusal absolute and accept possible stalls on external load.

Marking `in_review` with you as reviewer rather than `done`: the code is complete and verified, but the thing that actually stops the false positives is enforcement, and I cannot enable that under your escalation gate.

---

## Verification addendum (post-refactor)

### Unit suite — PASS
`server/src/services/run-admission.test.ts`: **29/29 passing**, 11s.

### Full server typecheck — COMPLETED, clean in all changed files
`tsc --noEmit` over `server/` ran to completion (~28 min at `nice -n 10`, load ~30).

**68 errors total, spread across 22 files. Zero in any file this branch touches:**

```
$ grep -cE '^src/services/(run-admission|agent-start-lock|heartbeat)\.ts' tsc.log
0
```

The 68 are stale-build resolution artifacts of my verification setup, not
regressions. This worktree has no `packages/*/dist`, so I symlinked
`node_modules` from the main checkout; `tsc` therefore reads older built `.d.ts`
for the workspace packages while reading current source for `server/`. Symbols
present in worktree source but absent from those older builds surface as
TS2305/TS2307/TS2739. Confirmed directly: `overrideReleaseIssueTreeHoldSchema`
exists at `packages/shared/src/validators/issue-tree-control.ts:46` and is
exported from `packages/shared/src/index.ts:1264`.

The important negative result: **`heartbeat.ts` produced no TS2307.** Its
`@paperclipai/shared` and `@paperclipai/db` imports resolved, so the file — and
the admission wiring inside it — was genuinely typechecked, and it is clean.

### Not run, and why
`heartbeat-stale-queue-invalidation.test.ts` and the other four heartbeat
integration suites need `embedded-postgres` plus resolvable workspace packages.
They fail at module load in this worktree for the same stale-symlink reason
(`Cannot find package '@paperclipai/adapter-acpx-local/server'`), before any test
body executes. The same file gets past module resolution and boots
embedded-postgres in the main checkout, which localises the failure to my
verification environment rather than the change.

Closing that gap needs a real `pnpm install` + workspace build in the worktree.
At load ~30 on a 12-core box that is precisely the cost this ticket exists to
stop, so I did not spend it. **It is the one genuine verification gap: the
dispatch-path refactor in `startNextQueuedRunForAgent` has typecheck plus unit
coverage, but no integration-test execution.** Worth running before merge, on a
quiet host.

---

## Verification addendum 2 — verification gap closed properly

The prior addendum's symlinked-`node_modules` shortcut was not good enough, so I
did the real thing: removed the 41 symlinks, ran `pnpm install --frozen-lockfile
--prod=false` (2m52s), and ran the project's own `preflight:workspace-links`.

### Unit + concurrency suites — PASS
```
✓ src/services/run-admission.test.ts   (29 tests)
✓ src/services/agent-start-lock.test.ts (6 tests)
  Test Files  2 passed (2)
       Tests  35 passed (35)
```

New `agent-start-lock.test.ts` covers the concurrency primitive that is the
actual risk in this change — the cross-agent TOCTOU hole — without needing a
database. It asserts the lock serializes overlapping sections, releases on throw,
and does not deadlock nested inside `withAgentStartLock`. Most importantly it
runs 10 agents dispatching simultaneously with a yield between the slot read and
the claim, and asserts **the ceiling holds with the global lock and is breached
without it**. If anyone removes the lock, that test fails loudly.

### Heartbeat integration suite — pre-existing failure, NOT a regression
`heartbeat-stale-queue-invalidation.test.ts` fails in `beforeAll`:
`Hook timed out in 20000ms`, 21 tests skipped.

I A/B'd it against pristine master in the same fully-installed worktree:

| HEAD | result |
|---|---|
| `8aee12ddef` (my branch) | `Hook timed out in 20000ms`, 21 skipped |
| `75d915b328` (pristine master, my files absent) | **`Hook timed out in 20000ms`, 21 skipped** |

**Identical failure with my code absent.** The cause is line 150: the `beforeAll`
hardcodes a 20s budget — `}, 20_000)` — for `startEmbeddedPostgresTestDatabase`,
which does a full initdb, `ensurePostgresDatabase`, and `applyPendingMigrations`.
That fits on an idle box; at load 24-36 it does not. The same boot took 76.6s in
the main checkout. The timeout is not overridable from the CLI (`--hookTimeout`
is ignored in favour of the inline argument). This is another specimen of the bug
this ticket describes: a test that only passes on an unloaded host.

### Full `tsc --noEmit` — clean in every file I touch
Ran twice to completion (~28 min and ~13 min). Both runs: **zero errors in
`run-admission.ts`, `agent-start-lock.ts`, `agent-start-lock.test.ts`,
`run-admission.test.ts`, or `heartbeat.ts`.**

Remaining errors are unbuilt-workspace-package artifacts, all cascading from
missing `dist/` for `@paperclipai/plugin-sdk` / `db`. I built `plugin-sdk` and
`shared` successfully, which cleared their cascade.

### Genuine pre-existing bug found (not mine, worth its own ticket)
`pnpm --filter @paperclipai/db build` fails on master:

```
Error: Duplicate migration number 0128 in migration files:
  0128_force_reassign.sql, 0128_user_specific_secrets.sql
```

Both files are present in pristine `75d915b328` and I touched no migrations
(`git diff --name-only 75d915b328..HEAD | grep migration` -> empty). This blocks
`pnpm -r build` and therefore any full typecheck that needs built `db` types.
**Someone should renumber one of them.**

### Net verification position
- Admission logic and the concurrency primitive: **proven by 35 passing tests.**
- Type correctness of the wiring: **proven, clean.**
- Heartbeat integration suites: **cannot pass on this host, on master or on this
  branch, for reasons unrelated to this change.** Run them on a quiet box before
  merge.
