# Per-Run Token Ceiling — G3 hard-stop (shipped) Overview

> Written 2026-06-14. Covers fix-backlog **#7** (per-run token ceiling was
> suppression-only) and **#10** (missing G3 tests). Background, the scope
> reduction and why, the solution, and the flow. Commit: `c8e243cd`.

---

## Background — why this work exists

The burn guard has three windowed/loop layers, but a gap between them:

| Guard | Catches | Misses |
|---|---|---|
| G2 monthly budget | slow bleed over a calendar window | one fat run under the monthly cap |
| G4 loop breaker | many runs in a tight loop | one fat run that isn't a loop |
| G3 per-run ceiling | **(was suppression-only)** | a single run over the ceiling |

A single pathological run — say 5M tokens in one wake, well over the 1M per-run
ceiling but under the 8M monthly agent budget — slipped **both** G2 and G4. The
existing G3 code only *suppressed the next max-turn continuation*, and only for
max-turn-exhaustion failures: it never paused the agent, never opened an
incident, and did nothing for a successful-but-huge run.

---

## Scope reduction — what "#7" actually delivers, and why

The backlog framed #7 as "hard-kill a fat run **mid-flight**." That is **not
achievable** in the current architecture:

- The adapter runs as a **subprocess** (the Claude CLI) and emits **no streaming
  usage** during execution.
- Per-run token totals are only known **post-run** (`heartbeat.ts:8936`, after
  the run returns).

So there is no mid-execution signal to cancel on. A true mid-flight kill would
require the adapter protocol to stream usage during the run — a large
cross-cutting change, its own project.

**Delivered instead: post-run hard enforcement.** Once a finished run's tokens
exceed the ceiling, the agent is paused and an incident is opened — so the *next*
run can't proceed. The fat run that already ran is sunk cost (we only learn its
size at the end), but the runaway is stopped immediately and surfaced to the
operator, rather than being silently absorbed as today. This was an explicit,
user-approved scope decision.

---

## Solution

New `per-run-ceiling.ts`, a twin of `run-breaker.ts` / `instruction-readiness.ts`:

```
evaluate(runTotalTokens, ceiling):
  ceiling <= 0            → null   (disabled)
  runTotalTokens <= ceiling → null
  else                   → fault { reason: "per_run_ceiling", runTotalTokens, ceiling }

trip(companyId, agentId, fault):
  ensure sentinel policy → pause agent (status=paused, pauseReason="budget")
  → open per_run_ceiling incident (budget_override_required approval + budget_incidents row)
```

Hooked into `updateRuntimeState` — the post-run record that fires for **every**
finished run (including the liveness path), gated on `guards.enabled` and a
positive `maxTokensPerRun`. The incident flows through the existing
budget-incident surface, so the operator resume/raise controls already built
apply unchanged.

Also extracted `resolveEffectiveMaxTurns(agentTurns, guardTurns)` as a pure
helper from the inline G3 turns-clamp, so the floor behavior (clamp an agent
above the floor down; keep a tighter agent cap) is unit-testable (#10).

---

## Flow

```
adapter run finishes (post-run)
  → updateRuntimeState(agent, run, result)
     → record runtime totals + cost event
     → hasTokenUsage && guards.enabled && perRun.maxTokensPerRun > 0?
        → runTotalTokens = input + cached + output
        → perRunCeiling.evaluate(runTotalTokens, ceiling)
             ── over ceiling ──► perRunCeiling.trip():
                                   pause agent + open per_run_ceiling incident
                                   → next wake blocked by getInvocationBlock /
                                     invokability until operator resumes
             ── under ─────────► no-op
```

Complements (does not replace) the existing continuation-suppression at the
max-turn path — that still avoids scheduling a retry that would now be blocked
by the pause anyway.

---

## Where it sits among the three guard layers

```
single fat run ────────────► G3 per-run ceiling (this) → pause + incident
many runs, tight loop ─────► G4 breaker            → pause + incident
slow bleed over a month ───► G2 monthly budget     → pause + incident
empty-bundle / idle wake ──► W1 / W2 pre-wake gates → skip / pause (no run)
```

Each layer is independent; together they bound every shape of token burn.

---

## Verification

- `server/src/__tests__/per-run-ceiling.test.ts`:
  - evaluate: over ceiling → fault; at/under → null; ceiling ≤ 0 → null.
  - trip (embedded-pg): agent paused, per_run_ceiling incident + approval opened
    with the right payload.
  - resolveEffectiveMaxTurns: clamp-down, keep-tighter, unset→floor.
- Regression: guard-budget / guard-breaker / wake-readiness / heartbeat-list all
  green; turns-clamp behavior preserved by the extracted helper.

No DB migration; reuses the budget-incident schema and the agent pause path.

---

## Still open

- **True mid-flight kill** — needs adapter streaming usage (out of scope; its own
  project). The fix-backlog should be updated to reflect that #7 shipped as
  post-run enforcement, with mid-flight kill tracked separately if ever needed.
