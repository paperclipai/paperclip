---
name: signal-generator
description: Aggregate expert scores using MoE gating function and produce structured trade signals with entry, stop-loss, and take-profit levels
allowed-tools:
  - Read
  - Bash
---

# Signal Generator

The gating function of the Mixture of Experts system. Aggregates scores from Sentiment, Technical, and Macro analysts to produce final trade signals.

## Gating Function

### Input
Three expert scores per asset, each on a -10 to +10 scale:
- Sentiment score (weight: 30%)
- Technical score (weight: 40%)
- Macro score (weight: 30%)

### Gate Conditions (ALL must pass)

```
1. AGREEMENT:  At least 2 of 3 experts score > +3
2. CONVICTION: Weighted composite > +4.0
3. NO VETO:    No expert scores below -5
```

### Composite Calculation

```
composite = (sentiment * 0.30) + (technical * 0.40) + (macro * 0.30)
```

### Signal Strength Classification

```
composite >= +7.0  →  STRONG BUY   (high conviction, full position)
composite >= +5.5  →  BUY          (good conviction, standard position)
composite >= +4.0  →  LEAN BUY     (moderate conviction, reduced position)
composite <  +4.0  →  NO SIGNAL    (insufficient conviction)
```

## Signal Output Format

```
═══════════════════════════════════════
SIGNAL: [STRONG BUY / BUY / LEAN BUY]
Asset:  [TICKER]
Class:  [Crypto / Equity / Commodity]
Date:   [YYYY-MM-DD]
═══════════════════════════════════════

TRADE PLAN
  Entry zone:     $XX,XXX — $XX,XXX
  Stop-loss:      $XX,XXX  (−X.X%)
  Take-profit 1:  $XX,XXX  (+X.X%) — exit 50%
  Take-profit 2:  $XX,XXX  (+X.X%) — exit remaining
  Risk/Reward:    1:X.X
  Timeframe:      [Swing 3-14d / Position 2-8w]

EXPERT CONSENSUS
  Sentiment:  [+X] — [one-line reasoning]
  Technical:  [+X] — [one-line reasoning]
  Macro:      [+X] — [one-line reasoning]
  ─────────────────────────
  Composite:  [+X.X] ([classification])

THESIS
  [2-3 sentences: why this trade, what makes it compelling]

INVALIDATION
  [What would kill this trade — specific price level or event]
═══════════════════════════════════════
```

## Watchlist Format

For assets approaching but not yet triggering:

```
WATCHLIST — [DATE]

DEVELOPING SETUPS:
  [ASSET] — Sentiment: [+X], awaiting technical confirmation
  [ASSET] — Technical setup forming, macro headwind (score: [+X])

ACTIVE SIGNALS:
  [ASSET] — Entry: $XX,XXX, Current: $XX,XXX, P&L: +X.X%

EXPIRED SIGNALS (last 30 days):
  [ASSET] — Result: [WIN/LOSS], R achieved: [X.X R]
```

## Capital Deployment Framework (PE/Hedge Fund Best Practices)

### Position Sizing — Kelly Criterion Modified

Never deploy capital based on conviction alone. Use a modified Kelly approach:

```
Kelly % = (Win Rate × Avg Win) − (Loss Rate × Avg Loss) / Avg Win
Deployed % = Kelly % × 0.25  (quarter-Kelly for safety margin)

Maximum single position: 5% of total portfolio (hard cap)
Maximum asset class exposure: 25% of total portfolio
Maximum correlated exposure: 15% (positions with correlation > 0.7)
```

### Tranche Deployment (Institutional Scaling)

Do not enter full position at once. Scale in across tranches:

```
STRONG BUY (composite >= +7.0):
  Tranche 1: 40% of position at signal price
  Tranche 2: 35% on first pullback to support
  Tranche 3: 25% on confirmation (higher low hold)

BUY (composite >= +5.5):
  Tranche 1: 50% of position at signal price
  Tranche 2: 50% on confirmation (higher low hold)

LEAN BUY (composite >= +4.0):
  Tranche 1: 100% of (reduced) position — single entry, tight stop
```

### Risk Budget Allocation

Follow institutional risk budgeting:

```
Total portfolio risk budget: 2% max drawdown per position
Daily VaR limit: 1.5% of portfolio (95% confidence)

Per-trade risk calculation:
  Position size = (Risk budget $) / (Entry − Stop-loss)

  Example: $100K portfolio, 2% risk = $2,000 risk budget
  Entry: $60,000, Stop: $57,000 = $3,000 risk per unit
  Position size: $2,000 / $3,000 = 0.67 units × $60,000 = $40,000 notional
```

### Drawdown Controls (Fund-Level)

```
Portfolio drawdown thresholds:
  -5%:   Reduce all new position sizes by 50%
  -10%:  Halt new entries, manage existing positions only
  -15%:  Begin systematic de-risking of lowest-conviction positions
  -20%:  Full risk-off — close all positions, pause signal generation

Recovery protocol:
  Resume at 50% size after recovering half the drawdown
  Resume full size after recovering 75% of drawdown
```

### Liquidity Requirements

```
Pre-trade liquidity check:
  - 24h volume must be > 10× intended position size
  - Bid-ask spread must be < 0.5% for crypto, < 0.1% for equities
  - Position must be fully exitable within 1 trading session

Illiquid asset haircut:
  - If volume < 50× position: reduce size by 50%
  - If volume < 20× position: DO NOT TRADE
```

### Correlation & Concentration Risk

```
Before adding any new signal, check:
  1. Does this position correlate > 0.7 with any existing position?
     → If yes, treat as the SAME risk and size accordingly
  2. Does this push any asset class above 25% exposure?
     → If yes, skip or replace a lower-conviction existing position
  3. Are we adding to a winning theme or averaging down on a losing one?
     → Never average down. Only add to winners or new uncorrelated setups.
```

### Exit Discipline

```
Mandatory exits (no discretion):
  - Stop-loss hit → exit 100%, no exceptions, no "giving it room"
  - Time stop: if position hasn't moved toward target in 2× expected timeframe → exit
  - Correlation spike: if portfolio correlation exceeds 0.8 across 3+ positions → reduce to 2

Profit-taking (systematic):
  - Target 1 hit → exit 50%, move stop to breakeven
  - Target 2 hit → exit remaining
  - Trailing stop: after Target 1, trail at 2× ATR below price
```

### Performance Attribution & Reporting

```
Track per-signal:
  - Entry date, price, size, tranche fills
  - Exit date, price, reason (target/stop/time/discretionary)
  - Gross P&L, fees, slippage, net P&L
  - R-multiple achieved
  - Holding period
  - Which experts were right/wrong

Track per-portfolio:
  - Sharpe ratio (rolling 30d, 90d)
  - Sortino ratio (downside deviation only)
  - Max drawdown and recovery time
  - Win rate by signal strength (Strong Buy vs Buy vs Lean Buy)
  - Win rate by asset class
  - Win rate by expert (which expert is most predictive?)
  - Calmar ratio (annualized return / max drawdown)
```

## Performance Tracking

Every signal must be tracked to completion:
- Entry filled? At what price and tranche?
- Stop hit or target hit?
- Actual R:R achieved
- Time in trade
- Net P&L after fees and slippage
- Running win rate, average R, Sharpe, and Sortino
