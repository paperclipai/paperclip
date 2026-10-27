# External chat and email conversations — agent access

Product map: [External chat and email conversations](../feature-map/chat-channels.md).

Feature ID: `chat-channels`.

Review date: 2026-10-12. Source commit: `58e16dbddfc9c8d0cf60867f9d9847f0feda055b`.
Native REST transport reconciled in this change; see the
[shared transport contract](README.md#native-rest-transport).

This is a source-reviewed baseline of representative operations and known gaps.
Each capability needs operation-level review before its entire scope can be
qualified. No live agent execution is claimed. Follow the [map contract](../README.md)
for format, permission checks, evidence and maintenance.

## `providers`

Capability ID: `chat-channels/providers`.

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

Capability ID: `chat-channels/identity`.

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

Capability ID: `chat-channels/conversation`.

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

Monitor publication lineage uses the admitted wake and its source run's matching
`set_task_monitor` receipt, including company, task, immutable agent, requester,
and scheduled time. A source ID in context cannot grant publication. The normal
delivery worker rechecks current endpoint and sender authority. Database fixtures
exercise lineage and finalization recovery; live Slack qualification remains
separate.

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
missing completed publication cannot authorize another write. Exact retries read an
existing receipt; the worker owns pending provider retries. A request interrupted
during metadata or file reads before staging can repeat that preflight with the
same full request identity. The immutable assessment, unique publication and
provider lease still serialize its external write. `begin_review` exact retries
resolve the run's current review and return a typed result instead of an audit
preview. Fresh gateway policy and provider authority remain
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
A terminal native success does not authorize missing-response publication while
its native phase or durable presentation decision remains pending. Maintenance
rechecks the same request after authoritative settlement; failures keep their
separate fallback path.
Maintenance projects the bounded server-committed native passive-wait decision
only after current request ownership. It settles a no-comment acknowledgement
without authorizing a new send or counting an old shared receipt as a current-run
reply. Existing final App/marker-owned PR content survives progress acknowledgements;
new canonical review publication remains the writer for replacement assessments.

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

Capability ID: `chat-channels/attachments`.

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

Capability ID: `chat-channels/lifecycle`.

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

After publishing a review, native agents can report `yielded` with
`response_wake` and no attention requests. Current conversation authorization
is checked again at commit. The task remains in review without a human card;
real human dependencies retain the ordinary attention-request path. A timed
wait requires a confirmed `set_task_monitor` schedule. Database coverage lives
in `external-chat-wait.integration.test.ts`; this is not live model evidence.

Inherited GitHub review waits (2026-10-26): an explicit native `response_wake`
after tree resume or same-agent continuation may retain the provider-event path
through accepted requester identity lineage and the latest processed review
publication for that task/conversation. This does not grant monitor management
or publication authority. Current task/agent/company binding, repository,
principal and endpoint checks remain effective. PostgreSQL regressions cover
quiet repeated finalization, historical publication reuse, newer unreviewed
heads and revoked access; live GitHub delivery remains separate acceptance.
Omitted/null yielded reports may use the current run's server-projected published
review wait. The same proof is rechecked at feedback, finalization and commit;
older/different-run review, pending publication and revoked connection cannot
supply it. This grants no new publication/monitor authority and leaves Done policy
unchanged; explicit malformed input is not coerced.

## `outbound-email`

Capability ID: `chat-channels/outbound-email`.

Review: `baseline`.

API: `present` — GET /api/companies/{companyId}/email/inboxes; POST /api/companies/{companyId}/email/send for both send/reply; GET /api/companies/{companyId}/email/tasks/{issueId}; GET /api/companies/{companyId}/email/deliveries/{publicationId}. Administrative uncertain-outcome resolution uses POST /api/companies/{companyId}/email/deliveries/{publicationId}/resolve.

Agent access: `partial` — the assigned agent can use the email REST/CLI path with its actual active run and admitted email.send/email.reply policy. Board writers use their own credential authority. Availability of a CLI or scenario email tool does not establish that a native run has that tool binding or generic fallback admitted.

Policy: Agent sends require ownership of the inbox and source task, task read access, an available agent within budget, a running task run that owns execution/checkout, standard work mode, and no restricted external execution. Active endpoint, connection, credential access, and email.send/email.reply policy are rechecked. Authenticated board sends require active company membership and credential access; viewer sends additionally require instance-admin status. Local implicit authority skips the membership check. Agent reads retain task/inbox/company checks; board thread/delivery reads use the route’s company-access boundary. Delivery resolution requires board tools:manage_connections or existing elevated operator authority, not ordinary agent access.

Evidence: `source-only` — reviewed at `9ef434fe79c57d976b8b03b14c5242db270b8320`. [Email CLI](../../cli/src/commands/client/email.ts), [request schema](../../packages/shared/src/validators/email.ts), [email routes](../../server/src/routes/email.ts), and [email authority/publication](../../server/src/services/email-channels.ts).

Verification: `not-run` — Use the actual permitted writer and run to create one child/publication, confirm recipient delivery and an exact-message reply, and repeat idempotent requests without duplicate sends. Assert run/owner/mode/budget/company/credential/attachment denials and separate read access. Inspect the provider before resolving an unknown write outcome; a 202 or queued publication alone is not proof of delivery.

Gaps: Real AgentMail transport, recipient delivery, and each native tool binding still need live proof. Controlled provider receipts and inbound-reply recipes do not establish a newly initiated external email journey.

Ordinary task Retry can select newer linked-human GitHub input whose original
admission was skipped by a budget or agent-availability gate. The chat owner
revalidates its exact processed delivery, company/task/agent/principal, unchanged
comment, session generation, and admitted instruction snapshot. A separate retry
receipt preserves the original skipped receipt and older failed native result.
Current access and normal native stop/cleanup guards still govern execution;
board wake metadata alone cannot manufacture chat authority or replay old work.
