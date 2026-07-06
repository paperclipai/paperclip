# 013 — Unit-Economics Dashboard (Cost per Shipped Outcome)

## Suggestion

Paperclip tracks **spend** well (costs, burn, budgets) and has a `productivity-review.ts`
service, but spend alone doesn't tell an operator the thing they actually need to know:
**is this company's work worth what it costs?** A burn-rate number is an input; the decision-
useful metric is *cost per shipped outcome* — dollars per completed issue, per approved work
product, per goal-milestone reached, and per agent. Without that, an operator can't tell a
cheap-but-productive agent from a cheap-but-useless one, or know whether the company's unit
economics are improving or degrading over time.

Add a **unit-economics dashboard** that joins spend to delivered outcomes.

## How it could be achieved

1. **Define outcomes.** Use signals already in the DB: issues moved to done/approved, work
   products accepted, review approvals (`approvals.ts`), and goal/milestone progress. Each is
   a countable "outcome."
2. **Join spend to outcomes.** Costs are already attributed to runs/agents/issues; aggregate
   `spend ÷ outcomes` along several axes — per agent, per role, per company, per goal subtree.
3. **Headline metrics.** "Cost per completed issue: $0.84 (▼12% w/w)", "Cost per approved work
   product", "Rework ratio: % of issues reopened after done" (a quality-cost signal that pure
   spend hides), and "Idle spend: tokens burned on runs that produced no outcome" (overlaps
   with — and is quantified by — the Diminishing-Returns Detector, idea 003).
4. **Comparisons.** Rank agents by cost-effectiveness; flag the expensive-and-unproductive
   quadrant. This is the data the Holding Company (idea 007) needs to allocate capital and the
   trust ramp (idea 009) needs to graduate agents.
5. **Trend over time.** Snapshot weekly so operators see whether unit economics are compounding
   in the right direction — the single most important question for an autonomous business.

## Perceived complexity

**Low–Medium.** No execution-engine changes — it's a read-model/analytics layer over data that
already exists (costs, issues, approvals, work products). The effort is in defining "outcome"
crisply enough to be trustworthy (what counts as shipped? how is rework attributed?) and in the
dashboard UI. The rework-ratio and idle-spend metrics are the highest-value, least-obvious parts
and are worth getting right first.
