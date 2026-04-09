---
name: scan-invariant-monitor
description: >
  Continuously monitor that portfolio and position invariants hold across
  updates — e.g., sum of position exposures ≤ portfolio limit, P&L sums
  correctly, margin utilization is within bounds. Use when the wallet is
  active and on every periodic health-check cycle.
---

# Scan Invariant Monitor

Enumerates and checks the set of mandatory invariants that must hold true
at all times in a live portfolio. Any violation is a critical alert.

## Invariants to Monitor

### Capital Invariants
- `Σ(position_notionals) ≤ portfolio_value × max_portfolio_utilization`
- `Σ(position_unrealized_pnl) + Σ(realized_pnl) + cash = portfolio_value`
- `margin_used ≤ portfolio_value × max_margin_pct`

### Position Invariants
- Each open position has: `size > 0`, `entry_price > 0`, `stop_loss ≥ 0`.
- No two open positions share the same `position_id`.
- `unrealized_pnl = Σ(size × (current_price - entry_price))` per position.
- For long positions: `stop_loss < entry_price < take_profit`.
  For short positions: `take_profit < entry_price < stop_loss`.

### Risk Invariants
- `daily_pnl ≥ -portfolio_value × daily_loss_limit_pct`
- `max_drawdown_pct` (rolling 30d) ≤ configured `max_drawdown_pct`
- `max_concurrent_positions ≥ current_open_positions`

### Counterparty/Fee Invariants
- `Σ(fees_paid_today) ≤ portfolio_value × daily_fee_limit_pct`
- All fees have a matching transaction record.

## Output

- `all_holding: true` if every invariant is satisfied.
- Otherwise: `{invariant_name, expected, actual, severity: critical|high}` for each violation.
- Emit a critical alert for any violation; suspend new position entry if capital invariants fail.
