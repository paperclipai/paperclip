# Micro CRO risk gate rubric for registry promotion requests

Date: 2026-06-20
Owner: CRO Risk Gatekeeper
Issue: MIC-63
Company: c0af1e45-87d5-458f-93d0-996582bcf7b0
Agent: dc6fe82c-aee7-44c3-afaa-cf9ff1be795f
Safety mode: planning/read-only only. This rubric does not authorize CPS runs, Vast/paid compute, paid data, broker calls, order simulation, paper/live trading, promotion approval, or external performance claims.

## Scope

This is the CRO gate used when a `micro_promotion_requests` row asks to move a Micro experiment beyond research evidence, including requests for `rerun`, `expand_universe`, `allocate_more_data`, `sandbox_monitor`, `paper_trade`, `live_trade_review`, or `archive_as_signal`.

The CRO decision is not the business approval. The CRO can recommend:

- `KILL`: close the route or request because evidence fails a hard gate or violates known kills.
- `REVISE`: return for a bounded, pre-registered repair or narrower non-trading request.
- `PROMOTE_TO_NEXT_REVIEW`: evidence clears the CRO screen for the requested next review only.
- `HOLD/INCONCLUSIVE`: evidence is not review-grade; no negative scientific result is implied.

Only a human/board approval may set a promotion request to approved. Any GO/PROMOTE result still requires the mandatory fusion(opus4.8-gpt5.5) adversarial pass before action.

## Registry fields the gate consumes

From the current registry contract and implementation:

- Experiment: `micro_experiments.id`, `identifier`, `hypothesis`, `lifecycleState`, `maxImprovementAttempts`, `improvementAttemptCount`, `overnightAllowed`, `holdingPeriodMinMinutes`, `holdingPeriodMaxMinutes`, `metrics`, `verdict`, `verdictReason`, `evidencePackId`, `promotionRequestId`.
- Evidence pack: `micro_evidence_packs.id`, `artifactUri`, `status`, `summary`, `metadata`.
- Promotion request: `micro_promotion_requests.id`, `target`, `status`, `rationale`, `riskNotes`, `metadata`.
- Dependency requests: open `data_readiness`, `execution_quality`, `cps_run_plan`, `risk_review`, and any broker/security/board blockers.
- Paperclip issue/work-product artifacts attached to the review issue.

If any of these references are missing for a promotion request, default decision is `HOLD/INCONCLUSIVE`, not promote.

## Universal hard stops

Return `KILL` or `REVISE` immediately if any condition applies:

1. Kill-list collision without a named binding-constraint escape.
   - Hyperliquid liquid-major directional trading, conviction-tail rescue, wider-spread HL majors, maker-rebate rescue, SOL residual alpha, calibrated SOL 600s, and HL wide-spread memecoin maker capture are closed.
   - A request may proceed only if the prereg states the specific killed constraint being escaped and the evidence measures it directly.
2. No frozen pre-registration before data/result inspection.
3. No durable evidence pack with immutable paths/artifacts, run manifest, metrics, verdict, and integrity metadata.
4. Missing or open blocking dependency: data readiness, execution quality, CPS run plan, security/broker, or board approval dependency.
5. Non-audited or bespoke harness bypassed the approved cost/look-ahead controls without a separate pre-registered harness-risk memo.
6. Any look-ahead: future quotes/books/fills used as features; outcome-dependent filtering; post-result threshold tuning.
7. Any unapproved side effect: CPS/Vast spend, paid API/data pull, broker credential check, broker call, order simulation, paper/live order, or external claim.
8. Evidence artifact cannot be retrieved, has non-finite metrics, lacks command/timestamp provenance, or does not identify the code/git state used.
9. Promotion target exceeds the experiment verdict. A `partial`, `hold`, `inconclusive`, `revise`, or `kill` verdict cannot request `paper_trade` or `live_trade_review`.
10. Requested action is `paper_trade` or `live_trade_review` but fusion adversarial review is missing.

## Minimum evidence by requested target

### 1. `archive_as_signal` or monitoring-only dashboard

May be CRO-promoted to next review only if:

- The experiment verdict is `promote`/GO for monitoring or explicitly `partial` with no trading/economic claim.
- Evidence includes the monitoring failure mode, alert semantics, false-positive/false-negative examples, and stale-data behavior.
- The artifact states that it is not a trading recommendation and does not display PnL, fill, or executable-return claims unless separately proven.
- Data freshness, coverage, and missingness gates are met or fail closed.

Default outcome if predictive/economic value is unproven but monitoring value is clean: `REVISE` to `archive_as_signal` or monitoring-only, not trading.

### 2. `rerun`, `expand_universe`, or `allocate_more_data`

May be CRO-promoted to next review only if:

- Current evidence is `PARTIAL` under the frozen rule, not KILL.
- The revision is one of the pre-registered improvement-loop items or a new prereg is frozen before new data access.
- `improvementAttemptCount < maxImprovementAttempts` and the request declares which numbered improvement attempt it consumes.
- The request names data/compute/budget/resource limits and expiry.
- No new target/horizon/universe/cost threshold is selected because it looked good post hoc.

Hard cap: after five improvement attempts, any remaining non-GO result is `KILL` or `HOLD/INCONCLUSIVE`; do not route another revision as promotion.

### 3. `sandbox_monitor`

May be CRO-promoted to next review only if all are true:

- Verdict is GO under a frozen decision rule.
- Evidence covers at least 3 independent usable sessions for intraday/FX/microstructure seeds unless the prereg specifies a stricter floor.
- OOS event/trade/sample count meets the preregistered floor; if unspecified, require >=1,000 OOS fired decisions for a trading-like shadow signal or >=60 sessions for equity-intraday seasonality monitoring.
- Cost/slippage model is named, versioned, and stress-tested at primary and conservative cost cells.
- Session-by-session stability is positive in a majority of usable sessions and not explained by one day/symbol/venue.
- Capacity estimate is present or explicitly marked `capacity_unknown`, in which case no trading/paper-trading request may proceed.
- Toxicity/adverse-selection diagnostics are present for passive/maker strategies.
- Fusion adversarial review is attached or the request remains `needs_adversarial_review`.

`sandbox_monitor` is read-only telemetry. It must not place broker/API orders or publish public signals.

### 4. `paper_trade`

CRO should almost always require an additional execution prereg before this target. It can be promoted to board review only if:

- All `sandbox_monitor` gates pass.
- A separate execution-quality artifact defines order type, venue/broker, fill model, slippage model, latency assumptions, reject/cancel handling, and stop conditions.
- Net EV after fees, spread, slippage, and conservative stress cost remains positive with 95% block-bootstrap lower CI > 0.
- Max drawdown and tail-loss limits below are satisfied on OOS/shadow evidence.
- Explicit kill switch, daily loss limit, position limit, and no-overnight rule are defined.
- Broker/security dependency is fulfilled without exposing secrets and the human board approves paper/demo access.

A quote-only shadow model without observed execution/fill quality cannot clear directly to `paper_trade`; decision is `REVISE` to execution comparator prereg.

### 5. `live_trade_review`

CRO promotion to board review requires all `paper_trade` gates plus:

- A completed paper/demo phase with artifacted orders/fills/rejects/slippage and no policy violations.
- Independent reproducibility by a second reviewer or run owner.
- Fusion adversarial review explicitly evaluates live-market failure modes.
- Board-approved broker/live scope, budget, max notional, max order rate, max loss, emergency stop, and review cadence.

The CRO rubric itself never approves live trading.

## Quantitative risk limits

If the prereg has stricter limits, use the stricter prereg. If the prereg is silent, apply these floors.

### Post-cost edge

- Trading-like promotion requires primary post-cost OOS net EV > +0.5 bps/trade and 95% contiguous-session/block bootstrap lower CI > 0.
- The conservative stress-cost cell must be non-negative unless target is monitoring-only.
- Full model must beat the simplest valid baseline by >= +0.3 bps/trade for GO; < +0.1 bps/trade lift is KILL for trading-like claims.
- Gross edge alone is not sufficient. Fees, spread, slippage, borrow/financing, queue/adverse selection, and rejects must be accounted for where relevant.

### Drawdown and tail risk

For any paper/live-trading request:

- OOS max drawdown must be <= 2.0x expected monthly net EV and <= 5% of proposed sandbox/paper notional, whichever is tighter.
- Worst session/day net loss must be <= 1.0x expected monthly net EV and <= 2% of proposed sandbox/paper notional.
- Profit factor must be >= 1.25 after costs in OOS/shadow evidence.
- Tail loss / CVaR estimate must be shown for the decision interval or daily aggregation used by the strategy.
- If evidence cannot estimate drawdown/tail loss because no fills or no executable proxy exists, target cannot exceed monitoring/read-only.

### Slippage and execution realism

- Evidence must include a named primary cost model and at least one conservative stress cell.
- For taker/marketable strategies, assumed slippage must be no better than measured BBO/slippage diagnostics; stress with at least 1.5x primary cost.
- For maker/passive strategies, report fill rate, cancel rate, queue/fill assumptions, adverse selection bps, realized spread bps, and toxicity gate. Net EV after adverse selection must remain positive.
- For FX/futures/equities, venue/broker-specific spread and commission assumptions must be named. Placeholder cost models cannot support trading promotion.
- Quote-only mid-price returns are allowed for research/monitoring, but are insufficient for paper/live promotion.

### Capacity and concentration

- Capacity estimate is mandatory for trading-like requests: proposed notional/order rate must consume <=10% of conservative top-of-book/interval liquidity and <=5% of estimated strategy capacity.
- If capacity is unknown or below a practical floor, promote only to monitoring/research or revise for capacity measurement.
- Edge must not be concentrated in one symbol, one session, one event, one exchange outage, or one stale-feed window unless the promotion target is explicitly a monitoring detector for that condition.

## Overfit and p-hacking checks

Return `REVISE` or `KILL` if any check fails:

1. Frozen universe, horizons, cost cells, features, labels, and session windows are present in the prereg.
2. OOS walk-forward, chronological split, or other time-respecting validation is used; random shuffle is not enough for market data.
3. Horizon-length embargo or leakage-safe equivalent is documented.
4. Baseline comparison is included: flat/no-trade, quote-only/local-market, or current monitoring baseline as appropriate.
5. Multiple testing is disclosed: number of symbols, horizons, feature families, thresholds, and improvement attempts.
6. Session/symbol stability table is included; one-cell wonders do not promote.
7. The request identifies all prior dry runs and explains which were plumbing-only versus verdict-grade.
8. No hyperparameter, instrument, date-window, or threshold was selected after seeing outcome metrics unless it is isolated as a new pre-registered improvement.
9. Result is reproducible from stored commands/artifacts by a reviewer without secrets.

## Decision matrix

| Condition | CRO decision |
|---|---|
| Kill-list collision and no measured binding-constraint escape | KILL |
| Missing prereg, evidence pack, verdict, or blocking dependency | HOLD/INCONCLUSIVE |
| Evidence uses unapproved data/compute/broker side effect | KILL plus escalation |
| Frozen KILL threshold fired | KILL |
| Frozen PARTIAL threshold fired and improvement attempts remain | REVISE with exact bounded next prereg |
| GO for monitoring only, no executable cost/fill evidence | PROMOTE_TO_NEXT_REVIEW only for `archive_as_signal`/monitoring |
| GO for trading-like shadow signal but no execution-quality artifact | REVISE to execution comparator prereg |
| GO plus complete evidence, execution-quality, risk limits, adversarial review | PROMOTE_TO_NEXT_REVIEW for requested target, human approval still required |
| Any live/paper target without human board approval path | HOLD; CRO cannot approve |

## Current registry objects observed for MIC-63

Registry overview was read from `GET /api/companies/c0af1e45-87d5-458f-93d0-996582bcf7b0/micro-registry` on 2026-06-20T21:43:10Z.

Open risk-review dependency requests routed to this CRO agent:

1. `90642187-59a2-4734-9ceb-9f9f38db3cec` — `risk_review` for `MEXP-FX-6E-EURUSD-LEADLAG-001` (`06d93b08-911a-4b90-ab8b-7b9109046477`). Evidence pack: `9320c444-db31-4e8b-a81d-6264d7cba735`, artifact `file:///root/cli/micro-addon/research-loop/PREREG-MEXP-FX-6E-EURUSD-LEADLAG-001-2026-06-20.md`.
2. `e2b95b4b-38fc-4bc0-9b5b-c20db74699ce` — `risk_review` for `MEXP-PAPER-INTRADAY-REVERSAL-001` (`8bb4c3da-e9c2-478f-bd0b-5d12b6b71b84`). Evidence pack: `0a89d503-e03c-4b26-acb6-2cf5bbe16662`, artifact `file:///root/cli/micro-addon/research-loop/PREREG-MEXP-PAPER-INTRADAY-REVERSAL-001-2026-06-20.md`.

CRO read of these seed preregs:

- `MEXP-FX-6E-EURUSD-LEADLAG-001` currently requests only a shadow/read-only seed after operator approval. The prereg already contains cost grid, health/freshness floors, OOS/event floors, no-CPS/no-broker/no-paid constraints, and mandatory fusion review. This rubric would not clear a future `paper_trade` or `live_trade_review` request from quote-only evidence; it would require an execution comparator prereg first.
- `MEXP-PAPER-INTRADAY-REVERSAL-001` currently authorizes only a read-only evidence/readiness plan. The prereg explicitly lacks current verdict-grade data and a non-placeholder economic cost model. This rubric would allow only readiness/monitoring review until data and cost gates are filled.

No promotion requests existed in the registry at review time.

## Required metadata for future `micro_promotion_requests.metadata`

Promotion requests should include these keys so the CRO can audit deterministically:

```json
{
  "preregRef": "file:///.../PREREG-...md or Paperclip artifact id",
  "verdictRef": "file:///.../VERDICT-...md or Paperclip artifact id",
  "runManifestRef": "artifact/work-product id",
  "metricsRef": "artifact/work-product id",
  "harnessRef": "script/module name + git commit",
  "costModelRef": "named cost model + version",
  "adversarialReviewRef": "required before action on GO",
  "decisionRuleResult": "go|kill|partial|inconclusive",
  "oosSampleCount": 0,
  "readySessionCount": 0,
  "primaryNetEvBps": null,
  "stressNetEvBps": null,
  "maxDrawdownPct": null,
  "slippageStressBps": null,
  "capacityEstimateUsd": null,
  "toxicityGateStatus": "pass|fail|not_applicable|unknown",
  "openBlockingDependencyIds": [],
  "improvementAttemptNumber": 0,
  "sideEffectAttestation": "no CPS/Vast/paid API/broker/order/promotion/external claim without approval"
}
```

Missing required metadata forces `HOLD/INCONCLUSIVE` until corrected.

## CRO operating notes

- The CRO should be conservative: pretty backtests are not evidence without prereg, costs, stability, capacity, toxicity, and provenance.
- A promotion request may be scientifically interesting and still unsafe to promote.
- Monitoring and research artifacts can be valuable without a trading claim.
- Human approval gates are hard boundaries, not rubber stamps after a model says GO.
