---
name: wallet-anomaly-flagger
description: >
  Flag statistical anomalies in wallet data — trades, positions, P&L, fees,
  and margin — that deviate significantly from historical norms. Use on every
  data ingestion cycle and for post-trade review. Anomalies feed into the
  scan-invariant-monitor and wallet-intel-resolver for escalation.
---

# Wallet Anomaly Flagger

Applies statistical anomaly detection to all wallet data streams. Detects
both point anomalies (single unusual events) and contextual anomalies
(events unusual given the current context).

## Detection Methods

### Z-Score Detection (Point Anomalies)
- For each metric (daily P&L, trade size, execution latency, fee rate, margin
  utilization), compute the rolling mean and standard deviation over a 30-day
  window.
- Flag any value where `|z_score| > 3.0`.

### IQR Detection
- For metrics with heavy tails, use IQR method: flag if value < Q1 - 1.5×IQR
  or value > Q3 + 1.5×IQR.

### Isolation Forest
- For multi-dimensional anomaly detection (jointly considering P&L, size,
  fees, timing), apply a pre-trained isolation forest model.
- Score each observation; flag if anomaly_score > 0.7.

### Contextual Anomalies
- Flag trades where `realized_pnl >> expected_pnl_given_signal_confidence`.
  (e.g., a 95%-confidence signal producing a 10× average win is an anomaly).
- Flag margin utilization spikes > 80% when no new large positions were opened.

## Anomaly Taxonomy

| Category | Description | Default Severity |
|----------|-------------|-----------------|
| `pnl_spike` | Daily P&L > 5σ from rolling mean | high |
| `trade_size_outlier` | Trade size > 3σ from strategy mean | medium |
| `execution_latency_spike` | Execution time > 3× strategy median | medium |
| `fee_rate_anomaly` | Fee rate > 2× expected for asset class | high |
| `margin_spike` | Margin utilization > 80% without new positions | critical |
| `duplicate_trade` | Trade ID appears more than once | critical |
| `reverse_trade` | Exit event immediately followed by re-entry on same asset | high |
| `stale_position` | Position open > max_holding_period with no exit signal | medium |

## Output

Return:
```json
{
  "anomalies": [{
    "id": string,
    "category": string,
    "metric": string,
    "value": float,
    "baseline": float,
    "z_score": float,
    "severity": "low|medium|high|critical",
    "context": object,
    "timestamp": string
  }],
  "summary": { "total": int, "by_severity": { "critical": int, "high": int, "medium": int, "low": int } }
}
```
