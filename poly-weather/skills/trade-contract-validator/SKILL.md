---
name: trade-contract-validator
description: >
  Validate that trade contracts (entry signals, position sizing rules, risk
  parameters) are internally consistent, within configured bounds, and compliant
  with the current strategy mandate. Use when a new strategy config is deployed
  or before a trading session begins.
---

# Trade Contract Validator

Ensures that every element of a trade contract — signal sources, sizing formulas,
risk limits, and execution constraints — is syntactically valid, within bounds,
and consistent with the portfolio mandate.

## Validation Rules

### Signal Sources
- Each signal source is recognized (e.g., `weather_model_v1`, `momentum_4h`, `macro_calendar`).
- No signal source appears in both the whitelist and blacklist.
- Signal confidence threshold is in `[0, 1]`.

### Position Sizing
- `max_position_pct` ≤ 1.0.
- `max_portfolio_pct` (sum across all concurrent positions) ≤ 1.0.
- `max_loss_per_trade` ≥ 0 and ≤ `max_position_pct × portfolio_value`.
- `risk_per_trade` is defined and consistent with Kelly-derived or fixed-fraction sizing.

### Risk Parameters
- `stop_loss_pct` > 0; `take_profit_pct` > 0.
- `stop_loss_pct` < `take_profit_pct` (unless scalping mode flag is set).
- `max_drawdown_pct` ≤ 0.5 (50%).
- `daily_loss_limit_pct` ≤ `max_drawdown_pct`.

### Execution Constraints
- `max_slippage_bps` ≤ 100 (1%).
- `execution_timeout_ms` ≥ 100 and ≤ 60,000.
- `max_retry_attempts` ≤ 5.

## Output

Return `{valid: boolean, errors: ValidationError[], warnings: ValidationWarning[]}`.

If not valid, do not permit the contract to be loaded by the trading engine.
