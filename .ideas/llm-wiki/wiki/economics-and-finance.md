---
title: Economics, Finance & Capital Allocation
type: concept
status: reviewed
sources: [013, 019, 030, 037, 055, 063, 007, 049, combo-04, xcombo-03, xcombo-08, research-sources]
updated: 2026-06-24
---

# Economics, Finance & Capital Allocation

Paperclip tracks *spend* well but can't answer the question that matters for a *business*: is it making
more than it costs, and where is it heading? This is the money stack.

## The CFO suite (combo-04)

Six organs over one cost/revenue/outcome data model:
- **Revenue & P&L (030)** — record income (manual, governed agent-reported, Stripe/Paddle webhook) →
  profit, margin, MRR, goal progress *in dollars*.
- **Unit economics (013)** — cost per shipped outcome, rework ratio, idle spend (per agent/role/goal).
- **Token budgets (019)** — make tokens a first-class budget metric (remove the `metric!=billed_cents
  →return 0` short-circuit) so subscription/flat-rate users get a real guardrail.
- **Cache optimization (037)** — surface cache-hit rate; stable-prefix context = found money.
- **Estimate calibration (055)** — estimate vs actual → per-agent forecasting bias.
- **Forecasting (063)** — runway, projected goal-attainment date, capacity needs.

## The Cost-Attribution Spine (xcombo-03)

One **attribution key** `{company, goal-subtree, agent/role, adapter+model, runId}` stamped on every span
at run-start and carried to every cost event. Emit **OpenTelemetry GenAI** span names so spend is
vendor-neutral. Adopt FinOps **showback → chargeback** maturity. Every finance view becomes a projection
of this one spine.

## The Capital Allocator (xcombo-08)

Treat the portfolio as a **multi-armed bandit**: arms = agents/issues/companies, reward = ROI, forecast =
prior; UCB/Thompson balance explore-vs-exploit under **knapsack** (total cap) + **fairness-floor**
(reserve for critical roles) constraints; unused budget returns to a shared pool. Executed via
[[multi-company-and-ecosystem|holding-company]] capital moves, breaker-gated and audited. Grounded in
arXiv bandit/portfolio literature.

## Links

Depends on [[runtime-control-and-safety]] (budgets/breaker), [[model-economy]] (cost of inference),
[[observability-and-health]] (idle spend), [[security-governance]] (audited money moves).

## Provenance

- Ideas `007,013,019,030,037,049,055,063`; combos `combo-04`, `xcombo-03`, `xcombo-08`.
- `raw/research-sources.md` → `[otel-finops]`, `[bandits]`.

## Open questions for human review

- Imputed dollar value for subscription token usage — include for cross-agent comparison, or avoid implying real cash?
- How lagged/noisy is ROI before the bandit allocator can be trusted to auto-move money?
- Provider-rate-limit-window vs calendar-window for token budgets — default?
