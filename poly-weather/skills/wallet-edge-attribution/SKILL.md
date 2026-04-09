---
name: wallet-edge-attribution
description: >
  Attribute realized trading edges to their root causes — signal quality,
  execution quality, position sizing, or timing — so the system can reinforce
  high-value edges and suppress low-value ones. Use after each trading period
  or on-demand for root-cause analysis.
---

# Wallet Edge Attribution

Decomposes the total realized P&L into attributable components so the system
can learn which edges are genuinely predictive versus which are noise.

## Attribution Framework

### Edge Decomposition
Total P&L = Σ (signal_edge + execution_edge + sizing_edge + timing_edge + noise)

Where each component is estimated as:

- **signal_edge**: contribution from forecast accuracy (predicted_move vs. realized_move).
  Estimated as: `forecast_probability × (realized_outcome - prior_probability) × position_notional`.
- **execution_edge**: difference between intended price and achieved fill price.
  `execution_edge = (intended_price - fill_price) × size` (positive = better than intended).
- **sizing_edge**: contribution from position sizing relative to Kelly-optimal.
  `sizing_edge = (actual_size - kelly_optimal_size) × realized_move_per_unit`.
- **timing_edge**: contribution from signal latency and bar-resolution effects.
  `timing_edge = realized_pnl - Σ(other_edges)`.
- **noise**: residual unexplained P&L (should be near zero in aggregate).

### Edge Quality Assessment
- For each edge component, compute the t-statistic over the trailing window.
- Edges with |t-stat| > 2.0 are statistically significant.
- Flag edges with t-stat ≈ 0 as noise (should be zeroed out by the strategy).

### Signal Source Edge Breakdown
- Report edge contribution per signal source (e.g., `weather_model_v1`, `momentum_4h`).
- Rank sources by `edge_pct_of_total_pnl`.

## Output

Return:
```json
{
  "edge_breakdown": {
    "signal_edge": { "pct_of_pnl": float, "t_statistic": float, "significant": bool },
    "execution_edge": { "pct_of_pnl": float, "avg_slippage_bps": float },
    "sizing_edge": { "pct_of_pnl": float },
    "timing_edge": { "pct_of_pnl": float },
    "noise": { "pct_of_pnl": float }
  },
  "signal_source_edges": [{ "source": string, "edge_pct": float, "t_stat": float }],
  "recommendations": string[]
}
```
