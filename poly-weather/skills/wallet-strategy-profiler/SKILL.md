---
name: wallet-strategy-profiler
description: >
  Profile each strategy's contribution to the wallet's P&L over time — attribute
  wins, losses, drawdowns, and Sharpe ratio to individual strategies. Use when
  doing strategy selection, allocation decisions, or performance reviews.
---

# Wallet Strategy Profiler

Attributes portfolio-level performance metrics to individual strategies,
signal sources, or cohorts. Produces per-strategy scorecards used for
allocation and removal decisions.

## Profiling Dimensions

### P&L Attribution
- For each strategy, compute: total realized P&L, unrealized P&L, win rate,
  average win size, average loss size, expectancy.
- Compute strategy share of total portfolio P&L.
- Compute strategy P&L correlation with other strategies (detect redundancy).

### Drawdown Attribution
- Identify which trades/strategies most contributed to max drawdown periods.
- Compute drawdown contribution as: `strategy_loss_during_drawdown / total_drawdown`.

### Sharpe Ratio per Strategy
- Compute per-strategy daily returns series.
- Compute Sharpe ratio (annualized, using risk-free rate from config).
- Rank strategies by Sharpe ratio.

### Consistency Score
- Compute coefficient of variation (CV) of daily returns per strategy.
- Lower CV = more consistent returns.
- Flag strategies with CV > 2.0 as high-variance.

## Allocation Recommendations

Based on profiling output, generate allocation recommendations:
- **Increase allocation**: Sharpe > 1.5, win rate > 55%, drawdown contribution < 10%.
- **Hold allocation**: Sharpe 0.5–1.5, win rate 45–55%.
- **Reduce allocation**: Sharpe < 0.5, win rate < 45%, drawdown contribution > 30%.
- **Terminate**: Sharpe < 0, drawdown contribution > 50%.

## Output

Return `{strategies: StrategyProfile[], recommendations: AllocationRecommendation[]}`.
