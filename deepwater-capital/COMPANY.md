---
name: Deepwater Capital
description: Mixture of Expert agents that identify extreme fear opportunities across crypto, equities, and commodities using the Fear & Greed Index and multi-factor analysis
slug: deepwater-capital
schema: agentcompanies/v1
version: 1.0.0
license: MIT
goals:
  - Identify assets trading at extreme fear levels across crypto, stocks, and commodities
  - Combine sentiment, technical, and macro signals using a Mixture of Experts approach
  - Generate structured buy/sell signals with entry, stop-loss, and take-profit levels
  - Maintain a watchlist of fear-driven opportunities ranked by conviction
---

Deepwater Capital is a Mixture of Experts trading intelligence company. Three specialist analysts — Sentiment, Technical, and Macro — independently evaluate assets showing extreme fear readings. Their signals are aggregated by the Portfolio Manager, who weighs each expert's conviction and produces final trade signals.

## How the Mixture of Experts Works

Each expert scores opportunities on their own axis:

1. **Sentiment Analyst** — Reads fear/greed indices, social sentiment, funding rates, put/call ratios. Flags when fear is extreme and historically marks bottoms.
2. **Technical Analyst** — Reads price structure, RSI, volume divergences, support levels. Confirms whether the fear is creating a technical setup worth trading.
3. **Macro Analyst** — Reads rates, DXY, liquidity conditions, cross-asset correlations. Determines if the macro backdrop supports a mean-reversion trade.

The **Portfolio Manager** is the gating function — only assets where 2+ experts agree get promoted to signals. Conviction is weighted by expert agreement and signal strength.

## Asset Coverage

- **Crypto**: BTC, ETH, major alts — Crypto Fear & Greed Index, funding rates, exchange flows
- **Equities**: S&P 500, sectors, individual stocks — CNN Fear & Greed Index, VIX, put/call ratios
- **Commodities**: Gold, silver, oil, natgas — commodity sentiment, COT positioning, macro flows
