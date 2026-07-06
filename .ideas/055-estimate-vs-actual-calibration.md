# 055 — Estimate-vs-Actual Calibration

## Suggestion

Paperclip tracks what work *actually* cost (`cost_events`, run timing) but a code scan finds **no
estimate** on issues at all — no expected cost, effort, or duration. So there's no way to ask the
question every operations team lives on: *did this take what we thought it would?* Without
estimates and a comparison to actuals, agents (and operators) can't improve their forecasting, the
Dry-Run Estimator (idea 004) and budgets have no per-issue expectation to anchor to, and a task
that quietly costs 5× its mental budget looks identical to one that came in on plan.

Add **estimates on work, plus estimate-vs-actual calibration**: capture an expected cost/effort
when work is created, compare it to the real outcome, and learn per-agent/per-work-type forecasting
accuracy over time.

## How it could be achieved

1. **Add an estimate to issues.** A lightweight expected-cost / expected-effort field, set by the
   creating agent or operator when work is defined (the planning skills already reason about
   estimates — this persists them on the issue). Optional, so nothing breaks if absent.
2. **Capture the actual.** On completion, the real cost (`cost_events`) and elapsed time are
   already known — record them alongside the estimate to form an estimate/actual pair.
3. **Calibration score.** Per agent (and per work-type/role), compute forecast accuracy — mean
   ratio of actual/estimate, bias (chronically over- or under-estimating), and variance. "Eng-bot
   underestimates by ~40% on refactors" is directly actionable.
4. **Feed it forward.** Use calibration to auto-adjust future estimates (apply the agent's known
   bias), to flag in-flight work trending far past its estimate (early-warning, complements the
   Diminishing-Returns detector idea 003 and per-run caps idea 024), and to improve the Dry-Run
   Estimator's projections (idea 004).
5. **Surface it.** A calibration view per agent and a "biggest estimate misses this week" list —
   the misses are where scoping or capability problems hide.

## Perceived complexity

**Low–Medium.** Actuals already exist; the additions are an estimate field, the paired record, and
an analytics/calibration layer — no execution-engine changes. The real work is behavioral and
statistical: getting agents to produce *meaningful* estimates (a garbage estimate calibrates
nothing), and handling small samples / high variance honestly so calibration guides rather than
misleads. Ship estimate capture + the simple actual/estimate comparison first; bias-correction and
auto-adjustment are natural follow-ons once enough pairs accumulate.
