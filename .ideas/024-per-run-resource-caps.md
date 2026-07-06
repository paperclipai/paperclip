# 024 — Per-Run Resource Caps

## Suggestion

Paperclip's liveness watchdogs (`task-watchdogs.ts`, `run-liveness.ts`, `issue-liveness.ts`)
catch runs that are **stuck or silent**, and the Diminishing-Returns Detector (idea 003) catches
agents that are unproductive **across runs**. Neither catches a single run that is *very much
alive and working* but has gone off the rails *within* the run — grinding for two hours, making
500 tool calls, or generating a massive output, burning tokens the whole time. A healthy
heartbeat is exactly what makes this failure mode expensive: nothing trips.

Add **per-run resource caps**: hard ceilings on a single run's wall-clock time, tool-call /
step count, and output/token volume, with a defined action when a ceiling is hit (graceful
wind-down, then stop).

## How it could be achieved

1. **Cap config.** Per agent / trust tier / company: `maxRunWallClockMs`, `maxToolCalls`,
   `maxRunTokens`, `maxRunCostCents`. Sensible defaults (looser for trusted, tight for
   `probation` — idea 009); all opt-in so current behavior is unchanged.
2. **Enforce in the run lifecycle.** `heartbeat.ts` already owns run start/tracking; track
   cumulative counters per run (tokens already flow through `cost_events`; tool-call/step counts
   come from the adapter execution stream). When a counter crosses its cap, signal the run to
   stop via the existing cancel path.
3. **Graceful wind-down, not a hard kill.** On hitting a cap, prefer asking the agent to wrap
   up and checkpoint its progress (so work isn't lost), then stop if it doesn't — reusing the
   continuation-summary machinery (`issue-continuation-summary.ts`) so the next run can resume.
4. **Explain and escalate.** Post a comment ("run stopped after 500 tool calls / $3.00 cap")
   and raise an inbox item so the operator can raise the cap or investigate. A run that
   *chronically* hits caps is a signal the task is mis-scoped.
5. **Compose with the budget/breaker stack.** Per-run cost caps are the run-level complement to
   company-level budgets (ideas 002, 019) and the fleet governor (001) — three nested layers:
   per run, per agent/company, per fleet.

## Perceived complexity

**Medium.** Wall-clock and token/cost caps are straightforward to track and enforce at the
existing run choke point. Tool-call/step counting depends on each adapter surfacing step events,
so coverage will be uneven across adapter types — wall-clock and cost caps work everywhere and
should ship first. The genuinely valuable, slightly harder part is the *graceful* wind-down +
checkpoint so a capped run resumes cleanly instead of losing work; a hard kill is easy but
wastes the partial progress.
