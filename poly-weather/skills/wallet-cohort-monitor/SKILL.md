---
name: wallet-cohort-monitor
description: >
  Monitor cohorts of similar trades or positions — group by strategy, market
  regime, signal source, or time period, then track cohort-level performance
  to detect regime changes and anomalous clustering. Use on daily or weekly
  cadence and on-demand when drawdowns spike.
---

# Wallet Cohort Monitor

Groups trades into cohorts and tracks cohort-level metrics to detect when
a previously profitable cohort begins underperforming (regime change) or when
anomalous clustering of losses appears.

## Cohort Definitions

Cohorts are defined by one or more dimensions:
- **Strategy cohort**: all trades from the same strategy in a given period.
- **Regime cohort**: all trades executed during the same market regime
  (e.g., `trending_up`, `range_bound`, `high_volatility`).
- **Signal cohort**: all trades triggered by the same signal source.
- **Time cohort**: trades grouped by day, week, or month.

## Monitoring Checks

### Cohort Performance Tracking
- For each active cohort, track: realized P&L, win rate, Sharpe ratio, max
  consecutive losses.
- Maintain a 30-day rolling baseline for each cohort.

### Regime Change Detection
- If a cohort's realized P&L in the last 7 days deviates from its 30-day
  baseline by > 2σ, flag a regime change alert.
- Identify which cohort characteristics changed (e.g., signal confidence
  dropped, execution latency increased).

### Loss Clustering Detection
- Detect temporal clustering of losses (e.g., 5 losses in 6 hours).
- If a cluster occurs, identify the common factor: same signal source?
  same market regime? same time of day?
- Emit a `CLUSTER_ALERT` with the suspected root cause.

### Cohort Drift
- Track the distribution of trade attributes within each cohort over time.
- If the attribute distribution shifts (using a chi-squared test, p < 0.05),
  flag a cohort drift warning.

## Output

Return:
```json
{
  "cohorts": [{ "id": string, "dimension": string, "metrics": CohortMetrics, "status": "healthy|warning|critical" }],
  "regime_change_alerts": [{ "cohort_id": string, "deviation_sigma": float }],
  "cluster_alerts": [{ "cluster_id": string, "losses": int, "suspected_factor": string }],
  "drift_warnings": [{ "cohort_id": string, "p_value": float }]
}
```
