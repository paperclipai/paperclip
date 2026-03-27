# Deepwater Capital

Mixture of Expert agents that identify extreme fear opportunities across crypto, equities, and commodities.

## How It Works

Three specialist analysts independently evaluate assets showing extreme fear readings. Their signals are aggregated by a Portfolio Manager using a gating function — only assets where 2+ experts agree get promoted to trade signals.

```
                    ┌─────────────────────┐
                    │  Portfolio Manager   │
                    │  (Gating Function)   │
                    └────┬───┬───┬────────┘
                         │   │   │
              ┌──────────┘   │   └──────────┐
              ▼              ▼              ▼
     ┌────────────┐  ┌────────────┐  ┌────────────┐
     │ Sentiment  │  │ Technical  │  │   Macro    │
     │  Analyst   │  │  Analyst   │  │  Analyst   │
     │  (30%)     │  │  (40%)     │  │  (30%)     │
     └────────────┘  └────────────┘  └────────────┘
```

## Org Chart

| Agent | Title | Reports To | Skills |
|-------|-------|-----------|--------|
| Portfolio Manager | Chief Investment Officer | Board | signal-generator, fear-greed-scanner |
| Sentiment Analyst | Sentiment & Fear/Greed Specialist | Portfolio Manager | fear-greed-scanner |
| Technical Analyst | Technical & Price Action Specialist | Portfolio Manager | technical-analysis |
| Macro Analyst | Macro & Cross-Asset Specialist | Portfolio Manager | macro-analysis |

## Signal Flow

1. Sentiment Analyst scans fear/greed indices and flags extreme fear assets
2. Technical Analyst evaluates price structure and trade levels
3. Macro Analyst assesses regime and cross-asset backdrop
4. Portfolio Manager applies gating function: 2+ experts must agree, composite > +4.0, no veto
5. Qualifying assets become structured signals with entry, stop-loss, and take-profit levels

## Getting Started

```bash
paperclipai company import --from ./fear-greed-moe
```

## References

- [Agent Companies Specification](https://agentcompanies.io/specification)
- [Paperclip](https://github.com/paperclipai/paperclip)
