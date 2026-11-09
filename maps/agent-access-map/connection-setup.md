# Connection setup — agent access

Product map: [Connection setup](../feature-map/connection-setup.md).

Feature ID: `connection-setup`.

Review date: 2026-10-12. Source commit: `f981fa3cc10cb8663a87dec60345fbff46d54d0a`.

This is a source-reviewed baseline of representative operations and known gaps.
Each capability needs operation-level review before its entire scope can be
qualified. No live agent execution is claimed. Follow the [map contract](../README.md)
for format, permission checks, evidence and maintenance.

Prompt Injection Prevention reuses shared OpenRouter API-key setup directly from
Settings → Connections. It adds no Apps provider or transport. Credential ownership
and audience rules are the existing connection rules; saving a connection alone
does not activate the service. See [service configuration](../../doc/prompt-injection-prevention.md).

## `catalog`

Capability ID: `connection-setup/catalog`.

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

Notebook is internally gated by `enablePaperclipNotebook` (default off, no settings toggle). Disabled instances hide setup/discovery and deny curated Notebook dispatch and publishing; local removal and grant revocation remain available.

The connector catalog declares the feature key. Shared availability checks use
the saved application identity. Notebook owns publication and file uploads;
Paperclip uses its existing MCP tools and OAuth flow.

Notebook source addition: `paperclip-notebook` is discoverable through
`connections_search` and requestable through `connection_request`. Its standard
personal authorization requests read, write, share, and delete scopes. Notebook
page ownership remains enforced by the remote service; a client-supplied agent
label grants no authority. The direct MCP connection requires no Cloud instance
enrollment. Notebook fixture evidence: `verified` against disposable PostgreSQL 18
with controlled MCP responses — [Notebook integration](../../doc/connections/PAPERCLIP-NOTEBOOK.md)
and [generic OAuth fixture](../../server/src/__tests__/generic-mcp-connection.test.ts).
Ordinary MCP calls retain assignment and Allowed / Ask first / Off policy.
Live deployed publication and hosted/self-hosted OAuth remain release checks.


## `identity-and-access`

Capability ID: `connection-setup/identity-and-access`.

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

Capability ID: `connection-setup/credentials`.

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

Braintrust uses the existing setup/request path for US and EU OAuth and API-key
methods. OAuth requests only `mcp`; provider authorization follows the selected
account's permissions. Personal invocation credentials must belong to their
user, while shared identities use company credentials. Region and explicit
method survive resume and reconnect. Agents use assigned tools through the
run-scoped gateway and receive no Braintrust token. See
[Braintrust](../../doc/connections/BRAINTRUST.md) for method keys and the
qualification matrix. Separate live US OAuth proof passed browser authorization,
49-tool discovery, bounded read, synthetic dataset insert/readback through actual
process-agent runs and gateway sessions, catalog refresh, OAuth reconnect, local
removal, post-removal denial, and structural API/log redaction. US API-key and
both EU methods remain `not-run` against real accounts. Live token expiry/refresh,
remote OAuth revocation, and native CLI automatic capability delivery remain
unqualified. Public metadata probes performed no registration or account
authorization; fixtures do not establish live proof for the remaining methods.

Daytona native setup uses an organization API key in the selected personal or
company vault grant. It does not borrow sandbox-provider credentials or CLI
login tokens. Agents use assigned provider tools through the normal run-bound
gateway; they cannot export the key. [Database-backed fixtures](../../server/src/__tests__/daytona-connection.test.ts)
cover selected vault ownership and gateway reads/writes with provider responses
replaced by fixtures. Real provider authentication remains unqualified.

Unikraft native setup uses an organization API token in the selected personal or
company vault grant. It does not borrow `unikraft login` state or `UKC_TOKEN`.
Agents use assigned provider tools through the run-bound gateway, limited to the
published metro hosts, and cannot export the token. [Database-backed fixtures](../../server/src/__tests__/unikraft-connection.test.ts)
cover vault ownership and gateway reads, writes and sandbox commands with
fixture provider responses. Real provider authentication remains unqualified.

## `handoff`

Capability ID: `connection-setup/handoff`.

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

Capability ID: `connection-setup/draft-recovery`.

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

Capability ID: `connection-setup/task-request`.

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

Capability ID: `connection-setup/channel-setup`.

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

Capability ID: `connection-setup/failure`.

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
