# 007 — Holding Company (Meta-Orchestration Across Companies)

## Suggestion

Paperclip can run many companies in one instance, but they are **deliberately isolated**:
`companies` is a flat top-level table with no parent/group concept, and the authorization
layer actively denies cross-company access (`authorization.ts` — "Cross-company access stays
denied"; `agent-assignability.ts` has an `ancestor_cross_company` denial; `trust-preset-
resolver.ts` enforces a `cross_company_boundary`). That isolation is correct as a default —
but it means there is no way to run a **holding company**: a top-level entity whose agents
set strategy, allocate budget, and coordinate across the subsidiary companies.

Operators already simulate this manually (e.g. an "Ace Holdings" org with subsidiary
Presidents), but it's bolted together with regular agents that *can't actually see* the
companies they supposedly oversee. Make it a first-class primitive: a **meta-company** that
governs a portfolio of companies through an explicit, audited bridge — without dissolving the
per-company isolation that keeps subsidiaries safe.

## How it could be achieved

1. **Portfolio model.** Add an optional `parentCompanyId` (self-reference) or a separate
   `company_groups` table to `packages/db/src/schema/companies.ts`. A meta-company is just a
   company flagged `kind = 'holding'` that owns a set of member companies.
2. **Governed cross-company bridge.** Rather than weakening `authorization.ts`, add a narrow,
   explicit capability — `portfolio_oversight` — granted only to a holding company's agents.
   It permits a *read* projection of member companies (goals, budgets, burn, top-level issue
   status, bottlenecks) and a small set of *governed write* actions (set a subsidiary budget,
   pause/resume a subsidiary, post a directive issue at the subsidiary's goal level). Every
   such action routes through the existing approval/audit path (`approvals.ts`,
   `activity-log.ts`).
3. **Roll-up read model.** A portfolio dashboard that aggregates the per-company metrics that
   already exist (`budgetMonthlyCents`/`spentMonthlyCents` on each company, costs, goal
   progress) into one view — burn across the whole portfolio, which subsidiary is at risk.
   This composes naturally with the Org Bottleneck Heatmap (idea 006), one level up.
4. **Capital allocation as the killer action.** The holding agent's heartbeat can rebalance
   budget between subsidiaries (move spend from a stalled company to a winning one) — the
   highest-value reason to have this layer at all. Each move is an audited budget mutation,
   reusing the Predictive Budget Circuit Breaker plumbing (idea 002) for safety.
5. **Directive issues, not direct control.** A holding company influences subsidiaries by
   filing top-level issues into their goal trees (which their CEOs then decompose), preserving
   the "all work traces to the goal" invariant rather than reaching into a subsidiary's task
   tree directly.

## Perceived complexity

**High.** This is the most architecturally invasive idea in the set because it deliberately
pierces a boundary the system was built to enforce. The schema and roll-up read model are
straightforward; the hard, security-critical work is the `portfolio_oversight` capability —
it must be impossible for a subsidiary agent to escalate into it, and every cross-company
action must be audited and reversible. Build it read-only first (a true portfolio dashboard),
then add governed writes (budget, pause), and only then capital allocation. Treat the
authorization changes as a reviewed security surface, not a feature flag.
