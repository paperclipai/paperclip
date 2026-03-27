---
name: macro-analysis
description: Macro regime classification and cross-asset analysis to validate fear-driven trade setups
allowed-tools:
  - Read
  - Bash
  - WebFetch
  - WebSearch
---

# Macro Analysis

Evaluate the macroeconomic environment to determine if conditions support buying assets in extreme fear or if fear is fundamentally warranted.

## Analysis Framework

### 1. Liquidity Assessment
- Federal Reserve policy stance (hawkish/neutral/dovish)
- Global M2 trajectory (expanding/flat/contracting)
- Bank reserves and reverse repo trends
- Central bank balance sheet changes (QE/QT)

### 2. Dollar & Rates
- DXY trend and key levels
- US 10Y yield direction and level
- Real yields (nominal minus inflation expectations)
- Yield curve dynamics (2s10s spread)

### 3. Cross-Asset Signal Matrix

| Signal | Risk-On | Risk-Off |
|--------|---------|----------|
| DXY | Falling | Rising |
| VIX | Below 20 | Above 30 |
| Credit spreads | Tightening | Widening |
| Gold | Flat/falling | Rising |
| 10Y yield | Stable/falling | Spiking |
| Crypto funding | Positive | Negative |

Count risk-on vs risk-off signals to classify regime.

### 4. Regime Classification

```
RISK-ON EXPANSION    (4+ risk-on signals): Full position sizing
CAUTIOUS RISK-ON     (3 risk-on signals):  Reduced position sizing
TRANSITION           (2-3 each):           Minimum positions, highest conviction only
CAUTIOUS RISK-OFF    (3 risk-off signals): Paper trade only, track signals
RISK-OFF CONTRACTION (4+ risk-off signals): Do not buy fear, wait for regime shift
```

### 5. Asset-Specific Macro Factors

**Crypto**: Stablecoin supply growth, ETF flow data, regulatory developments
**Equities**: Earnings cycle, buyback activity, sector rotation patterns
**Commodities**: Supply/demand fundamentals, inventory data, seasonal patterns

## Output Format

```
MACRO ANALYSIS — [DATE]

Regime: [Classification]
Conviction: [High/Medium/Low]

Liquidity: [Expanding/Flat/Contracting] — [details]
Dollar: DXY at [level], trending [up/down/sideways]
Rates: 10Y at [level], real yield [level]
Credit: HY spreads [tightening/widening] at [level]bps

Signal matrix: [X] risk-on / [Y] risk-off

Asset-specific:
  [ASSET]: Macro score [X/10] — [reasoning]

Key risks: [What could shift the regime against us]
```
