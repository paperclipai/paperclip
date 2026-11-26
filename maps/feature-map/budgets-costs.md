---
navigation: {"section":"Oversight and operation","sectionOrder":70,"order":10}
---

# Costs and budgets

Operators inspect recorded spend and configure budget controls for the company, projects, and agents. Hard stops pause or prevent eligible work until the governing incident is resolved.

Implementation: [costs and budget host](../../ui/src/pages/Costs.tsx), [audit hub](../../ui/src/pages/audit/AuditHub.tsx).

Agent access: [companion](../agent-access-map/budgets-costs.md).

## Sub-features

- `cost-reporting`: inspect spend by the offered time range and resource dimensions.
- `budgets`: configure supported company/project/agent limits and inspect usage.
- `incidents`: distinguish warnings, hard stops, and manual pauses.
- `resolution`: raise or resolve a budget incident through authorized controls and verify resumption.

## How to get to it (user POV)

### `cost-overview`

Use Activity → Costs/Budgets in the streamlined shell, `/costs` in the production shell, or scoped project/agent budget panels.

### `budget-enforcement`

Open the governing budget configuration and any resulting budget incident card.

## Driving it with Playwright and the Paperclip CLI

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Use synthetic low-cost events and small disposable budgets. Do not buy model usage merely to hit a threshold.

### `cost-overview`

Automated: [costs service](../../server/src/__tests__/costs-service.test.ts) covers cost contracts; [embedded costs UI](../../ui/src/pages/Costs.test.tsx) has narrow Audit-host coverage.

Manual: Inspect a known fixture run and reconcile recorded spend with the chosen
period and resource. Switch the report period/company and inspect the **By
project** breakdown; it is not a project-selector filter. Reload and check empty
or unavailable cost data without treating missing data as zero spend.

### `budget-enforcement`

Automated: [budget service](../../server/src/__tests__/budgets-service.test.ts) exercises soft incidents, hard stops, scope, and valid budget raises.

Manual: Create a small fixture budget, cross its threshold with synthetic recorded spend, and verify the warning or hard-stop state. Attempt new work and confirm it is gated. Raise the correct budget through an authorized action and verify eligible continuation without clearing unrelated manual pauses.

## Gotchas

- Paperclip cost accounting is not a provider invoice or a promise about externally billed spend.
- Company, project, and agent gates can overlap; fixing one may leave another active.
- A successful retry must not bypass an unresolved budget hold.

### Storybook verification

#### `resolution`

Scope: ui
Storybook: Mount BudgetIncidentCard with entered raised limit, invalid limit, keep-paused, applying, authorized/blocked and error states wired through actual host. Existing matrix handlers are no-ops.
Production: POST /companies/{id}/budget-incidents/{id}/resolve must authorize scope-specific raise, persist resolution and resume eligible work while retaining overlapping budget/manual holds.
Sources: Source: [BudgetIncidentCard.tsx](../../ui/src/components/BudgetIncidentCard.tsx), [Costs.tsx](../../ui/src/pages/Costs.tsx), [budgets.ts](../../ui/src/api/budgets.ts), [costs.ts](../../server/src/routes/costs.ts), [budgets.ts](../../server/src/services/budgets.ts). Tests: [budgets-service.test.ts](../../server/src/__tests__/budgets-service.test.ts), [Costs.test.tsx](../../ui/src/pages/Costs.test.tsx)
