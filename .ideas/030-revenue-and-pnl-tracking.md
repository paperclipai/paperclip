# 030 — Revenue & P&L Tracking (Close the Loop on the Money Goal)

## Suggestion

Paperclip's entire premise is autonomous companies that make money — the canonical goal is
"$1M MRR in 3 months," and `doc/PRODUCT.md` says a company tracks "**Revenue & expenses** at
the company level." But in practice only the *expense* side is modeled: budgets are
`spentMonthlyCents`, costs flow through `cost_events`, and `finance_events` is cost-shaped
(provider, model, pricingTier, externalInvoiceId, amountCents). There's **no first-class way to
record revenue** — so a company can't actually measure progress toward its defining goal, can't
compute profit, ROI, or burn multiple, and the operator is flying blind on the one number that
matters most: *is this thing making more than it costs?*

Add **revenue tracking and a real P&L**: record income alongside spend, and surface
profit/margin/MRR and goal progress in actual dollars.

## How it could be achieved

1. **Revenue events.** Add a revenue counterpart to `finance_events` (or a `direction`
   income/expense field): amount, currency, source, recurring vs one-off, timestamp, and an
   optional link to the issue/work product that produced it (so revenue can be attributed to
   work — which feeds Unit-Economics, idea 013).
2. **Multiple input paths.** (a) Manual entry by the operator. (b) Agent-reported — an agent
   that closes a sale or ships a paid feature files a revenue event (governed by approval, since
   self-reported revenue needs a human check). (c) Webhook ingestion from Stripe/Paddle/etc. via
   the plugin system, so real payment data flows in automatically.
3. **Real P&L view.** Compute revenue − expenses (expenses already exist) into profit, gross
   margin, MRR/ARR, and burn multiple, per company and per period. This is the dashboard an
   operator of an autonomous *business* actually wants.
4. **Goal progress in dollars.** Tie the company goal ("$1M MRR") to measured MRR so the goal
   tree shows real progress, not vibes — directly serving the "all work traces to the goal"
   principle with a quantified top metric.
5. **Feed the rest.** Revenue unlocks performance-based decisions elsewhere: capital allocation
   in a Holding Company (idea 007), revenue-scaled budgets, and an honest ROI per agent.

## Perceived complexity

**Medium.** The financial-events plumbing, currency handling, and period aggregation already
exist on the expense side and can be mirrored for income — the schema/serialization work is
modest. The real effort is the *input paths* (manual UI, governed agent-reporting, and at least
one payment-provider webhook integration) and trustworthy revenue attribution. Manual entry +
P&L view is a small, high-value first slice; agent-reported and webhook ingestion are
incremental and where the integration work concentrates.
