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

Publication, provider-reply, and form-open 403/permission errors fail the rejected
operation without removing unrelated assigned channel tools. Confirmed
authentication failures still put the endpoint in attention, which blocks tool
admission and provider sends; connection enabled intent is retained. Known
resource denials and explicit revocation keep their narrower or installation-wide
stops. PostgreSQL provider fixtures verify discovery after 403 and rejection after
401, including signed installation removal after a 401; they do not establish
live GitHub credential recovery.

GitHub publication recovery (2026-10-14): assigned-agent `submit_review`, `comment`,
and `update_comment` calls reuse their run-, task-, endpoint-, and argument-bound
publication on an exact retry. Identity uses the complete durable request rather
than the shortened audit preview. A changed suffix, changed nested entry, or
missing publication cannot authorize another write. Exact retries only read the
receipt; the worker owns pending provider retries. Fresh gateway policy and provider authority remain
required. The durable worker resumes transient failures after restart and stops
at its retry cap, revoked authority, or a superseded head. A pending receipt is
not task completion. Source:
[publication service](../../server/src/services/chat-github-reviews.ts) and
[gateway](../../server/src/services/tool-gateway.ts). Verification uses
PostgreSQL-backed provider fixtures; this entry does not claim live provider
qualification for the new retry path.

GitHub main-response identity (2026-10-19): PR requests share a company-, App-,
repository- and PR-bound comment. Agents still supply no comment destination.
Current sender, assignee, repository and publication authority are checked before
edits, including maintenance failure notices. Leading mentions for another
recipient are filtered before task work; explicit mentions of this bot still
follow normal access checks. Provider-fixture coverage is not live GitHub proof.
Native terminal reconciliation resolves the accepted run identity through the
existing chat provenance resolver; an older run's reply cannot complete a newer
request merely because both requests share the same PR comment.

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

Slack eyes acknowledge the authorized task/comment commit before attachment
preparation or scheduler acceptance. This server-owned receipt grants no agent
authority. Generation/credential fencing, durable retries and exact-source final
cleanup still apply. PostgreSQL fixtures block attachments, subscription and
wakeup independently to verify that none gates the reaction; live Slack latency
remains a separate check. See [receipt worker](../../server/src/services/chat-channels/receipt-reactions.ts).

Controller-owned receipt reactions accept the SDK's empty thread timestamp for
linear DMs. Channel IDs and source message timestamps remain validated. This
does not add an agent tool or change sender, task, or credential authorization.
The pinned SDK transport regression is covered in
[receipt tests](../../server/src/services/chat-slack-receipts.test.ts); live
acknowledgement speed needs a separate provider test.

Slack assignment and tool discovery bound concurrent endpoint preparation to
two. Every endpoint keeps the live task, company, agent and linked-user checks;
403 denials omit only that endpoint. Preparation waits for both active checks
before it returns an ordered result or propagates an error. Tool authority reads
the current bot token without resolving unrelated webhook credentials. See the
[real-database preparation controls](../../server/src/__tests__/slack-tool-preparation.test.ts)
and [batch failure controls](../../server/src/services/connectors/slack-endpoint-preparation.test.ts).
These local controls do not establish live Slack latency or provider access.

Native tool gateways use the durable run task binding for discovery and policy
checks, with legacy JSON task fields as a fallback. GitHub and Slack follow
accepted request provenance across task continuations. GitHub can retain the
originating conversation after a board follow-up from the same accepted user.
An inherited origin cannot cross a task, agent, company, or requester boundary.
Cycle checks reject invalid history without a fixed limit on valid continuations.
Endpoint settings, linked identity, tool profiles, and invocation policy still
apply on each call. The native tool contract rotates older provider sessions so
an empty retained catalog is not reused. PostgreSQL fixtures cover discovery,
review publication, Slack reads, and revocation in
[channel integration](../../server/src/__tests__/chat-channels.integration.test.ts)
and [provenance controls](../../server/src/services/chat-channels/run-origin.test.ts).
The [voice gateway fixture](../../server/src/__tests__/voice-session-store.integration.test.ts)
also verifies durable task binding for a later personal callback invocation.
Failure replies cannot replace final answers inherited from an earlier run.
These fixtures do not prove live provider delivery.

Catalog authorization projection (2026-10-17): tool discovery uses the same live
service-owned task, company, agent, requester, endpoint and credential checks as
full authority resolution. It omits the revision digest and search-action token,
which catalog descriptors do not consume. Connector assignments and governed
operations retain full revision resolution; invocation policy is still checked
by the gateway. Registry replacement and missing-service controls are in
[authority registration tests](../../server/src/services/connectors/slack-authority.test.ts).
This is a source and local-database contract; hosted latency needs live evidence.

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
