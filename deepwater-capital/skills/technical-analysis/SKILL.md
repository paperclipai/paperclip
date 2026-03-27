---
name: technical-analysis
description: Price action, momentum, and volume analysis to confirm tradeable setups in fear-driven assets
allowed-tools:
  - Read
  - Bash
  - WebFetch
  - WebSearch
---

# Technical Analysis

Evaluate price structure, momentum, and volume to determine if an asset in extreme fear has a tradeable setup.

## Analysis Framework

### 1. Multi-Timeframe Structure
- **Monthly/Weekly**: Identify the primary trend and major support/resistance
- **Daily**: Identify the immediate setup and pattern
- **4H/1H**: Fine-tune entry and stop-loss levels

### 2. Momentum Checklist
- [ ] RSI(14) below 30 (oversold)
- [ ] RSI bullish divergence (price lower low, RSI higher low)
- [ ] MACD histogram turning up from extreme low
- [ ] Stochastic bullish cross in oversold zone

### 3. Volume Checklist
- [ ] Volume spike on final selloff (capitulation)
- [ ] Declining volume on subsequent lower lows (exhaustion)
- [ ] Volume increase on first bounce (demand returning)

### 4. Pattern Checklist
- [ ] Price at or near major support level
- [ ] Double bottom / W-pattern forming
- [ ] Bullish reversal candle (hammer, engulfing) on daily+
- [ ] Falling wedge / channel support bounce

### 5. Trade Level Calculation

```
Entry: [Support zone or pattern trigger]
Stop-loss: Below invalidation (structure break, pattern failure)
  - Crypto: typically 5-8% below entry
  - Equities: typically 3-5% below entry
  - Commodities: typically 3-6% below entry

Target 1 (50% exit): First resistance / measured move
Target 2 (full exit): Second resistance / extension

Minimum R:R requirement: 1:2
```

## Output Format

```
TECHNICAL ANALYSIS — [ASSET]

Trend: [Uptrend/Downtrend/Range] on [timeframe]
Setup: [Pattern name] at [key level]
Score: [X/10]

Levels:
  Entry:    $XX,XXX - $XX,XXX
  Stop:     $XX,XXX (-X.X%)
  Target 1: $XX,XXX (+X.X%) — 50% position
  Target 2: $XX,XXX (+X.X%) — remaining
  R:R:      1:X.X

Momentum: RSI [XX], MACD [state], Stoch [state]
Volume: [Capitulation/Exhaustion/Normal]
Key risk: [What invalidates this setup]
```
