---
name: finance-analysis
description: Use when performing financial analysis, market research, stock evaluation, sentiment analysis, or generating financial reports. Covers real-time market data, technical indicators, and AI-powered forecasting.
---

# Finance Analysis Skill

Based on awesome-finance-skills patterns for financial intelligence.

## Capabilities

### 1. Market Data & Stock Analysis
- Real-time and historical stock data (via Yahoo Finance, Alpha Vantage)
- Technical indicators: MA, EMA, RSI, MACD, Bollinger Bands
- Fundamental analysis: P/E, P/B, ROE, debt ratios, cash flow
- Multi-market support: US, EU, Asia, crypto

### 2. News & Sentiment Analysis
- Financial news aggregation from 10+ sources
- FinBERT-based sentiment scoring (-1 to +1)
- Entity extraction: companies, people, events
- Sentiment trends over time windows

### 3. Forecasting & Signals
- Time-series forecasting with sentiment adjustment
- Investment signal tracking and evolution
- Transmission chain analysis (how events cascade)
- Risk metrics: VaR, Sharpe ratio, max drawdown

### 4. Report Generation
- Professional financial reports (PDF/HTML)
- Comparative analysis tables
- Visualization: charts, trend lines, heatmaps
- Draw.io logic flow diagrams for transmission chains

## Analysis Framework

### Quick Stock Analysis
```
1. Fetch current price, volume, 52-week range
2. Calculate key technicals: RSI, MACD, moving averages
3. Pull recent news (last 7 days)
4. Run sentiment analysis on news
5. Generate summary: bullish/bearish/neutral with confidence
```

### Deep Research
```
1. Fundamental analysis: financials, ratios, peer comparison
2. Technical analysis: multi-timeframe (daily, weekly, monthly)
3. Sentiment analysis: news + social media
4. Macro context: sector trends, economic indicators
5. Risk assessment: volatility, correlation, drawdown
6. Forecast: 30/60/90 day projections with confidence intervals
7. Generate comprehensive report
```

## Data Sources (by priority)
1. **Yahoo Finance** — Free, broad coverage, no API key needed
2. **Alpha Vantage** — Free tier (25 req/day), good for technicals
3. **CoinGecko** — Crypto data, free tier available
4. **FRED** — Federal Reserve economic data
5. **SEC EDGAR** — US corporate filings

## Applicable Companies
- **CriptoIus**: Crypto market analysis, regulatory impact assessment
- **Lerer AI / Lerer Research**: Financial modeling, investment research
- **Any company**: Budget planning, financial health monitoring
