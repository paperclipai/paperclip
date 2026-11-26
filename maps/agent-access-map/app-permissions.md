# App access, action permissions, and testing — agent access

Product map: [App access, action permissions, and
testing](../feature-map/app-permissions.md).

Review date: 2026-10-12. Source commit: `f981fa3cc10cb8663a87dec60345fbff46d54d0a`.

This is a source-reviewed baseline of representative operations and known gaps.
Each capability needs operation-level review before its entire scope can be
qualified. No live agent execution is claimed. Follow the [map contract](../README.md)
for format, permission checks, evidence and maintenance.

## `agent-access`

Review: `baseline`.

API: `present` — representative operation IDs:

- `PUT /api/tool-connections/{connectionId}/installs`.

Agent access: `restricted` — Board management API; agents use their resulting assigned
app tools.

Policy: Connection/profile/policy management routes require a board user; tool use
separately evaluates agent grants and action policies.

Evidence: `source-only` — [implementation](../../server/src/routes/tool-access.ts#L517)
at the reviewed commit above.

Verification: `not-run` — assert the documented agent denial with an owned test fixture;
verify any listed agent request/result path separately. A delegated operation needs its
own policy and access review.

Gaps: Granting access is distinct from using access. No equivalent agent management path
exists in these routes.

The owning lifecycle plugin can read bounded standing connection and active
profile assignments with `ctx.agents.getRuntime`. It requires the existing
`agents.lifecycle.manage` capability and agent ownership checks. Committed
assignment changes use the opt-in `agent_runtime` stream. These inputs contain
no grant credentials and do not authorize a task's tool calls. See the
[runtime contract](../../doc/plugins/AGENT_RUNTIME_SYNC.md#standing-connection-assignments).

## `action-policy`

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/tool-profiles/{profileId}/entries`.

Agent access: `restricted` — Board management API; agent execution follows
off/ask/allowed.

Policy: Connection/profile/policy management routes require a board user; tool use
separately evaluates agent grants and action policies.

Evidence: `source-only` — [implementation](../../server/src/routes/tool-access.ts#L517)
at the reviewed commit above.

Verification: `not-run` — assert the documented agent denial with an owned test fixture;
verify any listed agent request/result path separately. A delegated operation needs its
own policy and access review.

Gaps: An agent cannot authorize itself by editing the policy. Decide whether any
explicitly delegated administration should be supported.

## `catalog-change`

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/tool-profiles/{profileId}/new-tools/review`.

Agent access: `restricted` — Board catalog-review API; agents can discover authorized
tools.

Policy: Connection/profile/policy management routes require a board user; tool use
separately evaluates agent grants and action policies.

Evidence: `source-only` — [implementation](../../server/src/routes/tool-access.ts#L517)
at the reviewed commit above.

Verification: `not-run` — assert the documented agent denial with an owned test fixture;
verify any listed agent request/result path separately. A delegated operation needs its
own policy and access review.

Gaps: Catalog refresh/review and quarantined-action enablement are management
operations.

Daytona also checks its deployed native contract on the board's
`GET /api/tool-connections/{connectionId}/catalog`. A changed saved catalog
refreshes under the viewing human's credential context. Retired tools are
hidden even if refresh fails. Agent discovery and dispatch reject retired names
and stale same-name contracts before refresh; new/changed tools stay quarantined until reviewed. The
[database-backed Daytona fixtures](../../server/src/__tests__/daytona-connection.test.ts)
exercise this boundary through real run-bound gateway sessions with fixture
provider responses. They do not qualify a live Daytona account or agent model.

## `test-action`

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/tool-connections/{connectionId}/test-calls`.

Agent access: `restricted` — Board test-as-agent API; agent executes its own assigned
tools normally.

Policy: Connection/profile/policy management routes require a board user; tool use
separately evaluates agent grants and action policies.

Evidence: `source-only` — [implementation](../../server/src/routes/tool-access.ts#L517)
at the reviewed commit above.

Verification: `not-run` — assert the documented agent denial with an owned test fixture;
verify any listed agent request/result path separately. A delegated operation needs its
own policy and access review.

Gaps: A board test performed as an agent is not proof the agent can manage or invoke the
testing endpoint.

## `account-maintenance`

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/tool-connections/{connectionId}/reconnect`.
- `GET /api/tool-connections/{connectionId}/activity`.

Agent access: `restricted` — Board account management; native
connections_search/connection_request can request human setup.

Policy: Connection/profile/policy management routes require a board user; tool use
separately evaluates agent grants and action policies.

Evidence: `source-only` — [implementation](../../server/src/routes/tool-access.ts#L517)
at the reviewed commit above.

Verification: `not-run` — assert the documented agent denial with an owned test fixture;
verify any listed agent request/result path separately. A delegated operation needs its
own policy and access review.

Gaps: Agent requests and continued tool use exist; reconnect/revoke/audit management are
human paths.
