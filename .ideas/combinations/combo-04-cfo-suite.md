# Combo 04 — Autonomous CFO Suite (Economics, P&L & Forecasting)

**Combines:** 013 Unit-Economics Dashboard · 019 Token-Denominated Budgets · 030 Revenue & P&L
Tracking · 037 Prompt-Cache-Aware Context Optimization · 055 Estimate-vs-Actual Calibration ·
063 Cost & Capacity Forecasting

## The unified idea

Paperclip tracks *spend* well but can't answer the only question that matters for an autonomous
*business*: **is this thing making more than it costs, and where is it heading?** Six ideas each
supply one missing financial organ; together they are a complete **CFO suite** over one shared
cost/revenue/outcome data model.

- **Close the revenue loop (030).** Add revenue events (manual, governed agent-reported, and
  Stripe/Paddle webhook ingestion) so the system models income, not just expense — yielding real
  profit, margin, MRR/ARR, burn multiple, and goal progress *in dollars* toward "$1M MRR."
- **Cost per shipped outcome (013).** Join spend to delivered outcomes (issues done, work products
  approved, milestones hit): cost-per-outcome per agent/role/goal, **rework ratio**, and **idle
  spend** (tokens that produced nothing — quantified by the Health Sentinel's diminishing-returns
  detector, combo 03).
- **Honest budgets for everyone (019).** Make token usage a first-class budget metric beside dollars
  by removing the `budgets.ts` `metric !== "billed_cents" → return 0` short-circuit, so subscription/
  flat-rate users (whose real constraint is tokens and rate-limit windows, not cash) finally get an
  enforceable guardrail; align token windows to provider rate-limit resets.
- **The biggest invisible cost lever (037).** Surface cache-hit rate per agent, diagnose cache-busters
  (volatile prefixes), enforce stable-prefix context assembly, and show estimated cache savings — this
  is found money on repetitive agent loops.
- **Did it cost what we thought? (055).** Capture an estimate on work, pair it with the known actual,
  and compute per-agent/per-work-type forecasting bias to auto-correct future estimates.
- **Where is this heading? (063).** Project spend, tokens, throughput, and (once revenue exists)
  income into **runway**, **projected goal-attainment date**, and **capacity needs** ("to hit the
  goal by D you need ~N more agents of type T") with what-if scenario knobs.

## Why combining wins

These all read the same ledger (`cost_events`, `finance_events`) and feed the same dashboard, and they
*depend on each other*: forecasting (063) needs revenue (030) and calibration (055) to be meaningful;
unit economics (013) needs token budgets (019) to compare metered vs subscription agents fairly via an
imputed dollar value; cache savings (037) only matter if surfaced as economics (013). Build one
financial data model and one dashboard, not six analytics one-offs. Imputed-cost normalization (019)
is what lets every other view compare metered and flat-rate agents on equal footing.

## Phasing

1. Token-metric budgets (019, remove the short-circuit) + cache-hit *metric* (037) — small, high-insight.
2. Unit-economics read model (013) + manual revenue entry & P&L view (030).
3. Estimate capture + calibration (055); spend forecast + runway (063).
4. Webhook revenue ingestion (030), goal-attainment & capacity planning (063), cache-assembly
   enforcement (037).

## Ratings

- **Difficulty:** Medium–High — most is read-model/analytics over existing data; the harder parts are
  revenue *input paths* + attribution (030), provider-window alignment for token budgets (019), and
  honest forecasting on bursty non-stationary workloads (063, show confidence bands).
- **Estimated time to complete:** ~5–7 engineer-weeks (phase 1 ~1.5 weeks, immediately valuable).
- **Importance:** 8/10 — turns "agents doing stuff at some cost" into a measurable business, and the
  token-budget fix (019) closes a real safety hole for the large and growing subscription-user segment.
