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

Backend evidence: [profile entry validation](../../server/src/__tests__/tool-profile-entry-validation.test.ts)
covers company-scoped selector references and bounded reads for a large immutable
runtime assignment. Batched validation retains the checks before profile and
entry writes. It grants no profile-management authority to agents.

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

Discovery collapses identical descriptors with the same gateway name across
providers, including native assigned-tool startup and fresh searches. Conflicting
definitions remain an error. Distinct names and the normal invocation grants,
approvals and revocation checks remain independent. Regression coverage lives in
[gateway tests](../../server/src/__tests__/tool-gateway.test.ts) and
[assigned-tool tests](../../server/src/services/native-runtime/assigned-mcp-tools.test.ts);
these fixtures do not certify a live external-client journey.

Native assigned tools return bounded input-schema repair guidance after argument
validation fails. Rejection creates no execution receipt and discloses no submitted
values or unknown keys. Corrected calls keep the same authorization checks.
[Runner regressions](../../packages/paperclip-runner/runner/crates/runner-core/src/tests/provider_assigned_tool_validation.rs)
cover discovery repair and unauthorized calls; the
[Codex transport fixture](../../packages/paperclip-runner/runner/crates/runner-core/tests/support/codex_assigned_tool_validation.rs)
covers rejection, corrected dispatch, and completion with a simulated provider.
This does not establish live model or GitHub access.

Remote invocation regressions preserve access to authorized sibling tools after
a fetch failure, timeout, non-authentication HTTP error, or JSON-RPC rejection.
HTTP 401/403 and insufficient-scope errors keep their connection gates. The
gateway records each failed invocation and never automatically replays it.
This covers the gateway service with synthetic providers and a local HTTP
server, not a live external provider or all client surfaces.

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

### Execution-host stdio assignments

Runner registers verified, session-local stdio servers from the execution host
with native Codex and through the shared ACPX runtime. ACPX clients must support
stdio MCP assignments. The transport uses each implementation's own schemas and
responses. Each binding requires a private Unix socket to identify the shared
resource whose calls are serialized. This is a separate binding alongside the
HTTP gateway; it does not create gateway/profile administration
authority. Tasks cannot supply these reserved environment inputs. Read-only
sessions omit them.
ACPX adapters use their applicable ACPX permission policy. Host-assigned native
Codex tools run without a new per-call prompt, matching existing execution-host shell
utilities. Explicit deny/prompt rules remain effective; requested approvals use
PRP with active thread/turn checks and one-time decisions. Preconfigured Claude
rejects interactive approval requests. See the [Runner contract](../../packages/paperclip-runner/README.md#assigned-local-mcp-servers).

Local fixture coverage: [binding validation](../../packages/paperclip-runner/src/drivers/stdio-mcp.test.ts),
[relay processes and cancellation](../../packages/paperclip-runner/runner/crates/runner-core/tests/stdio_mcp.rs),
and [approval projection](../../packages/paperclip-runner/src/drivers/codex/codex-question-adapter.test.ts).
Provider-client image and approval smoke tests used native Codex and Claude SDK;
that coverage is not an exhaustive adapter compatibility test.
Vendor-client evidence belongs in the PR. These checks do not
certify live external credentials, deployment isolation or gateway revocation.
