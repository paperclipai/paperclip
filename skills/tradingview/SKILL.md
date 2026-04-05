---
name: tradingview
description: >
  Fetch market data through the verified stockanalysis.com workflow when asked
  for TradingView-style price, volume, range, analyst, earnings, and news
  checks. TradingView itself is egress-blocked in this environment.
---

# Market Data Browser Skill
# (TradingView is egress-blocked — stockanalysis.com is the verified working equivalent)

Fetch deep market data per position using Claude in Chrome → stockanalysis.com.
Covers: price, volume vs avg, 52-week range position, beta, analyst consensus, earnings dates, news headlines, fundamentals.

---

## Verified Working Sources

| Source | URL pattern | What it gives |
|--------|-------------|---------------|
| **stockanalysis.com** ✅ | `/stocks/{ticker}/` | Price, volume, 52wk, beta, analyst target, earnings, PE, news |
| **stockanalysis.com forecast** ✅ | `/stocks/{ticker}/forecast/` | Analyst PT breakdown (low/avg/high), buy/hold/sell split |
| **stockanalysis.com financials** ✅ | `/stocks/{ticker}/financials/` | Revenue, earnings, margins |

TradingView (tradingview.com) — ❌ egress blocked. Do not attempt.
Finviz (finviz.com) — ❌ egress blocked. Do not attempt.

---

## Angel's Positions — Ticker Map

| Ticker | URL slug | Priority | Notes |
|--------|----------|----------|-------|
| PGY | `/stocks/pgy/` | 1 — highest value ~$39.7K | Israeli AI fintech, speculative |
| IREN | `/stocks/iren/` | 2 — ~$34.3K | AI infra pivot + BTC mining |
| GOOG | `/stocks/goog/` | 3 — ~$12.9K | Earnings Apr 23 |
| AMD | `/stocks/amd/` | 4 — ~$12.2K | Earnings May 5 |
| NVDA | `/stocks/nvda/` | 5 — ~$9.6K | Just reported (Feb 25) |
| AMZN | `/stocks/amzn/` | 6 — ~$3.1K | Earnings Apr 30 |
| ESLT | `/stocks/eslt/` | 7 — TASE | Israeli defense |
| NVMI | `/stocks/nvmi/` | 8 — TASE | Semiconductor equipment |

---

## Extraction Workflow

### Step 1 — Navigate + wait

```
navigate("https://stockanalysis.com/stocks/{ticker}/")
# No explicit sleep needed — page is SSR, content is immediate
```

### Step 2 — JS extraction (use this exact pattern, it's verified working)

```javascript
const t = document.body.innerText;
const pick = (label) => {
  const i = t.indexOf(label);
  return i !== -1 ? t.substring(i, i + 120).replace(/\n/g, ' ').trim() : null;
};
JSON.stringify({
  price:    pick('At close:'),
  volume:   pick('Volume'),
  range52:  pick('52-Week Range'),
  beta:     pick('Beta'),
  target:   pick('Price Target'),
  earnings: pick('Earnings Date'),
  pe:       pick('PE Ratio'),
  fpe:      pick('Forward PE'),
  marketCap: pick('Market Cap'),
  revenue:  pick('Revenue (ttm)'),
});
```

### Step 3 — Parse results

From the `price` field extract: close price, $ change, % change, date.
From `volume` extract: today's volume, open price, previous close, day's range.
From `range52` extract: 52wk low and high → compute % position = (price - low) / (high - low).
From `beta` extract: beta value and analyst consensus label.
From `target` extract: analyst target price and % upside.
From `earnings` extract: next earnings date.

### Step 4 — Get news headlines

Use `get_page_text()` then extract the news section — it's at the bottom of the overview page.
Take the first 5 headlines (title + date + source). These are the most recent.

---

## Key Metrics to Compute Per Position

| Metric | Formula | Signal |
|--------|---------|--------|
| **52wk position** | (price − 52wk low) / (52wk high − 52wk low) | <20% = near bottom; >80% = near top |
| **Volume conviction** | today vol / avg vol | >1.5x = high conviction; <0.5x = low conviction |
| **Analyst upside** | (target − price) / price | Prioritize by position size × upside |
| **P&L impact per 1%** | position_value × 0.01 | IREN: $342/1%, PGY: $397/1% |

Avg volume reference (from historical data, verify if page shows it):
- IREN avg: ~18–25M shares/day → March 31 vol 32.6M = ~1.5x (HIGH CONVICTION)
- PGY avg: ~3–5M shares/day → March 31 vol 2.76M = ~0.7x (below avg — LOW CONVICTION)
- NVDA avg: ~200–250M/day → March 31 vol 225.7M = ~1.0x (normal)
- GOOG avg: ~25–35M/day → March 31 vol 31.5M = ~1.0x (normal)
- AMD avg: ~35–55M/day → March 31 vol 42.6M = ~1.0x (normal)
- AMZN avg: ~40–60M/day → March 31 vol 58.8M = ~1.2x (slightly elevated)

---

## IREN-Specific Context (critical for thesis accuracy)

IREN is NOT simply a Bitcoin miner. Updated thesis as of March 2026:
- **Pivot to AI infrastructure**: targeting $3.7B in AI Cloud ARR by late 2026
- **$9.7B Microsoft contract** for AI compute
- **50,000 Nvidia B300 GPUs** purchased (announced March 4, 2026)
- **4.5 GW secured power capacity** — 10x what's needed for current $3.4B AI ARR target
- **MSCI USA Index** addition (Feb 2026) — forced institutional buying
- **Risk**: $6B ATM equity program = significant dilution risk
- **Risk**: 91% revenue still from BTC mining; AI ARR is forward-looking
- BTC price still affects the stock but is no longer the primary thesis driver
- Correlation to check: NVDA (GPU demand), hyperscaler capex (MSFT/GOOG/AMZN spending)

When scanning IREN news, flag:
1. GPU delivery updates (B300 deployment timeline)
2. Microsoft contract execution milestones
3. ATM program usage (equity issuance = dilution)
4. BTC price moves (secondary signal now, not primary)
5. Power capacity additions or delays

## PGY-Specific Context (critical for thesis accuracy)

PGY is near its 52-week low (8.6% of range). Key fundamentals as of March 2026:
- **Forward PE: 4.06x** — one of the cheapest AI/fintech names by this metric
- **Revenue TTM: $1.30B +26.1%** — growing, profitable
- **Net income: $77.28M** — GAAP profitable
- **8 analysts: Strong Buy, target $34.50** (+196% from $11.65)
- **High short interest** — significant bearish positioning
- **Q4 2025**: Beat EPS ($0.80 vs $0.69 est.) but missed revenue — analysts cut forecasts
- **Capital markets active**: $800M consumer ABS, $450M auto resecuritization, $720M forward flow
- **Earnings May 6, 2026** — key catalyst
- **Beta 5.94** — moves violently on sentiment

When scanning PGY news, flag:
1. Volume vs average (thin float → low-volume moves are suspect)
2. ABS issuance (confirms capital market access, thesis-validating)
3. Partner bank additions
4. CFPB or lending regulation news
5. Short interest changes

---

## Output Schema

After all tickers processed, produce this structured block:

```
=== MARKET DATA: {DATE} ===

{TICKER}:
  close: ${price} ({pct}%)
  volume: {vol} ({conviction}: {x}x avg)
  52wk_position: {pct}% of range (${low} – ${high})
  analyst: {consensus} | target ${target} ({upside}% upside)
  earnings: {date}
  beta: {beta}
  forward_pe: {fpe}
  headline_1: {title} ({date} – {source})
  headline_2: {title} ({date} – {source})
  flag: {any notable signal}
```

---

## HEATMAP Scoring Guide

Score each dimension 1–5 for the `[!HEATMAP]` component in the report:

| Dimension | 1 | 3 | 5 |
|-----------|---|---|---|
| Analyst | Sell | Neutral/Buy | Strong Buy |
| 52wk pos | >80% (near top) | 40–60% | <20% (near bottom = oversold opportunity) |
| Conviction | <0.5x avg vol | ~1x | >1.5x avg vol |
| Valuation | fPE >50x | fPE 20–30x | fPE <10x |
| Earnings risk | <2 weeks away | 4–8 weeks | Just reported |

Note: For 52wk position, LOW score (1) = near 52wk high (overbought risk), HIGH score (5) = near 52wk low (value opportunity). Invert the intuition — a score of 5 here means "cheap relative to recent range."

---

## Rate Limiting

- stockanalysis.com has no captcha and handles sequential requests fine
- One tab, navigate sequentially — no parallel tabs needed
- If a page 404s: try `/stocks/{ticker.lower()}/` then skip with DATA_UNAVAILABLE

---

## Failure Fallback

If stockanalysis.com is unreachable, fall back to:
1. `https://finance.yahoo.com/quote/{TICKER}` — price + volume + 52wk
2. WebSearch: `"{TICKER} stock price today site:finance.yahoo.com"`
