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
- `GET /api/issues/{id}/decision-receipts` (own standing-chat board read).
- `GET /api/issues/{id}/chat-handoffs` (own standing-chat board read, paginated).

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

Coordinator model/effort selection reuses `PATCH /api/issues/{id}` for the conversation's `assigneeAdapterOverrides`, followed by the existing idempotent board-user comments endpoint. It introduces no new route or actor authority and never changes the agent configuration. Settings and message admission are separate writes: a settings failure prevents submission; a later message failure may leave the selected conversation settings saved. Existing in-flight execution is not retroactively changed. UI tests cover ordering and first-message identity; provider/session behavior remains a separate live check.

Coordinator evidence: [canonical chat projections](../../server/src/services/conversation-decision-receipts.ts)
return stable references to recorded task/decision rows, not copied agent prose.
The caller must own and currently read the source conversation; source agent and
session generation must still match the handoff, and each target task must remain
readable. The projection does not give the coordinator new execution authority or
wake it merely to repeat a human decision. The normal local-implicit/admin access
exception remains unchanged.

`GET /api/issues/{id}/pending-questions` is a board-owned, read-authorized projection of canonical attention, limited to current chat handoffs plus ordinary tasks created by the caller and currently assigned to that chat’s agent. Direct tasks with any existing chat handoff are excluded from the direct-task branch. The same direct-task scope extends recorded-decision reads from the current chat boundary; pending direct-task questions remain actionable across resets. Question audience, dismissal, archive, snooze and task privacy come from the existing attention service. No copied interactions or new write authority are introduced. The read currently obtains one full authorized company attention snapshot when relevant tasks exist; no polling is added.

## `handoff`

Capability ID: `agent-chat/handoff`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/companies/{companyId}/projects`.
- `POST /api/companies/{companyId}/issues`.
- `POST /api/issues/{id}/interactions` with `suggest_tasks`.
- `POST /api/issues/{id}/interactions/{interactionId}/accept`.

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

Coordinator evidence: [interaction service](../../server/src/services/issue-thread-interactions.ts)
accepts authorized chat proposals through the normal issue creation service,
with atomic initial-plan persistence and a durable originating-chat handoff.
New chat handoffs default to the conversation agent when no agent or person is supplied. The effective default is included in assignment authorization before creation; explicit assignments retain company, invokability and access checks. Raw REST derives the default only from a verified same-company, same-agent run-bound conversation. Native/MCP creation and accepted suggestions follow the same owner policy. Suggestions alone have no task-creation effect. Accepted chat roots are standalone
tasks; nested execution tasks retain normal parent/child rules. Source participant,
session generation, task assignment and private-source inheritance are checked;
quality confirmations remain separate from task completion and publication.
[Focused regression coverage](../../server/src/__tests__/coordinator-handoff.test.ts)
does not claim live model/tool selection or external delivery verification.
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

### Required quality-review handoff

`request_human_input` suggestions and native `create_task` accept the same optional `requiredQualityReview` contract; task creation persists it atomically. Execution uses existing confirmation/item-verdict interactions with explicit quality-review keys and exact document/attachment targets. The server stamps the current requirement fingerprint, forces human-only resolution, validates current targets, and independently prevents completion until every required output has human approval. Agents cannot remove or weaken an existing requirement. Existing task read/write company and actor checks remain authoritative. Publication/delivery authority is unchanged. Completion-only chat wakes receive bounded canonical decision references and guidance to reuse reviews, not start duplicate ones.

An attachment target is an exact immutable identity, not a mutable latest-output label. Registering another attachment does not automatically replace that required slot; the agent must request a fresh bound review for the replacement. Deduplicated task creation rejects a mismatched requested review contract, and an already-completed task must reopen before taking an unsatisfied requirement.
