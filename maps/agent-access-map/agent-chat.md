# Agent conversations and project handoff — agent access

Product map: [Agent conversations and project handoff](../feature-map/agent-chat.md).

Feature ID: `agent-chat`.

Review date: 2026-10-12. Source commit: `f981fa3cc10cb8663a87dec60345fbff46d54d0a`.

This is a source-reviewed baseline of representative operations and known gaps.
Each capability needs operation-level review before its entire scope can be
qualified. No live agent execution is claimed. Follow the [map contract](../README.md)
for format, permission checks, evidence and maintenance.

## `discovery`

Capability ID: `agent-chat/discovery`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/companies/{companyId}/chats`.
- `GET /api/companies/{companyId}/chats/{agentRef}`.

Agent access: `restricted` — Board-user REST; the responding agent gets its assigned
conversation context.

Policy: Conversation discovery/creation requires a board user and the Agent Chat gate;
task access follows task visibility.

Evidence: `source-only` — [implementation](../../server/src/routes/issues.ts#L18077) at
the reviewed commit above.

Verification: `not-run` — assert the documented agent denial with an owned test fixture;
verify any listed agent request/result path separately. A delegated operation needs its
own policy and access review.

Gaps: Agents cannot enumerate or create another person's standing chats. Detail route is
missing from the generated API catalog.

## `history`

Capability ID: `agent-chat/history`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/issues/{id}/comments`.
- `POST /api/issues/{id}/comments`.

Agent access: `partial` — Assigned conversation task tools / REST for eligible task
history and replies.

Policy: Conversation discovery/creation requires a board user and the Agent Chat gate;
task access follows task visibility.

Evidence: `source-only` — [implementation](../../server/src/routes/issues.ts#L18077) at
the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Agent responses are supported; creating the person's chat and impersonating their
messages are different actions.

## `handoff`

Capability ID: `agent-chat/handoff`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/companies/{companyId}/projects`.
- `POST /api/companies/{companyId}/issues`.

Agent access: `available` — Native list_projects/create_project/create_task; project MCP
tools; REST.

Policy: Conversation discovery/creation requires a board user and the Agent Chat gate;
task access follows task visibility.

Evidence: `source-only` — [implementation](../../server/src/routes/issues.ts#L18077) at
the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Agent handoff is implemented; execution readiness, assignment permission, and
repository access still apply.

Additional coverage: the explicit [chat feature evals](../../tests/runner-e2e/CHAT-FEATURES.md)
exercise native task creation and completion delivery through the real chat UI.
The [chat directive](../../server/src/services/agent-conversations.ts) tells agents
to use company-prefixed relative task links or platform-supplied absolute origins.
This adds no permission and does not qualify the whole capability or its denied cases.

## `conference-room`

Capability ID: `agent-chat/conference-room`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/board/chat/stream`.

Agent access: `partial` — Existing SSE client in local_trusted mode with the
experimental gate.

Policy: Conversation discovery/creation requires a board user and the Agent Chat gate;
task access follows task visibility.

Evidence: `source-only` — [implementation](../../server/src/routes/issues.ts#L18077) at
the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Not callable through generic REST tooling: protocol and deployment constraints
apply. This route is not guarded by assertBoard, so its intended agent policy needs
clarification.
