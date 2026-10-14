# Costs, budgets, and spending controls — agent access

Product map: [Costs, budgets, and spending controls](../feature-map/budgets-costs.md).

Review date: 2026-10-12. Source commit: `f981fa3cc10cb8663a87dec60345fbff46d54d0a`.

This is a source-reviewed baseline of representative operations and known gaps.
Each capability needs operation-level review before its entire scope can be
qualified. No live agent execution is claimed. Follow the [map contract](../README.md)
for format, permission checks, evidence and maintenance.

## `cost-reporting`

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
