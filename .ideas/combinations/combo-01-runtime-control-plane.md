# Combo 01 — Unified Runtime Control Plane (Load, Spend & Safety Governor)

**Combines:** 001 Fleet Concurrency Governor · 002 Predictive Budget Circuit Breaker ·
005 Spend-Schedule / Quiet Hours · 014 Emergency Stop & Drain Mode · 024 Per-Run Resource Caps ·
035 Adaptive Heartbeat Cadence · 061 WIP Limits & Flow Control · 042 Workspace Conflict Coordination

## The unified idea

Today Paperclip enforces concurrency only *per agent*, has no instance/company cap, hits budgets
post-hoc, can't throttle by time of day, can't stop everything at once, and can't cap a single
runaway run. These are eight separate ideas — but they are all the **same control surface** asking
one question at one choke point: *"should this run start right now, and if so, how big may it get?"*

Build **one admission-and-throttle control plane** that owns that decision. Every run start passes
through a single seam that evaluates a stack of nested limits:

- **Per run** — wall-clock, tool-call, token, and cost ceilings with graceful checkpointed
  wind-down (024).
- **Per agent** — existing `maxConcurrentRuns` plus adaptive heartbeat cadence so idle agents back
  off and busy ones speed up (035), and WIP limits so agents *finish before they start* (061).
- **Per company / instance** — a fleet concurrency cap with a queue-and-wakeup-on-free-slot pattern
  (001), modulated by time-based quiet-hours/burst profiles (005) and a predictive budget breaker
  that throttles *before* the wall, with hysteresis to avoid oscillation (002).
- **Cross-cutting safety** — a Big Red Button: **Drain** (stop starting, let in-flight finish) and
  **Panic Stop** (halt + cancel), with gradual non-stampeding resume back through the governor (014).
- **Workspace correctness** — admission also respects file/path soft-locks so parallel agents don't
  clobber each other; don't wake an agent whose only available work is fully locked (042).

One precedence order resolves all the throttles writing the same "effective cap": **panic/drain >
predictive breaker > manual override > schedule > configured default.**

## Why combining wins

These features individually each need: a run-start choke point, a live counter that survives crashes,
a reconciler, and a UI badge for "running N / cap M / K waiting." Building them separately means five
re-implementations of the same fragile slot-accounting and five competing writers to the effective
cap. Built as one plane they *compose by construction* and share one reconciler, one audit path
(`activity-log.ts`), and one dashboard readout. The `plugin-job-scheduler.ts` `maxConcurrentJobs`
gate is the in-repo template for the acquire/release primitive.

## Phasing

**Governing principle.** The value of fusing these eight ideas is *compose-by-construction*, and
that only holds if Phase 1 builds four shared seams as **extension points**, not single-purpose code —
otherwise Phases 2–4 retrofit competing cap writers and rewrite the selection logic, recreating the
exact anti-pattern this combo exists to prevent. The four: (1) an **effective-cap resolver** with the
precedence order below, seeded with one writer but built as a registry; (2) the **admission seam** at
`heartbeat.ts:8207` as the *only* path a run can start; (3) a **pluggable run-selection/wakeup hook**
so WIP (061) and locks (042) refine it later without a rewrite; (4) a **reconciler** designed to
reconcile *counters and leases*, not only slot counts.

Precedence (locked in Phase 1, even though only the last writer exists then):
`panic/drain > predictive breaker > manual override > schedule > configured default`.

1. **Foundations — four seams + fleet/company cap (~2–3 wk, independently shippable).** The cap
   resolver + precedence registry; the **manual-override writer** (orphaned in the source ideas — owned
   here); fleet + per-company cap (001) on the `plugin-job-scheduler.ts:298` acquire/release template;
   the admission seam (runs past cap → `queued_admission`); the pluggable `selectNextRun` hook firing
   `issue-assignment-wakeup.ts`; the crash-safe reconciler (covers process recovery + scheduled
   retries); the "running N / cap M · K waiting" badge.
2. **Per-run ceilings + Big Red Button, manual (~2 wk).** Graceful checkpointed **wind-down as an
   explicit shared primitive** (`issue-continuation-summary.ts`) — both items below degrade to
   work-losing hard kills without it. Per-run caps (024) **sub-phased**: `maxRunWallClockMs` +
   `maxRunCostCents` everywhere first, `maxToolCalls`/step counts only where adapters emit step events;
   counters register with the reconciler. Panic Stop + Drain (014, manual) on the Phase-1 seam via the
   existing cancel path; safe non-stampeding resume through the resolver.
3. **Reactive throttling — where automated runaway-spend protection actually lands (~2 wk).** Opens
   with a **burn-signal freshness check** on `costs.ts`/`finance.ts` (the forecaster is only as good as
   its aggregation latency). Predictive breaker (002) with mandatory hysteresis, registered above
   manual override; the **auto-drain hook** that completes 014; time-based profiles (005) on
   `routines.ts` as the `schedule` writer with tz/DST correctness.
4. **Scheduling refinements — split into two tracks.** *4A Flow & cadence (~2 wk):* adaptive heartbeat
   (035, idle-backoff first) + WIP limits (061) that refine the Phase-1 `selectNextRun` hook rather
   than adding a seam. *4B Workspace correctness (~2 wk, parallelizable/deferrable):* conflict
   coordination (042) — collision *detection* from the `workspace-operations.ts` op log first, then
   soft locks via the lease pattern (expiry registers with the reconciler), then lock-aware selection.
   Split out because 042 is a file-safety concern, not the cap plane; it reuses the seams but delivers
   value independently.

*Corrections vs. an idea-by-idea phasing: the resolver/manual-override/selection-hook are pulled into
Phase 1 (else P2–3 add competing writers, P4 rewrites selection twice); the reconciler is scoped for
counters + leases up front; 024 and 014 are each split; wind-down and the burn-signal prereq become
explicit deliverables; Phase 4's hidden third idea (042) is surfaced as its own track. Net envelope
unchanged (~6–9 wk), just honestly distributed — Phase 1 was underscoped at ~2 wk. See
[`combo-01-phasing-corrected.md`](combo-01-phasing-corrected.md) for per-phase exit criteria and the
full changed-vs-original rationale.*

## Ratings

- **Difficulty:** High — the seam is small, but crash-safe distributed slot accounting and a single
  honored choke point (including process recovery and scheduled retries) are the hard, correctness-
  critical core. A leaked slot slowly deadlocks the fleet; a missed choke point makes "stop" a lie.
- **Estimated time to complete:** ~6–9 engineer-weeks (phased; phase 1 ~2 weeks is independently shippable).
- **Importance:** 9/10 — directly prevents runaway API spend, machine thrash, and rate-limit storms,
  the single biggest risk of an always-on autonomous fleet. Almost every other idea composes onto it.
