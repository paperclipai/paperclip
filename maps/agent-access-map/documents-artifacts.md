# Documents, attachments, and work products — agent access

Product map: [Documents, attachments, and work
products](../feature-map/documents-artifacts.md).

Review date: 2026-10-12. Source commit: `f981fa3cc10cb8663a87dec60345fbff46d54d0a`.

This is a source-reviewed baseline of representative operations and known gaps.
Each capability needs operation-level review before its entire scope can be
qualified. No live agent execution is claimed. Follow the [map contract](../README.md)
for format, permission checks, evidence and maintenance.

## `documents`

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/issues/{id}/documents`.
- `PUT /api/issues/{id}/documents/{key}`.
- `POST /api/issues/{id}/documents/{key}/revisions/{revisionId}/restore`.

Agent access: `available` — Native list/read/write documents; other-task bridge; REST /
CLI / MCP.

Policy: Task/resource visibility, mutation/checkout ownership, revision/lock guards and
permitted deliverable context.

Evidence: `source-only` — [implementation](../../server/src/routes/issues.ts#L10299) at
the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Supported. Native helpers focus on the active task; generic API or explicit
other-task tools cover additional scope.

## `annotations`

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/issues/{id}/documents/{key}/annotations`.
- `PATCH /api/issues/{id}/documents/{key}/annotations/{threadId}`.

Agent access: `available` — REST / native call_api.

Policy: Task/resource visibility, mutation/checkout ownership, revision/lock guards and
permitted deliverable context.

Evidence: `source-only` — [implementation](../../server/src/routes/issues.ts#L10299) at
the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Annotation operations exist without a special annotation tool; check revision
anchors and resolver authority.

## `attachments`

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/companies/{companyId}/issues/{issueId}/attachments`.
- `GET /api/assets/{assetId}/content`.

Agent access: `available` — Native register_deliverable and API multipart/binary
support; REST / CLI / MCP transfers.

Policy: Task/resource visibility, mutation/checkout ownership, revision/lock guards and
permitted deliverable context.

Evidence: `source-only` — [implementation](../../server/src/routes/issues.ts#L10299) at
the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Native API uploads are bounded; attachment reading has target/provider and
permission conditions.

## `work-products`

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/issues/{id}/work-products`.
- `PATCH /api/work-products/{id}`.

Agent access: `available` — Native register_deliverable for file outputs; REST / native
call_api for metadata.

Policy: Task/resource visibility, mutation/checkout ownership, revision/lock guards and
permitted deliverable context.

Evidence: `source-only` — [implementation](../../server/src/routes/issues.ts#L10299) at
the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: A registered reference does not prove uploaded bytes, external delivery, or
accepted review.

## `library`

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/companies/{companyId}/artifacts`.

Agent access: `available` — REST / native call_api.

Policy: Task/resource visibility, mutation/checkout ownership, revision/lock guards and
permitted deliverable context.

Evidence: `source-only` — [implementation](../../server/src/routes/issues.ts#L10299) at
the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Library search/filter uses the artifact API; no new tool needed merely to mirror
the UI.
