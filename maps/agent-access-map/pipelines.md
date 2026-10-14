# Pipelines, review queues, and learnings — agent access

Product map: [Pipelines, review queues, and learnings](../feature-map/pipelines.md).

Review date: 2026-10-12. Source commit: `58e16dbddfc9c8d0cf60867f9d9847f0feda055b`.
Native REST transport reconciled in this change; see the
[shared transport contract](README.md#native-rest-transport).

This is a source-reviewed baseline of representative operations and known gaps.
Each capability needs operation-level review before its entire scope can be
qualified. No live agent execution is claimed. Follow the [map contract](../README.md)
for format, permission checks, evidence and maintenance.

## `stages`

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/pipelines/{pipelineId}/stages`.
- `PATCH /api/pipelines/{pipelineId}/stages/{stageId}`.

Agent access: `available` — REST / native call_api / CLI pipelines where supported.

Policy: Company access, active agent run for mutations, case/issue source trust and
ownership, and review audience.

Evidence: `source-only` — [implementation](../../server/src/routes/pipelines.ts#L265) at
the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Configuration and case-automation retry/rerun have native `call_api` REST
paths under company, active-agent-run, case and target-pipeline write checks. The
route and service retain retry/rerun eligibility and dispatch policy.

## `items`

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/pipelines/{pipelineId}/cases`.
- `POST /api/pipelines/{pipelineId}/cases`.

Agent access: `available` — REST / native call_api / CLI pipelines.

Policy: Company access, active agent run for mutations, case/issue source trust and
ownership, and review audience.

Evidence: `source-only` — [implementation](../../server/src/routes/pipelines.ts#L265) at
the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Agents need run ID on mutations; task-linked changes also check issue
mutation/checkout ownership.

## `review`

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/companies/{companyId}/review-cases`.
- `POST /api/cases/{caseId}/review`.

Agent access: `available` — REST / native call_api / CLI pipeline case review.

Policy: Company access, active agent run for mutations, case/issue source trust and
ownership, and review audience.

Evidence: `source-only` — [implementation](../../server/src/routes/pipelines.ts#L265) at
the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Review policy and actor ownership still apply; existence of the endpoint is not
blanket review authority.

## `learnings`

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/companies/{companyId}/case-events`.

Agent access: `available` — REST / native call_api / CLI case events.

Policy: Company access, active agent run for mutations, case/issue source trust and
ownership, and review audience.

Evidence: `source-only` — [implementation](../../server/src/routes/pipelines.ts#L265) at
the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Learning view is a filtered case-event projection; no separate learning API is
necessary.
