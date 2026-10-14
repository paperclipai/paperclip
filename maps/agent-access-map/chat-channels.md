# External chat and email conversations — agent access

Product map: [External chat and email conversations](../feature-map/chat-channels.md).

Review date: 2026-10-12. Source commit: `58e16dbddfc9c8d0cf60867f9d9847f0feda055b`.
Native REST transport reconciled in this change; see the
[shared transport contract](README.md#native-rest-transport).

This is a source-reviewed baseline of representative operations and known gaps.
Each capability needs operation-level review before its entire scope can be
qualified. No live agent execution is claimed. Follow the [map contract](../README.md)
for format, permission checks, evidence and maintenance.

## `providers`

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/companies/{companyId}/chat-endpoints`.

Agent access: `restricted` — Board setup APIs; native connection request can ask for
setup.

Policy: Endpoint management/identity linking requires a board user; delivery is
server-owned and agent tools use scoped assignments.

Evidence: `source-only` — [implementation](../../server/src/routes/chat-channels.ts#L75)
at the reviewed commit above.

Verification: `not-run` — assert the documented agent denial with an owned test fixture;
verify any listed agent request/result path separately. A delegated operation needs its
own policy and access review.

Gaps: Provider installation and account enrollment are not available to an ordinary
agent actor.

Speko UI reconciliation (2026-10-13): experimental voice setup uses the same
board-managed endpoint boundary. Source review follows the merged voice runtime
and the UI integration; live provider qualification is still separate.

## `identity`

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/chat-identity-links/confirm`.

Agent access: `restricted` — Human identity-link flow.

Policy: Endpoint management/identity linking requires a board user; delivery is
server-owned and agent tools use scoped assignments.

Evidence: `source-only` — [implementation](../../server/src/routes/chat-channels.ts#L75)
at the reviewed commit above.

Verification: `not-run` — assert the documented agent denial with an owned test fixture;
verify any listed agent request/result path separately. A delegated operation needs its
own policy and access review.

Gaps: Identity linking requires a signed-in board user, rollout admission and
provider checks at the HTTP route. Native `call_api` preserves these permissions.

## `conversation`

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/chat-endpoints/{endpointId}/conversations/{conversationId}/publications`.

Agent access: `partial` — Assigned-agent reply pipeline; native completion; provider
tools where assigned.

Policy: Endpoint management/identity linking requires a board user; delivery is
server-owned and agent tools use scoped assignments.

Evidence: `source-only` — [implementation](../../server/src/routes/chat-channels.ts#L75)
at the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Normal agent replies work through server delivery. Explicit endpoint publication
APIs are board management paths.

Speko browser sessions use `POST /api/companies/{companyId}/voice-sessions`,
with GET inspection/notification and POST `/{sessionId}/end` operations below
that collection. These routes require board identity; ordinary agent credentials
cannot start a private voice session. Start and notification also require the
experimental chat-connectors gate. Signed provider callbacks use the separate
voice-webhook routes and their session capability. Evidence: `source-only` —
[voice routes](../../server/src/routes/voice-sessions.ts). No live browser answer
retrieval or telephone playback is established by the UI fixtures.

Slack's **Require at-mention** policy applies to channel messages and channel
thread replies, including queued work. DMs are exempt from mention checks;
endpoint availability, **Allow direct messages**, and sender authorization still
apply. Top-level DM replies retain their linear conversation destination. Source:
[admission](../../server/src/services/chat-channels.ts) and
[queued run policy](../../server/src/services/durable-chat-wakeup.ts). Live Slack
verification of this exemption remains separate from provider-fixture coverage.

New conversations resolve typed project/workspace defaults from their endpoint
and destination under the task-creation transaction. Defaults do not authorize
private sources: admission checks the linked user's authority and assigned agent.
An existing conversation keeps its task binding. See
[creation service](../../server/src/services/chat-channels.ts) and
[defaults contract](../../packages/shared/src/types/chat-channels.ts).

## `attachments`

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/issues/{id}/attachments`.
- `POST /api/companies/{companyId}/issues/{issueId}/attachments`.

Agent access: `partial` — Native register_deliverable / attachment tools when admitted;
agent REST; server-owned delivery.

Policy: Endpoint management/identity linking requires a board user; delivery is
server-owned and agent tools use scoped assignments.

Evidence: `source-only` — [implementation](../../server/src/routes/chat-channels.ts#L75)
at the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Uploading/registering is supported. Provider delivery status and board replay are
separate operations.

## `lifecycle`

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/chat-endpoints/{endpointId}/activity`.
- `PATCH /api/chat-endpoints/{endpointId}`.
- `PUT /api/chat-endpoints/{endpointId}/resources` configures destination defaults.

Agent access: `restricted` — Board lifecycle APIs; agent requests repair when blocked.

Policy: Endpoint management/identity linking requires a board user; delivery is
server-owned and agent tools use scoped assignments.

Evidence: `source-only` — [implementation](../../server/src/routes/chat-channels.ts#L75)
at the reviewed commit above.

Verification: `not-run` — assert the documented agent denial with an owned test fixture;
verify any listed agent request/result path separately. A delegated operation needs its
own policy and access review.

Gaps: Activity/repair/replay/disable use board endpoint access, not the agent's ability
to reply.

Endpoint/destination execution defaults use the same board-only management
boundary. Agents select an authorized workspace for their current task through
the [workspace APIs](workspaces.md), rather than editing channel configuration.

Speko callback preferences, incoming phone configuration/approval, and call
history use the company-scoped `voice-callbacks`, `voice-phone`, and
`voice-history` routes. Their UI controls do not grant agents board authority.
See [voice routes](../../server/src/routes/voice-sessions.ts); service-level
caller/session permissions and real provider delivery need separate verification.

GitHub review summary headings use the bot display name. Checks remain
independently scoped by GitHub App and endpoint/PR/commit identity.
