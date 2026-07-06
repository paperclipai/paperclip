# 002 — Predictive Budget Circuit Breaker

## Suggestion

Budgets today are mostly a **post-hoc ledger**: spend is tracked and a hard stop trips when
a limit is crossed. By the time the limit is hit, the money is already spent. Add a
**predictive circuit breaker** that watches burn rate and intervenes *before* the wall —
throttling concurrency or pausing low-priority agents when a company is forecast to blow
its budget within a chosen horizon.

Example operator experience:
> "At the current burn rate ($4.10/min), Company *Granola-clone* will exhaust its daily
> budget in 38 minutes. Auto-throttling non-critical agents from 12 → 4 concurrent runs."

This turns budgeting from a guardrail you slam into, into a control loop that smooths spend.

## How it could be achieved

1. **Burn-rate signal.** `costs.ts` / `finance.ts` already aggregate spend. Add a rolling
   windowed burn computation (e.g. spend over the last 5/15/60 min) exposed as a derived
   metric per company.
2. **Forecast.** `timeToLimit = remainingBudget / currentBurnRate`. Compare against a
   configurable `breakerHorizonMinutes`.
3. **Graduated responses** rather than a single hard stop:
   - *Warn* — surface an inbox item / dashboard banner.
   - *Throttle* — lower the company's effective concurrency cap (pairs directly with
     idea 001, the Fleet Concurrency Governor).
   - *Pause* — stop non-critical agents (those whose current issue isn't on the goal's
     critical path), leaving the CEO/critical agents running.
4. **Config.** Per-company breaker policy in budgets settings: horizon, which response
   tier, and a "protected roles" allowlist.
5. **Audit.** Log every breaker action to `activity-log.ts` so operators can see exactly
   when and why autonomy was throttled.

## Perceived complexity

**Medium.** The spend ledger and budget primitives already exist, so this is mostly a
derived-metric + policy-engine layer on top, plus a clean integration point with the
concurrency governor. The subtle part is avoiding oscillation (throttle → burn drops →
un-throttle → burn spikes → throttle …); needs hysteresis / a cooldown, similar in spirit
to the `freeze` cooldown concept. No schema-heavy work required.
