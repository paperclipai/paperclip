# 006 — Org Bottleneck Heatmap

## Suggestion

The dashboard shows what each agent is doing, but it doesn't answer the operator's real
question: **"Where is my company stuck?"** With a deep org chart and a hierarchical task
tree (every task traces to the goal), work piles up in non-obvious places — a CTO sitting on
12 unreviewed PRs, a single reviewer agent gating an entire team, a branch of the goal tree
with no active work at all.

Add an **Org Bottleneck Heatmap**: an org-chart view colored by work pressure, so a glance
tells the operator where to intervene.

## How it could be achieved

1. **Pressure metrics per agent/node**, computed from existing issue + review data:
   - *Inbound queue depth* — issues assigned/awaiting this agent.
   - *Review backlog* — items waiting on this agent's approval (`approvals.ts`,
     `issue-approvals.ts`).
   - *Age of oldest blocked item* in this node's subtree.
   - *Goal coverage* — subtrees of the goal with zero active work (cold spots).
2. **Reuse the org-chart renderer.** `org-chart-svg.ts` already produces the org chart;
   overlay a color scale (green → red) per node and a small badge with the queue depth.
3. **Drill-down.** Clicking a hot node lists the specific blocking items and offers actions:
   reassign, raise concurrency for that agent (idea 001), or escalate.
4. **Critical-path highlight.** Trace the longest chain of blocked/dependent issues from the
   goal downward and draw it, so the operator sees the one path that most constrains
   throughput.
5. **Trend.** Optionally store hourly snapshots so the heatmap can animate "pressure over the
   last day" — useful for spotting a reviewer that's chronically underwater.

## Perceived complexity

**Low–Medium.** Almost entirely a read-model + visualization feature — no changes to the
execution engine, no new safety surface. The metrics are straightforward aggregations over
issues/approvals the DB already holds, and the org-chart SVG renderer exists to build on.
Effort is concentrated in (a) defining a pressure score that's actually meaningful rather
than noisy, and (b) the front-end overlay/interaction. The critical-path trace is the only
algorithmically interesting part (a longest-path walk over the blocker graph).
