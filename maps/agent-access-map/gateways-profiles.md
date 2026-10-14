# Tool gateways and access profiles — agent access

Product map: [Tool gateways and access profiles](../feature-map/gateways-profiles.md).

Review date: 2026-10-12. Source commit: `58e16dbddfc9c8d0cf60867f9d9847f0feda055b`.
Native REST transport reconciled in this change; see the
[shared transport contract](README.md#native-rest-transport).

This is a source-reviewed baseline of representative operations and known gaps.
Each capability needs operation-level review before its entire scope can be
qualified. No live agent execution is claimed. Follow the [map contract](../README.md)
for format, permission checks, evidence and maintenance.

## `gateway`

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/companies/{companyId}/tools/gateways`.

Agent access: `restricted` — Board tools:admin REST; CLI connections/configuration where
supported.

Policy: Named gateway/profile administration and credentials are board tools:admin;
agent sessions/tool use use separate scoped authority.

Evidence: `source-only` — [implementation](../../server/src/routes/tool-gateway.ts#L353)
at the reviewed commit above.

Verification: `not-run` — assert the documented agent denial with an owned test fixture;
verify any listed agent request/result path separately. A delegated operation needs its
own policy and access review.

Gaps: No agent named-gateway management path; assigned tool use exists separately.

## `profiles`

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/companies/{companyId}/tools/profiles`.
- `PATCH /api/tool-profiles/{profileId}`.

Agent access: `restricted` — Board management REST; agent receives effective tool
assignment.

Policy: Named gateway/profile administration and credentials are board tools:admin;
agent sessions/tool use use separate scoped authority.

Evidence: `source-only` — [implementation](../../server/src/routes/tool-gateway.ts#L353)
at the reviewed commit above.

Verification: `not-run` — assert the documented agent denial with an owned test fixture;
verify any listed agent request/result path separately. A delegated operation needs its
own policy and access review.

Gaps: Agent access to tools does not permit profile editing.

## `client-connect`

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/tool-gateway/gateways/{gatewayId}/mcp`.
- `POST /api/tool-gateway/sessions`.

Agent access: `partial` — Agent REST / native `call_api` for scoped session creation
and revocation; existing MCP client protocol and assigned native app tools.

Policy: Named gateway/profile administration and credentials are board tools:admin;
agent sessions/tool use use separate scoped authority.

Evidence: `source-only` — [implementation](../../server/src/routes/tool-gateway.ts#L353)
at the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Scoped sessions remain agent/run-bound. MCP requires its existing protocol
client; named gateways and gateway-token management retain board permissions.

## `tokens`

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/tool-gateway/gateways/{gatewayId}/tokens`.
- `POST /api/tool-gateway/gateway-tokens/{tokenId}/revoke`.

Agent access: `restricted` — Board tools:admin token management.

Policy: Named gateway/profile administration and credentials are board tools:admin;
agent sessions/tool use use separate scoped authority.

Evidence: `source-only` — [implementation](../../server/src/routes/tool-gateway.ts#L353)
at the reviewed commit above.

Verification: `not-run` — assert the documented agent denial with an owned test fixture;
verify any listed agent request/result path separately. A delegated operation needs its
own policy and access review.

Gaps: Gateway-token management requires board tools:admin at the HTTP route.
A grant to use an app does not create this authority; native `call_api` preserves
the denial.

## `activity`

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/tool-gateway/audit`.

Agent access: `restricted` — Board tools:view_audit; agent receives its own tool
receipts/errors.

Policy: Named gateway/profile administration and credentials are board tools:admin;
agent sessions/tool use use separate scoped authority.

Evidence: `source-only` — [implementation](../../server/src/routes/tool-gateway.ts#L353)
at the reviewed commit above.

Verification: `not-run` — assert the documented agent denial with an owned test fixture;
verify any listed agent request/result path separately. A delegated operation needs its
own policy and access review.

Gaps: Audit management API exists but broad audit visibility is not an agent use-path
guarantee.
