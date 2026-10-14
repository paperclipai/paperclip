# Dashboards, activity, and audit trails — agent access

Product map: [Dashboards, activity, and audit trails](../feature-map/activity.md).

Review date: 2026-10-12. Source commit: `f981fa3cc10cb8663a87dec60345fbff46d54d0a`.

This is a source-reviewed baseline of representative operations and known gaps.
Each capability needs operation-level review before its entire scope can be
qualified. No live agent execution is claimed. Follow the [map contract](../README.md)
for format, permission checks, evidence and maintenance.

## `overview`

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/companies/{companyId}/dashboard`.

Agent access: `available` — REST / native call_api / CLI dashboard.

Policy: Same company plus visibility/audit/cost/run permissions where the route requires
them.

Evidence: `source-only` — [implementation](../../server/src/routes/activity.ts#L224) at
the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Dashboard data is accessible; live-work rendering and event streaming are separate
surfaces.

## `activity`

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/companies/{companyId}/activity`.
- `GET /api/issues/{id}/activity` (UUID or issue identifier).

Agent access: `partial` — REST / native call_api / CLI activity for company
activity. Sandbox agents can use GET issue activity through the default
[callback bridge](../../packages/adapter-utils/src/sandbox-callback-bridge.ts).
The bridge still rejects company activity and company audit routes.

Policy: Company activity requires same-company access and `company_scope:read`,
with issue visibility filtering. Issue activity requires same-company resource
access and `issue:read` for the resolved issue. The sandbox transport does not
replace those controller checks or permit activity writes.

Evidence: `source-only` — [activity routes](../../server/src/routes/activity.ts),
[agent authorization tests](../../server/src/__tests__/activity-routes.test.ts),
and [bridge tests](../../packages/adapter-utils/src/sandbox-callback-bridge.test.ts).
Issue activity transport reviewed at `89770ba707fb1ebd4cabd184eec2e7fee226e0c3`;
other operations retain the baseline source review above.

Verification: `not-run` — no live agent-credential proof. Local route and bridge
regressions pass: permitted agent issue read, denied company/resource scope,
denied writes, extra path segments, and company audit routes. With a real
sandbox agent, read an authorized issue's activity, then verify denial for an
inaccessible issue, another company, and company-wide audit.

Gaps: Audit export and raw activity creation have extra restrictions; do not
equate them with issue activity reading. Live sandbox access remains unverified.

## `runs`

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/companies/{companyId}/heartbeat-runs`.
- `GET /api/heartbeat-runs/{runId}/events`.

Agent access: `available` — REST / native call_api / CLI run.

Policy: Same company plus visibility/audit/cost/run permissions where the route requires
them.

Evidence: `source-only` — [implementation](../../server/src/routes/activity.ts#L224) at
the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Telemetry/run visibility is checked independently from seeing the source task.
Company heartbeat history defaults to 200 rows and caps explicit limits at 1,000
in both the route and service. The response remains an array. Scope, visibility,
and secret redaction checks apply to the bounded result set.

## `routine-audit`

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/routines/{id}/runs`.

Agent access: `available` — REST / native call_api / CLI routine runs.

Policy: Same company plus visibility/audit/cost/run permissions where the route requires
them.

Evidence: `source-only` — [implementation](../../server/src/routes/activity.ts#L224) at
the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Routine execution history is distinct from configuration revisions and scheduling
changes.

## `timeline`

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/companies/{companyId}/timeline`.

Agent access: `available` — REST / native call_api.

Policy: Same company plus visibility/audit/cost/run permissions where the route requires
them.

Evidence: `source-only` — [implementation](../../server/src/routes/activity.ts#L224) at
the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: API exists; no dedicated timeline tool is necessary for this requirement.
