# Questions and approvals — agent access

Product map: [Questions and approvals](../feature-map/questions-and-approvals.md).

Review date: 2026-10-12. Source commit: `f981fa3cc10cb8663a87dec60345fbff46d54d0a`.

This is a source-reviewed baseline of representative operations and known gaps.
Each capability needs operation-level review before its entire scope can be
qualified. No live agent execution is claimed. Follow the [map contract](../README.md)
for format, permission checks, evidence and maintenance.

## `questions`

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/issues/{id}/interactions`.
- `POST /api/issues/{id}/interactions/{interactionId}/respond`.

Agent access: `partial` — Native request_human_input; REST / MCP forms; authorized
responder endpoint.

Policy: Current task/run and named audience/resolver policy; governed approval decisions
require board independently of an ordinary interaction.

Evidence: `source-only` — [implementation](../../server/src/routes/issues.ts#L16638) at
the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Agent creates questions. It cannot fabricate a human answer; answering follows
resolver policy.

## `dismiss-and-reopen`

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/issues/{id}/interactions`.

Agent access: `partial` — Persisted question API plus browser card state.

Policy: Current task/run and named audience/resolver policy; governed approval decisions
require board independently of an ordinary interaction.

Evidence: `source-only` — [implementation](../../server/src/routes/issues.ts#L16638) at
the reviewed commit above.

Verification: `not-run` — use the product recipe for the local/developer surface. Verify
listed shared-resource reads separately; local presentation alone is not agent API
evidence.

Gaps: Presentation dismissal/reopening does not resolve the question and does not
require a new mutation API.

## `confirmations`

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/issues/{id}/interactions`.
- `POST /api/issues/{id}/interactions/{interactionId}/resolve-from-comment`.

Agent access: `partial` — Native request_human_input and call_api resolve-from-comment;
authorized REST resolver.

Policy: Current task/run and named audience/resolver policy; governed approval decisions
require board independently of an ordinary interaction.

Evidence: `source-only` — [implementation](../../server/src/routes/issues.ts#L16638) at
the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Conversational confirmation is supported under resolver policy; generic
acceptance/response controls remain restricted.

## `plan-review`

Review: `baseline`.

API: `present` — representative operation IDs:

- `PUT /api/issues/{id}/documents/{key}`.
- `POST /api/issues/{id}/interactions`.

Agent access: `partial` — Native write_document/request_human_input; explicit review
recipient.

Policy: Current task/run and named audience/resolver policy; governed approval decisions
require board independently of an ordinary interaction.

Evidence: `source-only` — [implementation](../../server/src/routes/issues.ts#L16638) at
the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Plan revision and confirmation work. Accepting as a human is not a generic agent
capability.

## `audience`

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/issues/{id}/interactions`.

Agent access: `available` — API resolver checks; assigned review context/resolve_review
for a native review run.

Policy: Current task/run and named audience/resolver policy; governed approval decisions
require board independently of an ordinary interaction.

Evidence: `source-only` — [implementation](../../server/src/routes/issues.ts#L16638) at
the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Audience is a permission boundary to test, not an endpoint that creates new
authority.

## `governance`

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/companies/{companyId}/approvals`.
- `POST /api/approvals/{id}/approve`.
- `POST /api/approvals/{id}/reject`.

Agent access: `restricted` — Agent REST/MCP can request/read/comment/resubmit; formal
approve/reject require board.

Policy: Current task/run and named audience/resolver policy; governed approval decisions
require board independently of an ordinary interaction.

Evidence: `source-only` — [implementation](../../server/src/routes/issues.ts#L16638) at
the reviewed commit above.

Verification: `not-run` — assert the documented agent denial with an owned test fixture;
verify any listed agent request/result path separately. A delegated operation needs its
own policy and access review.

Gaps: Scenario decide_approval does not establish a production agent approval path.
Preserve explicit approver authority.

## `tool-review`

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/tool-gateway/action-requests/{id}/approve`.
- `POST /api/tool-gateway/action-requests/{id}/decline`.

Agent access: `restricted` — Agent invokes assigned ask-policy tool; board approval
executes stored request.

Policy: Current task/run and named audience/resolver policy; governed approval decisions
require board independently of an ordinary interaction.

Evidence: `source-only` — [implementation](../../server/src/routes/issues.ts#L16638) at
the reviewed commit above.

Verification: `not-run` — assert the documented agent denial with an owned test fixture;
verify any listed agent request/result path separately. A delegated operation needs its
own policy and access review.

Gaps: The request/continuation path exists. Agent cannot grant itself once/always-allow
scope via generic API.

## `continuation`

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/issues/{id}/interactions`.
- `GET /api/heartbeat-runs/{runId}`.

Agent access: `available` — Server delivery and resumed assigned agent context.

Policy: Current task/run and named audience/resolver policy; governed approval decisions
require board independently of an ordinary interaction.

Evidence: `source-only` — [implementation](../../server/src/routes/issues.ts#L16638) at
the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Continuation is server-owned; prove exactly one wake/no duplicate action after
resolution with existing integration fixtures.
