---
navigation: {"section":"Oversight and operation","sectionOrder":70,"order":10}
---

# Costs and budgets

Operators inspect recorded spend and configure budget controls for the company, projects, and agents. Hard stops pause or prevent eligible work until the governing incident is resolved.

Feature ID: `budgets-costs`.

Implementation: [costs and budget host](../../ui/src/pages/Costs.tsx), [audit hub](../../ui/src/pages/audit/AuditHub.tsx).

Agent access: [companion](../agent-access-map/budgets-costs.md).

Prompt injection classification is a separate `prompt_injection` service charge,
with user/agent/task/project attribution and no heartbeat receipt linkage. Unknown
billing retains its reservation until correction; agent deletion cannot erase
that hold. See [accounting behavior](../../doc/prompt-injection-prevention.md).

## Sub-features

- `cost-reporting`: `budgets-costs/cost-reporting` — inspect spend by the offered time range and resource dimensions.
- `budgets`: `budgets-costs/budgets` — configure supported company/project/agent limits and inspect usage.
- `incidents`: `budgets-costs/incidents` — distinguish warnings, hard stops, and manual pauses.
- `resolution`: `budgets-costs/resolution` — raise or resolve a budget incident through authorized controls and verify resumption.
- `subscriptions`: `budgets-costs/subscriptions` — inspect subscription fees separately from API usage, edit owned prices, link duplicate accounts, and end or exclude tracking.
- `accounting-recovery`: `budgets-costs/accounting-recovery` — inspect missing or unresolved run costs and retry saved cost recording without rerunning the agent.

## How to get to it (user POV)

### `cost-overview`

Use Activity → Costs/Budgets in the streamlined shell, `/costs` in the production shell, or scoped project/agent budget panels.

### `budget-enforcement`

Open the governing budget configuration and any resulting budget incident card.

### `subscription-accounts`

Open Activity → Costs (or `/costs` in the production shell), then Subscriptions → **View details**. Choose **Edit price** for an account you can manage. Use **Same subscription as another account?** to link a duplicate paid account or seat.

### `cost-recording`

Open the Costs overview and expand **run costs unavailable** or **billing types unknown**. Follow **View run** or the agent configuration link for context. **Retry cost recording** appears only for retryable entries and an eligible board user.

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

Automated: [scoped budget accounting](../../server/src/__tests__/budget-enforcement-scoping.test.ts) exercises cumulative running usage, reservation capacity, final settlement, project isolation, and concurrent admission. [Budget cancellation](../../server/src/services/heartbeat/budget-cancellation.test.ts) exercises durable scoped cancellation, delayed providers, stale generations, and recovery. These controlled-provider tests establish enforcement semantics, not live provider termination latency.

Automated: [hosted browser accounting](../../server/src/__tests__/browser-use-connection.test.ts) covers separate browser holds, concurrent starts, final dispatch races, unknown POST outcomes, and exact terminal settlement. Browser caps reserve additional capacity alongside the parent run; internal holds are never returned as provider results.

Manual: With disposable budgets and a controlled streaming adapter, admit a run, report cumulative usage across its hard limit, and verify that new work is denied immediately while the existing run receives Stop asynchronously. Delay the Stop acknowledgement and verify that unrelated requests remain responsive. Use separate projects to verify scope isolation. Raise the budget before an unfenced cancellation attempt and verify that newly admitted work survives; retain an already committed Stop until its own acknowledgement. Use the explicit budget benchmark to compare 0, 17, and 1,000 unrelated idle agents.

Manual: Create a small fixture budget, cross its threshold with synthetic recorded spend, and verify the warning or hard-stop state. Attempt new work and confirm it is gated. Raise the correct budget through an authorized action and verify eligible continuation without clearing unrelated manual pauses.

### `subscription-accounts`

Automated: [Subscription card tests](../../ui/src/components/SubscriptionCostCard.test.tsx) cover component states; [subscription service](../../server/src/__tests__/subscriptions.test.ts), [routes](../../server/src/__tests__/subscription-routes.test.ts), and [refresh](../../server/src/__tests__/subscription-refresh.test.ts) cover accounting, authorization, revisions, and simulated provider discovery. These are not a live provider billing check.

Manual: Use disposable subscription fixtures and two authenticated people with different account audiences. Open details and verify personal/shared visibility, unknown-price labels, and separate currency totals. Save a known annual price, reload, and verify its monthly equivalent and user-supplied label. Link two editable records for the same paid seat; reload and verify one fee plus combined usage, retaining the selected target price. Try a stale revision and an account owned only by the other person. Mark tracking Ended or Excluded and verify the monthly subtotal changes without canceling the provider subscription or rewriting historical run costs. Simulate a failed account refresh and verify saved estimates remain distinguishable from zero or fresh data.

Sources: [Subscription card](../../ui/src/components/SubscriptionCostCard.tsx), [cost routes](../../server/src/routes/costs.ts), [subscription service](../../server/src/services/subscriptions.ts), and [report visibility](../../server/src/services/subscription-report.ts).

### `cost-recording`

Automated: [Cost notice](../../ui/src/components/CostDataQualityNotice.test.tsx), [quality report](../../server/src/__tests__/cost-data-quality.test.ts), and [quality routes](../../server/src/__tests__/cost-data-quality-routes.test.ts) cover UI explanations, report scope, viewer/agent denial, and retry contracts. They do not prove arrival of a real provider receipt.

Manual: Use saved-cost fixtures for waiting-for-receipt, receipt-unavailable, unknown-billing, missing-model/price, and retryable states. Expand the notice, inspect the affected run, and verify the explanation matches its saved evidence. For a retryable entry, choose Retry cost recording, reload, and verify costs are recorded once while the run ID, transcript, task execution count, and original outcome stay unchanged. Repeat with no new receipt and with a failed recording attempt; neither may fabricate zero cost or start a model run. Sign in as a viewer and then an ordinary agent: check the read/mutation boundaries and denial. Keep unresolved budget holds visible until their own accounting obligations settle.

Sources: [Cost notice](../../ui/src/components/CostDataQualityNotice.tsx), [cost routes](../../server/src/routes/costs.ts), [quality report](../../server/src/services/cost-data-quality.ts), and [accounting retry](../../server/src/services/accounting-integrity.ts).

## Gotchas

- Retry cost recording consumes saved usage evidence. It does not rerun the agent, recover missing historical model metadata, or prove that a provider invoice is reconciled.

- A subscription fee is the full account or seat cost, including use outside Paperclip. Linking is for the same paid subscription; ending tracking does not cancel it at the provider.

- Paperclip cost accounting is not a provider invoice or a promise about externally billed spend.
- Company, project, and agent gates can overlap; fixing one may leave another active.
- A successful retry must not bypass an unresolved budget hold.

### Storybook verification

#### `resolution`

Capability ID: `budgets-costs/resolution`.

Scope: ui
Storybook: Mount BudgetIncidentCard with entered raised limit, invalid limit, keep-paused, applying, authorized/blocked and error states wired through actual host. Existing matrix handlers are no-ops.
Production: POST /companies/{id}/budget-incidents/{id}/resolve must authorize scope-specific raise, persist resolution and resume eligible work while retaining overlapping budget/manual holds.
Sources: Source: [BudgetIncidentCard.tsx](../../ui/src/components/BudgetIncidentCard.tsx), [Costs.tsx](../../ui/src/pages/Costs.tsx), [budgets.ts](../../ui/src/api/budgets.ts), [costs.ts](../../server/src/routes/costs.ts), [budgets.ts](../../server/src/services/budgets.ts). Tests: [budgets-service.test.ts](../../server/src/__tests__/budgets-service.test.ts), [Costs.test.tsx](../../ui/src/pages/Costs.test.tsx)
