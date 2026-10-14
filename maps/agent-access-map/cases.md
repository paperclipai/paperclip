# Cases and structured work records — agent access

Product map: [Cases and structured work records](../feature-map/cases.md).

Review date: 2026-10-12. Source commit: `f981fa3cc10cb8663a87dec60345fbff46d54d0a`.

This is a source-reviewed baseline of representative operations and known gaps.
Each capability needs operation-level review before its entire scope can be
qualified. No live agent execution is claimed. Follow the [map contract](../README.md)
for format, permission checks, evidence and maintenance.

## `browse`

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/companies/{companyId}/cases`.

Agent access: `available` — REST / native call_api; agent cases reference.

Policy: enableCases gate; company/case/task boundaries, active run where required,
source trust, and checked-out mutation ownership.

Evidence: `source-only` — [implementation](../../server/src/routes/cases.ts#L592) at the
reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: No dedicated production list_cases binding is required because the REST fallback
exists.

## `structure`

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/companies/{companyId}/cases`.
- `PATCH /api/cases/{id}`.

Agent access: `available` — REST / native call_api; parentCaseId and JSON fields.

Policy: enableCases gate; company/case/task boundaries, active run where required,
source trust, and checked-out mutation ownership.

Evidence: `source-only` — [implementation](../../server/src/routes/cases.ts#L592) at the
reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Structured case data is supported; grouping/rendering is presentation, not a new
endpoint requirement.

## `history`

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/cases/{id}/events`.
- `GET /api/cases/{id}/documents/{key}/revisions`.

Agent access: `available` — REST / native call_api.

Policy: enableCases gate; company/case/task boundaries, active run where required,
source trust, and checked-out mutation ownership.

Evidence: `source-only` — [implementation](../../server/src/routes/cases.ts#L592) at the
reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Source-backed access only; case visibility and document locks still apply.

## `task-links`

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/cases/{id}/links`.
- `GET /api/issues/{issueId}/cases`.

Agent access: `available` — REST / native call_api.

Policy: enableCases gate; company/case/task boundaries, active run where required,
source trust, and checked-out mutation ownership.

Evidence: `source-only` — [implementation](../../server/src/routes/cases.ts#L592) at the
reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Case/task association exists; source trust and issue visibility must be tested
with agent credentials.
