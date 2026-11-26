# Connection setup — agent access

Product map: [Connection setup](../feature-map/connection-setup.md).

Review date: 2026-10-12. Source commit: `f981fa3cc10cb8663a87dec60345fbff46d54d0a`.

This is a source-reviewed baseline of representative operations and known gaps.
Each capability needs operation-level review before its entire scope can be
qualified. No live agent execution is claimed. Follow the [map contract](../README.md)
for format, permission checks, evidence and maintenance.

## `catalog`

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /runtime-tools/connections/search`.

Agent access: `available` — Native connections_search / run-bound runtime-tools MCP.

Policy: Setup and credentials belong to the addressed authorized human; active-run tools
can search/request access.

Evidence: `source-only` —
[implementation](../../server/src/routes/connection-intents.ts#L130) at the reviewed
commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Runtime tool broker searches available services without granting connection
administration.

## `identity-and-access`

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/companies/{companyId}/tools/connections`.

Agent access: `restricted` — Board setup API plus agent connection_request.

Policy: Setup and credentials belong to the addressed authorized human; active-run tools
can search/request access.

Evidence: `source-only` —
[implementation](../../server/src/routes/connection-intents.ts#L130) at the reviewed
commit above.

Verification: `not-run` — assert the documented agent denial with an owned test fixture;
verify any listed agent request/result path separately. A delegated operation needs its
own policy and access review.

Gaps: Selecting account ownership/eligible agents is management; an agent can request
the intended connection.

## `credentials`

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/agents/me/connections/{connectionId}/start-authorization`.

Agent access: `partial` — Scoped start-authorization/request flow; human provider login.

Policy: Setup and credentials belong to the addressed authorized human; active-run tools
can search/request access.

Evidence: `source-only` —
[implementation](../../server/src/routes/connection-intents.ts#L130) at the reviewed
commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: An initiation endpoint exists; it is not authorization to complete the person's
credential flow.

Daytona native setup uses an organization API key in the selected personal or
company vault grant. It does not borrow sandbox-provider credentials or CLI
login tokens. Agents use assigned provider tools through the normal run-bound
gateway; they cannot export the key. [Database-backed fixtures](../../server/src/__tests__/daytona-connection.test.ts)
cover selected vault ownership and gateway reads/writes with provider responses
replaced by fixtures. Real provider authentication remains unqualified.

## `handoff`

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/connection-intents/{interactionId}/complete`.

Agent access: `restricted` — Addressed-user completion; server wakes the agent with
updated access.

Policy: Setup and credentials belong to the addressed authorized human; active-run tools
can search/request access.

Evidence: `source-only` —
[implementation](../../server/src/routes/connection-intents.ts#L130) at the reviewed
commit above.

Verification: `not-run` — assert the documented agent denial with an owned test fixture;
verify any listed agent request/result path separately. A delegated operation needs its
own policy and access review.

Gaps: OAuth/callback and addressed-user checks are deliberate separate boundaries.

## `draft-recovery`

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/connection-intents/{interactionId}/phase`.
- `POST /api/tool-connections/{connectionId}/reconnect`.

Agent access: `restricted` — Human setup/resume APIs; agent request state and
continuation.

Policy: Setup and credentials belong to the addressed authorized human; active-run tools
can search/request access.

Evidence: `source-only` —
[implementation](../../server/src/routes/connection-intents.ts#L130) at the reviewed
commit above.

Verification: `not-run` — assert the documented agent denial with an owned test fixture;
verify any listed agent request/result path separately. A delegated operation needs its
own policy and access review.

Gaps: Board setup recovery exists. Browser-only navigation state is not automatically an
agent API gap.

## `task-request`

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /runtime-tools/connections/request`.

Agent access: `available` — Native connection_request / run-bound runtime-tools MCP.

Policy: Setup and credentials belong to the addressed authorized human; active-run tools
can search/request access.

Evidence: `source-only` —
[implementation](../../server/src/routes/connection-intents.ts#L130) at the reviewed
commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: This is the existing agent bridge for human-required setup; do not invent a second
approval system.

## `channel-setup`

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/companies/{companyId}/chat-endpoints`.

Agent access: `restricted` — Board channel management; agent requests required setup.

Policy: Setup and credentials belong to the addressed authorized human; active-run tools
can search/request access.

Evidence: `source-only` —
[implementation](../../server/src/routes/connection-intents.ts#L130) at the reviewed
commit above.

Verification: `not-run` — assert the documented agent denial with an owned test fixture;
verify any listed agent request/result path separately. A delegated operation needs its
own policy and access review.

Gaps: Provider endpoint, represented agent and linked sender are operator choices today.

Internal recovery: Telegram discovery walks bounded pages at startup. Configuration
commits only queue the changed connection; durable maintenance rows supply retry deadlines. Inactive subscription
repair is parked until an endpoint or connection change. This creates no agent
management permission or new API. Local database-backed provider-fixture tests in
[channel integration](../../server/src/__tests__/chat-channels.integration.test.ts)
cover recovery, rollback, retries and idle query silence; they do not establish
live provider or agent access.

## `failure`

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/tool-connections/{connectionId}/health-check`.

Agent access: `partial` — Agent observes connection tool errors; board repair APIs.

Policy: Setup and credentials belong to the addressed authorized human; active-run tools
can search/request access.

Evidence: `source-only` —
[implementation](../../server/src/routes/connection-intents.ts#L130) at the reviewed
commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Error reporting and human repair exist; no generic agent permission to reconnect
accounts.
