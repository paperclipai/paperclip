# Cross-Cut 08 — The Capital Allocator

**A different cut:** the CFO combo (04) and cross-company combo (13) *measure and report* money. This one
adds the missing organ that *acts on* it: an autonomous policy that **reallocates budget toward what's
working** across issues, agents, and companies — framing the whole portfolio as a formal capital-
allocation problem with a principled explore-vs-exploit policy, not ad-hoc spending.

**Synthesizes:** 063 Cost & Capacity Forecasting · 030 Revenue & P&L · 013 Unit-Economics ·
007 Holding-Company Capital Moves *(refs: 049 budget pooling, 019 token budgets, 002 breaker, cross-cut 03 attribution)*
*(pulls from thematic combos 04, 13)*

## Academic + industry grounding (web research incl. arXiv, June 2026)

The "reallocate toward what works" decision has a rigorous formal home, which lifts this from heuristic
to principled:

- **It's a multi-armed bandit.** "Stochastic multi-armed bandits address the exploration–exploitation
  trade-off… a natural framework for sequential decision-making under uncertainty… by treating different
  portfolio strategies as arms" (arXiv 1709.04415 risk-aware bandits for portfolio; 2410.04217 bandit
  networks for portfolio optimization). → each agent / issue-subtree / subsidiary is an **arm**; budget is
  the resource; ROI is the reward.
- **Budget-constrained bandits are solved.** Knapsack-based optimal policies for budget-limited bandits
  (arXiv 1204.1909) and multi-task *combinatorial* bandits for budget allocation with Bayesian
  hierarchical models + Thompson sampling (arXiv 2409.00561). UCB / Thompson balance "trying new
  configurations vs exploiting historically-good ones." → the allocator's core algorithm, off the shelf.
- **Fairness/floor constraints are first-class.** "Each arm must receive at least a given fraction of the
  total budget" (constrained bandit feedback, arXiv 2106.05165). → directly encodes "reserve capacity for
  the CEO / critical roles" (idea 049).
- **Resource-bounded agents have a formal contract** (arXiv 2601.08815, *Agent Contracts*). → bounds each
  arm's draw.
- **Industry validates the mechanism:** autonomous finance "dynamically rebalances allocations to maximize
  returns while minimizing risks"; and crucially — "as agents complete, **unused budget returns to a
  shared pool**, allowing efficient agents to subsidize those needing more." That pooling pattern *is*
  idea 007's capital reallocation, already proven elsewhere.

## The unified idea — the portfolio as a bandit, reallocated continuously

Close the money loop the CFO suite (combo 04) opens:

1. **Define the arms & reward.** Arms = agents, issue-subtrees, and (at the holding tier) subsidiary
   companies. Reward = ROI per arm: revenue/outcome value (030) ÷ attributed cost (cross-cut 03
   attribution key + unit economics 013), with forecast (063) as the prior.
2. **Run a bandit allocation policy.** UCB/Thompson sampling over the arms to balance **exploit** (pour
   budget into the proven winner) vs **explore** (fund a promising-but-unproven agent/strategy), subject
   to constraints: budget knapsack (total cap), fairness floors (reserved capacity for critical roles),
   and per-arm resource bounds (idea 024 caps / Agent-Contracts). Token budgets (019) make this work for
   subscription users too.
3. **Pooling, not just capping.** Implement the proven pattern: as work completes under budget, unused
   budget returns to a shared pool the allocator redistributes — efficient agents literally subsidize
   exploration. This is idea 049's pooling generalized from credentials to capital.
4. **Execute moves where authority exists.** Within a company, the allocator nudges per-agent budgets;
   across companies, it routes through the holding-company governed capital moves (007 / combo 13), each an
   audited, reversible budget mutation, safety-bounded by the predictive breaker (002).
5. **Human sets the mandate; allocator works within it.** The operator sets risk appetite, floors,
   exploration budget, and the autonomy ceiling (cross-cut 01); the allocator rebalances within those and
   reports ("moved $200/day from Marketing-co (ROI 0.4) to Granola-clone (ROI 2.1); held CEO reserve").

## Why this is a *better* idea than the parts

Forecasting (063), revenue (030), and unit economics (013) produce *numbers a human must act on*; the
holding company (007) provides the *mechanism* but no *policy*. Alone they inform; combined under a bandit
allocator they **decide** — turning measurement into continuous, principled reallocation with explicit
explore/exploit and fairness, which is exactly how capital is optimally allocated under uncertainty per the
literature. It's the decision-making capstone of the entire money stack.

## Phasing

1. ROI-per-arm read model (030 + 013 + cross-cut 03 attribution) + forecast prior (063) — *recommendation
   only*: "you should move budget from X to Y."
2. Within-company allocator: UCB/Thompson over agents with knapsack + fairness-floor constraints; advisory,
   then opt-in auto-apply with the predictive breaker (002) as the safety bound.
3. Budget pooling (return-and-redistribute) generalized from idea 049.
4. Cross-company capital moves via the holding governed seam (007/combo 13) — the most sensitive tier, last.

## Ratings

- **Difficulty:** High — the allocation *math* is well-trodden (off-the-shelf bandit algorithms), but the
  hard parts are trustworthy reward signal (ROI attribution is noisy and lagged — bandits handle noise but
  garbage rewards mislead), avoiding oscillation/starvation (fairness floors + hysteresis), and the
  high-blast-radius of auto-moving real money (must be policy-bounded, audited, reversible, breaker-gated).
  Cross-company tier inherits combo 13's security weight.
- **Estimated time to complete:** ~6–9 engineer-weeks atop the CFO suite (combo 04) + holding seam (combo 13).
- **Importance:** 7/10 — the highest-leverage *financial* action an autonomous business can take (and the
  killer reason to have a holding layer at all), but it depends on trustworthy revenue/ROI data first and
  carries real money risk, so it sequences late and behind firm guardrails.

## Sources

- [Risk-Aware Multi-Armed Bandit for Portfolio Selection — arXiv 1709.04415](https://arxiv.org/abs/1709.04415)
- [Improving Portfolio Optimization with Bandit Networks — arXiv 2410.04217](https://arxiv.org/html/2410.04217v2)
- [Knapsack-based Optimal Policies for Budget-Limited Multi-Armed Bandits — arXiv 1204.1909](https://arxiv.org/pdf/1204.1909)
- [Multi-Task Combinatorial Bandits for Budget Allocation — arXiv 2409.00561](https://arxiv.org/html/2409.00561v1)
- [Constrained Optimization with Bandit Feedback (fairness floors) — arXiv 2106.05165](https://arxiv.org/pdf/2106.05165)
- [Agent Contracts: Resource-Bounded Autonomous AI Systems — arXiv 2601.08815](https://arxiv.org/pdf/2601.08815)
- [Autonomous Finance & AI Capital Allocation — P&C Global](https://www.pandcglobal.com/research-insights/autonomous-finance-ai-reshaping-capital-banking-economics/)
