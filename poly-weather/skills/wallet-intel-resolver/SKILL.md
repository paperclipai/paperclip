---
name: wallet-intel-resolver
description: >
  Resolve wallet intelligence: cross-reference wallet positions, P&L history,
  and risk metrics into a unified dashboard view. Use when generating wallet
  briefings, trade summaries, or risk reports for the operator.
---

# Wallet Intelligence Resolver

Aggregates and normalizes data from all wallet subsystems into a single
intelligence payload suitable for operator dashboards, trade summaries, and
automated alerts.

## Resolution Steps

### Position Aggregation
- Collect all open positions from the trading engine.
- Enrich each with: `unrealized_pnl`, `upnl_pct`, `days_held`, `signal_source`,
  `risk_rating` (based on position size vs. portfolio limit).

### P&L Resolution
- Compute daily realized P&L, MTD realized P&L, YTD realized P&L.
- Compute unrealized P&L across all open positions.
- Compute net P&L = realized + unrealized.
- Resolve fee totals per period.

### Risk Metrics Resolution
- Aggregate `margin_used`, `margin_available`, `margin_utilization_pct`.
- Resolve current `max_drawdown` (absolute and percentage).
- Compute Sharpe-ratio proxy (if ≥ 30 days of returns available).

### Performance Resolution
- Win rate = `wins / total_trades` over the rolling 30-day window.
- Average win size vs. average loss size (expectancy ratio).
- Longest losing streak and longest winning streak.
- Most profitable and least profitable strategy/signal source.

## Output

Return a structured `WalletIntel` payload:
```json
{
  "portfolio_value": float,
  "positions": Position[],
  "pnl": { "realized_today": float, "unrealized": float, "mtd": float, "ytd": float },
  "risk": { "margin_util_pct": float, "drawdown_pct": float, "daily_loss_limit_pct": float },
  "performance": { "win_rate": float, "expectancy_ratio": float, "sharpe_proxy": float },
  "alerts": Alert[]
}
```
