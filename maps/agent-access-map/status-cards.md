# Status cards and refreshed summaries — agent access

Product map: [Status cards and refreshed summaries](../feature-map/status-cards.md).

Review date: 2026-10-12. Source commit: `f981fa3cc10cb8663a87dec60345fbff46d54d0a`.

This is a source-reviewed baseline of representative operations and known gaps.
Each capability needs operation-level review before its entire scope can be
qualified. No live agent execution is claimed. Follow the [map contract](../README.md)
for format, permission checks, evidence and maintenance.

## `authoring`

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/companies/{companyId}/status-cards`.
- `PATCH /api/status-cards/{id}`.

Agent access: `available` — REST / native call_api.

Policy: Feature gate, tasks:assign decision; agents manage only cards they authored;
compiler/summarizer has extra bound-task checks.

Evidence: `source-only` — [implementation](../../server/src/routes/status-cards.ts#L32)
at the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Real agent create/update permission branch exists; not inherently a board-only
feature.

## `generation`

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/status-cards/{id}/recompile`.
- `POST /api/status-cards/{id}/refresh`.

Agent access: `available` — REST / native call_api for authorized own card.

Policy: Feature gate, tasks:assign decision; agents manage only cards they authored;
compiler/summarizer has extra bound-task checks.

Evidence: `source-only` — [implementation](../../server/src/routes/status-cards.ts#L32)
at the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Execution result must be checked. Agent-authored prompt length and tasks:assign
limits apply.

## `inspection`

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/status-cards/{id}`.
- `GET /api/status-cards/{id}/summary-revisions`.
- `GET /api/status-cards/{id}/dry-run`.

Agent access: `available` — REST / native call_api.

Policy: Feature gate, tasks:assign decision; agents manage only cards they authored;
compiler/summarizer has extra bound-task checks.

Evidence: `source-only` — [implementation](../../server/src/routes/status-cards.ts#L32)
at the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Read/history/debug APIs exist; a rendered compiling state is not evidence of
successful generation.

## `archive`

Review: `baseline`.

API: `present` — representative operation IDs:

- `PATCH /api/status-cards/{id}`.

Agent access: `available` — REST / native call_api under own-card management policy.

Policy: Feature gate, tasks:assign decision; agents manage only cards they authored;
compiler/summarizer has extra bound-task checks.

Evidence: `source-only` — [implementation](../../server/src/routes/status-cards.ts#L32)
at the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Archive/restore is represented by card state, separate from delete; check exact
allowed status transition.
