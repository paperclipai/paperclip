# 063 — Cost & Capacity Forecasting

## Suggestion

Paperclip tracks spend well and (with the proposed predictive breaker, idea 002) can throttle when
burn threatens a budget in the next minutes/hours. But there's no **forward-looking forecast** over
the horizon operators actually plan on — days, weeks, the runway to a goal's deadline. The breaker
answers "am I about to blow today's budget?"; it doesn't answer "at this trajectory, when do I run
out of money / hit the $1M MRR goal / need to add capacity?" Without that, operators of autonomous
companies — which can sustain spend 24/7 — can't plan: they can't see runway, can't anticipate when
a budget needs raising, and can't tell if the current org will reach the goal on time.

Add **cost & capacity forecasting**: project future spend, token usage, and goal progress from
historical trends, and surface runway, projected goal-attainment dates, and capacity needs.

## How it could be achieved

1. **Trend models over existing data.** Fit simple trend/rolling projections to historical
   `cost_events`, token usage (idea 019), throughput (idea 061 flow metrics), and — once revenue
   exists (idea 030) — income. Start with transparent methods (moving averages, linear/seasonal
   trend); sophistication can come later.
2. **Runway & attainment.** Combine projected burn with remaining budget/revenue for **runway**
   ("~6 weeks at current trajectory"), and combine throughput with remaining goal scope for a
   **projected goal-attainment date** ("on pace to hit the milestone ~2 weeks late").
3. **Capacity planning.** Answer the staffing question: "to hit the goal by date D, you need ~N more
   agents of type T / ~$X more budget." Feeds job postings (idea 048) and reorg (idea 052) with a
   data-driven *why*.
4. **Scenario knobs.** Let operators run what-ifs — add two agents, double the budget, switch a
   role to a local model (idea 008) — and see the forecast shift, turning forecasting into planning.
5. **Surface proactively.** Put runway and attainment on the dashboard, in the operator digest (idea
   029), and (for a Holding Company, idea 007) at the portfolio level for capital allocation —
   forecasts are most useful pushed to the operator, not waited-for.

## Perceived complexity

**Medium.** The historical data all exists; basic trend forecasting and runway math are
straightforward and immediately useful. The harder parts are forecasting *quality* (autonomous
workloads are bursty and non-stationary, so naive extrapolation misleads — show confidence bands and
keep methods honest) and capacity modeling (translating "need more throughput" into "N agents of
type T" requires the calibration and unit-economics data from ideas 055/013). Explicitly distinct
from the predictive breaker (idea 002), which is short-horizon and reactive; this is long-horizon and
planning-oriented. Ship spend forecast + runway first; goal-attainment and capacity planning build on
the throughput/calibration signals as they mature.
