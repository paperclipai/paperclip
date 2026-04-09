---
name: wallet-copytrade-simulator
description: >
  Simulate what the wallet's P&L would look like if a strategy were applied
  at a different allocation level (scaling up or down position sizes), or if
  a subset of trades were excluded. Use before changing allocation or
  retiring a strategy.
---

# Wallet Copytrade Simulator

Projects wallet performance under hypothetical allocation changes and trade
exclusion scenarios. Supports both retrospective analysis (what if we had done X)
and forward projection (what if we scale to Y).

## Simulation Modes

### Allocation Scaling
- Input: a target allocation multiplier (e.g., 2× or 0.5×).
- Scale each trade's position size by the multiplier.
- Compute projected P&L = `Σ(scaled_size × realized_move_per_unit) - scaled_fees`.
- Apply a Kelly-adjusted risk correction: at > 50% Kelly, apply a friction
  multiplier (configurable, default 0.9× per additional Kelly fraction).
- Return: projected P&L, projected max drawdown, projected Sharpe ratio.

### Trade Exclusion Analysis
- Input: a set of trade IDs or a filter (e.g., "exclude all trades from
  strategy X after date Y").
- Compute counterfactual P&L without those trades.
- Compare to actual P&L: what was the value of the excluded trades?
- Report: `exclusion_impact = actual_pnl - counterfactual_pnl`.

### Regime-Conditioned Forward Projection
- For each planned allocation change, project P&L conditioned on each
  market regime using regime-specific historical win rates and average moves.
- Return: `regime_projections: {regime: string, expected_pnl: float, probability: float}[]`.

### Stress Test
- Run a Monte Carlo simulation (N=10,000) of P&L outcomes under the
  scaled allocation, sampling from the historical return distribution.
- Return: 5th percentile P&L (CVaR), 95th percentile P&L, median P&L,
  probability of exceeding daily loss limit.

## Output

Return:
```json
{
  "simulation_type": "allocation_scaling|trade_exclusion|regime_projection|stress_test",
  "projected_metrics": { "pnl": float, "max_drawdown": float, "sharpe_ratio": float, "cvar_5pct": float },
  "comparison_to_actual": { "pnl_delta": float, "drawdown_delta": float },
  "regime_projections": [{ "regime": string, "expected_pnl": float, "probability": float }],
  "recommendation": string
}
```
