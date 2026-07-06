# Combo 01 — Corrected Phase Scope

Companion to [`combo-01-runtime-control-plane.md`](combo-01-runtime-control-plane.md), whose
**Phasing** section now carries a condensed version of this plan. This file is the detailed
expansion — per-phase exit criteria and the full changed-vs-original rationale. It exists because the original phasing
schedules the eight *ideas* but not the four *shared seams* they all write through — so as written,
Phase 1 builds those seams single-purpose and Phases 2–4 retrofit them, recreating the exact
"competing writers / five reimplementations" anti-pattern the combo exists to prevent.

## Governing principle

The value of fusing these eight ideas is **compose-by-construction**. That only holds if Phase 1
builds four things as *extension points*, not as single-purpose code:

1. **The effective-cap resolver** — one function that reduces all cap writers to a single number,
   honoring a fixed precedence. In Phase 1 it has one input (the configured default); later phases
   register more. Building it now is what stops Phases 2–3 from each bolting on a competing writer.
2. **The admission seam** — the single choke point at `heartbeat.ts:8207` (today
   `availableSlots = maxConcurrentRuns - runningCount`) that every run start passes through. Must be
   the *only* path a run can start, including process recovery and scheduled retries.
3. **The run-selection / wakeup hook** — the "which waiting run starts next" decision, made
   **pluggable** so WIP (061) and lock-awareness (042) refine it later without a rewrite.
4. **The reconciler** — the crash-safety timer that recomputes live state from ground truth.
   Designed from day one to reconcile *counters and leases*, not only slot counts.

Precedence order (locked now, even though only the last writer exists in Phase 1):

```
panic/drain  >  predictive breaker  >  manual override  >  schedule  >  configured default
```

---

## Phase 1 — Foundations: the four seams + fleet/company cap
**Target: ~2–3 weeks. Independently shippable. This is the phase the original underscoped.**

Deliverables:

- **Effective-cap resolver** with the precedence order above wired as a registry, seeded with a
  single writer (configured default). Ships with a unit test that asserts precedence resolution so
  later writers can't silently reorder it.
- **Manual override writer** — the "boost / quiet now for N hours, then auto-revert" control. It is
  *not* attributed to any idea in the original doc but appears in the precedence order, so it gets an
  owner here, next to the resolver. (Pulled forward from fragments in 005 and 014.)
- **Fleet + per-company concurrency cap (001).** `instanceMaxConcurrentRuns` on
  `instance-settings.ts`; per-company `maxConcurrentRuns` column in `packages/db`. Central
  `run-admission` counter keyed by `{instance, companyId}`, modeled on the acquire/release primitive
  at `plugin-job-scheduler.ts:298`.
- **Admission seam.** Gate the launch at `heartbeat.ts:8207`; runs past the cap enter a
  `queued_admission` state instead of starting. Audit every admit/defer to `activity-log.ts`.
- **Pluggable run-selection hook.** On slot release, a `selectNextRun` function (default:
  highest-priority waiting run) fires the existing `issue-assignment-wakeup.ts` path. Defined as an
  extension point now so 061/042 refine it in Phase 4 without touching the seam.
- **Reconciler (crash-safe).** Timer that recomputes live counts from actual run state, reclaiming
  leaked slots. Its interface takes a *ground-truth source* so per-run counters (P2) and lease claims
  (P4) plug into the same loop. Must cover `heartbeat-process-recovery` and scheduled-retry paths.
- **UI.** "Running N / cap M · K waiting" badge (instance + per-company row) over the live-events
  websocket.

Exit criteria: with 30 agents configured for 20 runs each and an instance cap of 10, real concurrency
never exceeds 10; killing the server mid-run and restarting reclaims the slot within one reconciler
tick (no permanent leak); the badge reflects true running/waiting counts.

---

## Phase 2 — Per-run ceilings + the Big Red Button (manual)
**Depends on: Phase 1 seam, resolver, reconciler. Target: ~2 weeks.**

Deliverables:

- **Graceful checkpointed wind-down primitive (built once, shared).** The enabling substrate for
  *both* items below — reuses `issue-continuation-summary.ts` / `run-continuations.ts` so a stopped
  run checkpoints and resumes instead of losing partial work. Called out explicitly because the
  original phasing assumes it twice without scheduling it; if it's weak, both 024 and 014-panic
  silently degrade to work-destroying hard kills.
- **Per-run resource caps (024), sub-phased per the idea's own guidance:**
  - *2a — ships everywhere:* `maxRunWallClockMs` and `maxRunCostCents`, enforced against
    `cost_events` at the run choke point, terminating via the wind-down primitive.
  - *2b — uneven adapter coverage:* `maxToolCalls` / step counts, gated on each adapter surfacing
    step events. Do **not** block 2a on this.
  - Per-run cumulative counters register with the Phase-1 reconciler (survive crashes).
- **Panic Stop + Drain (014), manual only.** Instance/company `executionState`
  (`running`/`draining`/`halted`) checked *at the Phase-1 seam*. Panic = halt + cancel via the
  existing cancellation path (`issue-tree-control.ts`, `recovery/service.ts`). Drain = refuse new
  starts, live "N draining…" readout. Safe resume re-admits gradually through the resolver — **not** a
  stampede. Register `panic/drain` as the top-precedence cap writer.

Note: 014's *auto*-drain-under-burn hook is deliberately deferred to Phase 3 (it needs 002). Phase 2
ships the button; Phase 3 wires the trigger.

Exit criteria: a run exceeding its wall-clock or cost cap checkpoints and stops with partial work
recoverable; Panic Stop halts every in-flight run and blocks new starts within one tick; resume ramps
back through the cap rather than launching everything at once.

---

## Phase 3 — Reactive throttling: burn breaker + schedules
**Depends on: resolver (writers), cost aggregation. Target: ~2 weeks.**
**This is where automated runaway-spend protection — the combo's headline justification — actually lands.**

Deliverables:

- **Prerequisite check: real-time-enough burn signal.** Confirm `costs.ts`/`finance.ts` aggregate
  spend at a latency the forecaster can act on; add a rolling windowed burn metric (5/15/60 min) if
  the existing aggregation is too batchy. The breaker is only as good as this signal.
- **Predictive Budget Circuit Breaker (002).** `timeToLimit = remainingBudget / burnRate` vs a
  configurable horizon; graduated responses (warn → throttle → pause non-critical). Registers as a
  cap writer above `manual override`. **Hysteresis / cooldown is mandatory** to avoid
  throttle↔un-throttle oscillation.
- **Auto-drain hook (completes 014).** Under extreme burn, the breaker invokes Drain from Phase 2 —
  the deferred half of the Big Red Button.
- **Spend-Schedule / Quiet Hours (005).** Time-windowed `{maxConcurrentRuns, maxBurnPerHour}` profiles
  built on `routines.ts`; registers as the `schedule` cap writer (below manual, above default).
  Timezone/DST correctness on the company; ship presets so operators skip cron authoring.

Exit criteria: a company forecast to exhaust budget within the horizon has its effective cap lowered
*before* the wall, without oscillating; a scheduled quiet-hours window shifts the cap at the boundary
and manual override still wins over it.

---

## Phase 4 — Scheduling refinements (split into two tracks)
**Depends on: the Phase-1 selection hook. The original bundled three ideas here; split them.**

**Track 4A — Flow & cadence (refine selection + heartbeat). Target: ~2 weeks.**

- **Adaptive Heartbeat Cadence (035).** Idle-backoff first (highest ROI, lowest risk): exponentially
  lengthen intervals after empty heartbeats, kept reachable by `issue-assignment-wakeup.ts`.
  Speed-up-under-load second, bounded by the Phase-1 cap and Phase-2 per-run caps. Hysteresis to avoid
  cadence oscillation.
- **WIP Limits & Flow Control (061).** Per-agent in-progress caps enforced by *refining the Phase-1
  `selectNextRun` hook* (don't hand work to a maxed-out agent) — not a new seam. Ship per-agent WIP +
  flow metrics (cycle time, throughput) first; team/stage limits and start/finish alarms follow.

**Track 4B — Workspace correctness (independent concern, can parallelize or defer). Target: ~2 weeks.**

- **Workspace Conflict Coordination (042).** Start with collision *detection* from the existing
  `workspace-operations.ts` op log (pure visibility, zero risk). Then path-level soft locks via the
  lease pattern (`environment-runtime.ts` / `environmentLeases`), whose expiry registers with the
  Phase-1 reconciler. Then the selection hook factors lock contention (don't wake an agent whose only
  work is locked). Flagged as its own track because it's about *file safety*, not the cap plane — it
  reuses the seams but delivers value independently and can slip without blocking 4A.

Exit criteria: an idle agent's cadence backs off and still responds instantly to a real event; an
agent at its WIP limit is steered to finish rather than start; two agents targeting the same file
surface a collision instead of silently clobbering.

---

## What changed vs. the original phasing

| Original | Correction | Why |
|----------|-----------|-----|
| Phase 1 = "seam + cap + reconciler" | Phase 1 also builds the **resolver, manual-override writer, and pluggable selection hook** | Otherwise P2–P3 retrofit competing cap writers and P4 rewrites selection twice |
| Reconciler = one-off in P1 | Reconciler **designed for counters + leases** from day one | It accretes scope in P2 (per-run counters) and P4 (leases) |
| 024 as one P2 item | 024 **sub-phased** (wall-clock/cost everywhere; tool-calls where adapters support it) | The idea itself says cost/wall-clock ship first; adapter step coverage is uneven |
| Wind-down assumed inside 024 + 014 | Wind-down is an **explicit shared P2 primitive** | Both items degrade to work-losing hard kills without it |
| 002 in P3, no prereq | P3 opens with a **burn-signal freshness check** | The forecaster is only as good as cost-aggregation latency |
| 014 as one P2 item | 014 **split**: manual button (P2), auto-drain hook (P3) | Its auto-trigger depends on 002, which lands in P3 |
| Phase 4 bundles 035+061+042 | Split into **4A flow/cadence** and **4B workspace** | 042 is a separable file-safety concern; bundling hides ~2 wk of work in the last slot |

Net effect on estimate: unchanged envelope (~6–9 engineer-weeks) but honestly distributed —
Phase 1 grows to ~2–3 weeks (it was underscoped), and Phase 4's hidden third idea is surfaced as a
parallelizable track rather than a silent overrun.
