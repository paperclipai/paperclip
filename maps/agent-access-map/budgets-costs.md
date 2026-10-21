# Costs, budgets, and spending controls — agent access

Product map: [Costs, budgets, and spending controls](../feature-map/budgets-costs.md).

Feature ID: `budgets-costs`.

Review date: 2026-10-12. Source commit: `f981fa3cc10cb8663a87dec60345fbff46d54d0a`.

This is a source-reviewed baseline of representative operations and known gaps.
Each capability needs operation-level review before its entire scope can be
qualified. No live agent execution is claimed. Follow the [map contract](../README.md)
for format, permission checks, evidence and maintenance.

Prompt injection classification is a separate `prompt_injection` service charge,
with user/agent/task/project attribution and no heartbeat receipt linkage. Unknown
billing retains its reservation until correction; agent deletion cannot erase
that hold. See [accounting behavior](../../doc/prompt-injection-prevention.md).

## `cost-reporting`

Capability ID: `budgets-costs/cost-reporting`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/companies/{companyId}/costs/summary`.
- `GET /api/companies/{companyId}/costs/by-agent`.

Agent access: `available` — REST / native call_api / CLI cost.

Policy: Reading costs uses company/resource cost policy. Budget policies and incident
resolution require a board actor.

Evidence: `source-only` — [implementation](../../server/src/routes/costs.ts#L346) at the
reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Cost visibility applies. Provider accounting imports and quota-window inspection
have additional board gates.

## `budgets`

Capability ID: `budgets-costs/budgets`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/companies/{companyId}/budgets/overview`.
- `POST /api/companies/{companyId}/budgets/policies`.

Agent access: `restricted` — Agent-readable overview where allowed; board-only
configuration.

Policy: Reading costs uses company/resource cost policy. Budget policies and incident
resolution require a board actor.

Evidence: `source-only` — [implementation](../../server/src/routes/costs.ts#L346) at the
reviewed commit above.

Verification: `not-run` — assert the documented agent denial with an owned test fixture;
verify any listed agent request/result path separately. A delegated operation needs its
own policy and access review.

Gaps: Read API exists; no agent-write path for budget policies, including agents with
ordinary company access.

## `incidents`

Capability ID: `budgets-costs/incidents`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/companies/{companyId}/budgets/overview`.

Agent access: `available` — REST / native call_api for allowed visibility.

Policy: Reading costs uses company/resource cost policy. Budget policies and incident
resolution require a board actor.

Evidence: `source-only` — [implementation](../../server/src/routes/costs.ts#L346) at the
reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Inspection is supported; hard-stop or pause relief does not follow from seeing the
incident.

## `resolution`

Capability ID: `budgets-costs/resolution`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/companies/{companyId}/budget-incidents/{incidentId}/resolve`.

Agent access: `restricted` — Board resolution API; agent requests the authorized
person's action.

Policy: Reading costs uses company/resource cost policy. Budget policies and incident
resolution require a board actor.

Evidence: `source-only` — [implementation](../../server/src/routes/costs.ts#L346) at the
reviewed commit above.

Verification: `not-run` — assert the documented agent denial with an owned test fixture;
verify any listed agent request/result path separately. A delegated operation needs its
own policy and access review.

Gaps: A governance-policy decision is needed before delegating budget increases or
incident resolution.

## `subscriptions`

Capability ID: `budgets-costs/subscriptions`.

Review: `baseline`.

API: `present` — GET /api/companies/{companyId}/costs/subscriptions; POST /api/companies/{companyId}/costs/subscriptions/refresh; PATCH /api/companies/{companyId}/costs/subscriptions/{subscriptionId}; POST /api/companies/{companyId}/costs/subscriptions/{subscriptionId}/link.

Agent access: `restricted` — these report, refresh, price, and link routes require a board actor. An ordinary agent bearer, native tool, or assistant grant does not inherit the person’s subscription-management identity.

Policy: Company membership and company cost-read permission apply. Account metadata and fees are limited to the owner, an authorized shared audience, or a manager of shared AI connections. Viewers cannot refresh or edit. Editing requires ownership or management of a shared account; linking requires that authority for both records and matching source/target revisions. Company boundaries, immutable price history, and activity logging remain in force.

Evidence: `source-only` — reviewed at `9ef434fe79c57d976b8b03b14c5242db270b8320`. [Subscription card](../../ui/src/components/SubscriptionCostCard.tsx), [cost routes](../../server/src/routes/costs.ts), [subscription service](../../server/src/services/subscriptions.ts), and [report visibility](../../server/src/services/subscription-report.ts).

Verification: `not-run` — Read as each authorized person and verify the account audience. Persist and reload an allowed price change and same-seat link. Reject viewer mutation, another person’s personal-price edit, stale revisions, foreign-company IDs, and ordinary agent requests. Compare current fees, historical usage, and provider state separately.

Gaps: No ordinary-agent management path or request/result handoff is documented. Provider plan discovery, currencies, and seat-identity cases need live qualification; source tests do not establish actual provider billing.

## `accounting-recovery`

Capability ID: `budgets-costs/accounting-recovery`.

Review: `baseline`.

API: `present` — GET /api/companies/{companyId}/costs/data-quality; POST /api/companies/{companyId}/costs/retry-accounting. Separate board operational inspection also uses GET /api/companies/{companyId}/accounting/inspect and POST /api/companies/{companyId}/accounting/retry.

Agent access: `restricted` — quality and retry routes require board identity and company cost-read permission. The separate accounting inspection/retry namespace is board-only. There is no ordinary-agent cost-repair tool implied by permission to read a run.

Policy: Company boundaries and cost visibility apply to the UI report. Viewers may read permitted reports but cannot retry recording. A retry names a run in the same company, logs its request, and calls saved-cost accounting; it does not invoke the adapter. Projection repair is a different operational action with an inspection fingerprint and reason, not the UI Retry cost recording control.

Evidence: `source-only` — reviewed at `9ef434fe79c57d976b8b03b14c5242db270b8320`. [Cost notice](../../ui/src/components/CostDataQualityNotice.tsx), [cost routes](../../server/src/routes/costs.ts), [quality report](../../server/src/services/cost-data-quality.ts), and [accounting retry](../../server/src/services/accounting-integrity.ts).

Verification: `not-run` — Inspect each fixture reason, execute one authorized retry, and compare cost rows, accounting state, activity, and the unchanged run/task execution. Repeat the request to check no duplicate charge. Reject viewer/agent mutations and a foreign-company run. Preserve unavailable and failed states until an actual receipt or allowed correction resolves them.

Gaps: The report is bounded to recent entries; vary the date range to inspect additional records. Full provider receipt timing, invoice reconciliation, and projection repair need separate operator qualification; no live provider recovery is claimed.
