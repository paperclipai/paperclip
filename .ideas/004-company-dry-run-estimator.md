# 004 — Company Dry-Run Estimator

## Suggestion

Before an operator hits "go" on a freshly built company, they have **no idea what it will
cost or how long it will take**. They configure a CEO, a few reports, budgets, and initial
tasks — then launch into the unknown and watch the spend meter. Add a **Dry-Run Estimator**
that simulates the first wave of work and returns a projected cost band, expected concurrency
profile, and obvious misconfigurations — *without* spending real tokens on production work.

Think of it as a "preflight check" for an autonomous company.

## How it could be achieved

1. **Static checks (cheap, deterministic).** Walk the org chart and config: agents with no
   reachable tasks, budgets that can't cover even one run at the configured model, missing
   secrets/adapter bindings, circular reporting, an unreachable goal (no task chain). Most
   data is already validated piecemeal in `companies.ts`, `agents.ts`, `budgets.ts`,
   `agent-secret-bindings.ts` — this aggregates them into one report.
2. **Cost model.** Use historical cost-per-run by adapter/model from `costs.ts` (or a seeded
   default table when no history exists) to estimate cost of the first heartbeat across all
   agents, then project N cycles.
3. **Concurrency projection.** Combine per-agent `maxConcurrentRuns` with the proposed Fleet
   Governor cap (idea 001) to show "expected peak: 14 concurrent runs, ~$9–22 in the first
   hour."
4. **Optional shadow heartbeat.** For higher fidelity, run one real heartbeat per agent in a
   `dryRun` mode where adapters are asked to *plan only* (no destructive actions, no
   workspace writes) and report intended actions + token estimate. The adapter boundary
   already supports capability gating, so a `planOnly` capability flag is a natural fit.
5. **UI.** A "Preflight" panel on the company page before launch, with a traffic-light
   summary and an itemized projected-cost table.

## Perceived complexity

**Medium–High.** The static-check aggregation is low effort and immediately useful on its
own — ship that first. The cost projection is medium (needs a defensible model and a cold-
start default). The shadow-heartbeat tier is the expensive part: it requires a `planOnly`
contract across adapters and guarantees that dry-run truly performs no side effects, which
is a meaningful safety surface to get right. Phase it: static → projection → shadow.
