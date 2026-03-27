---
name: Fear & Greed Scan Cycle
assignee: portfolio-manager
project: initial-scan
recurring: true
---

Run the MoE scan cycle. This runs 5 times per trading day:
- **8:00 AM ET** — Pre-market scan (overnight moves, Asia/Europe session)
- **10:30 AM ET** — Post-open scan (opening volatility settled)
- **1:00 PM ET** — Midday scan (lunch reversal patterns)
- **3:30 PM ET** — Afternoon scan (institutional flow window)
- **6:00 PM ET** — Post-close scan (end-of-day positioning, after-hours crypto)

## Scan Cycle

1. **Sentiment scan** — Delegate to Sentiment Analyst to pull all fear/greed indices and flag extreme readings
2. **Technical analysis** — Delegate flagged assets to Technical Analyst for price structure evaluation
3. **Macro check** — Delegate to Macro Analyst for regime assessment and asset-specific macro scoring
4. **Aggregate** — Apply the MoE gating function to all assets with complete expert scores
5. **Signal generation** — Produce new signals for assets passing the gate
6. **Paper trade execution** — Execute paper trades against the $100K portfolio
7. **Portfolio update** — Mark fills, check stops/targets on open positions, update P&L
8. **Report** — Publish scan results and portfolio status to the board

## MANDATORY: Minimum 1 Position Per Day

**You MUST open at least 1 new paper trade position per trading day.** If the standard gating function (composite > +4.0, 2+ experts agree) produces no signals by the 3:30 PM scan, you must:

1. **Lower the gate** — Drop the composite threshold to +3.0 and the agreement threshold to 1 expert > +3
2. **Select the best available** — Pick the asset with the highest composite score, even if below normal thresholds
3. **Size it as LEAN BUY** — Use minimum position sizing (reduced size, single tranche, tight stop)
4. **Flag it clearly** — Mark the signal as "FORCED ENTRY — below normal conviction" so performance tracking can separate forced vs. organic signals

If there are still no candidates above +3.0 composite by the final scan (6:00 PM):
- Take the single highest-scoring asset across all classes
- Enter at minimum position size (0.5% of portfolio risk budget)
- Set a tight stop (-2%) and modest target (+4%, R:R = 1:2)
- This is a discipline trade, not a conviction trade — track it separately

**Why:** Even when the system says "no signal," the market is always offering something. Forced entries build the dataset needed to calibrate the gating function over time. If forced entries consistently lose, the thresholds are correct. If they win at >40%, the thresholds are too conservative.

## Focus

- New entries into extreme fear territory since last scan
- Changes in active signal status (stop hit, target hit, expiry)
- Macro regime shifts that affect all positions
- Cross-asset divergences worth flagging
- **Daily position count** — have we opened at least 1 today?
