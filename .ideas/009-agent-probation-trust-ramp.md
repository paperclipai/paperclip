# 009 — Agent Probation & Staged Trust Ramp

## Suggestion

When a new agent is hired, it gets its full configured autonomy immediately — same
concurrency, same spend, same ability to act without review as a battle-tested agent. That's
risky: a misconfigured prompt or a flaky adapter can burn budget or make a mess before the
operator notices. Paperclip already models trust (`source-trust.ts`,
`trust-preset-resolver.ts` with presets and a `cross_company_boundary` notion), but trust is
**static** — set once, not earned.

Add a **probation period with a staged trust ramp**: newly hired agents start constrained
(low concurrency, mandatory review on outputs, tighter spend) and **automatically graduate**
to fuller autonomy as they accumulate a clean track record — or get held back / flagged if
they don't.

## How it could be achieved

1. **Probation state on the agent.** Add `trustStage` (`probation` → `trusted` → `senior`)
   and a `hiredAt` / `runsCompleted` counter. New agents default to `probation`.
2. **Stage → policy mapping.** Resolve effective limits from stage in
   `trust-preset-resolver.ts`: probation caps `maxConcurrentRuns` low (e.g. 2), forces the
   review/approval handoff on work products, and applies a reduced spend ceiling.
3. **Graduation criteria.** Promote when the agent clears thresholds: N completed issues,
   review approval rate above X%, no Diminishing-Returns trips (idea 003), spend within
   estimate. Evaluate on a routine (`routines.ts`) or at run completion.
4. **Demotion path.** A burst of rejected reviews or a budget-breaker trip (idea 002) drops
   the agent back a stage and raises an inbox item — autonomy that's revocable, not one-way.
5. **UI.** A trust badge on each agent ("Probation · 3/10 runs to graduate") and an operator
   override to fast-track or freeze a stage.

## Perceived complexity

**Medium.** The trust-preset machinery and review handoffs already exist, so this is mainly a
state field, a stage→limits resolver, and a graduation evaluator. The design effort is in the
criteria — too strict and good agents stay shackled; too loose and probation is theater. Best
shipped with conservative defaults and per-company tuning, and it composes cleanly with the
Fleet Concurrency Governor (001) and Diminishing-Returns Detector (003).
