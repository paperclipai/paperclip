---
name: fear-greed-scanner
description: Monitor Fear & Greed indices across crypto, equities, and commodities to identify assets at extreme fear levels
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
  - WebFetch
  - WebSearch
---

# Fear & Greed Scanner

Scan market fear/greed indicators to find assets at extreme fear levels that may present contrarian buying opportunities.

## Data Sources

### Crypto Fear & Greed Index
```bash
# Alternative.me API (free, no key needed)
curl -s "https://api.alternative.me/fng/?limit=30&format=json"
# Returns: { data: [{ value: "23", value_classification: "Extreme Fear", timestamp: "..." }] }
```

### CNN Fear & Greed Index (Equities)
- Web search for current CNN Fear & Greed reading
- Components: market momentum, stock price strength, stock price breadth, put/call ratio, junk bond demand, market volatility (VIX), safe haven demand

### VIX (Volatility Index)
```bash
# Search for current VIX level
# VIX > 30 = elevated fear, > 40 = extreme fear, > 50 = panic
```

### Crypto Funding Rates
- Negative funding = market paying to short = bearish sentiment
- Deeply negative across multiple assets = extreme fear

## Scan Procedure

1. Fetch current fear/greed readings for each market
2. Compare to historical thresholds:
   - Crypto F&G: Extreme Fear = 0-20, Fear = 21-40
   - CNN F&G: Extreme Fear = 0-25, Fear = 26-45
   - VIX: Extreme = >40, High = 30-40
3. For each asset in extreme fear territory:
   - Record the reading and source
   - Note how long fear has persisted (duration matters)
   - Compare to last 5 similar episodes and outcomes
4. Rank assets by fear intensity and historical reliability

## Output Format

```
FEAR & GREED SCAN — [DATE]

EXTREME FEAR ASSETS:
1. [ASSET] — Score: [X/100] ([classification])
   Source: [index name]
   Duration: [X days at this level]
   Historical: [X/Y similar episodes led to rally within 14 days]

FEAR ASSETS (WATCHLIST):
1. [ASSET] — Score: [X/100] — approaching extreme territory
```
