# Assistant connections (MCP) — agent access

Product map: [Assistant connections (MCP)](../feature-map/assistant-connections.md).

Feature ID: `assistant-connections`.

This is a source-reviewed baseline of the public assistant connection boundary.
The records distinguish a personal assistant acting as its consenting human from
an ordinary Paperclip agent. Review and execute each listed operation before
qualifying the complete capability. No live client, consent, or authorization
proof is claimed. Follow the [map contract](../README.md).

## `setup`

Capability ID: `assistant-connections/setup`.

Review: `baseline`.

API: `present` — GET /api/mcp/setup for authenticated setup metadata; GET /mcp/setup and GET /mcp/setup.md for enabled public instructions.

Agent access: `restricted` — an external assistant can read enabled public setup instructions, but authenticated setup management requires a signed-in human session/cloud_tenant source. A Paperclip agent, personal MCP bearer, local implicit board, or human board bearer does not supply that browser identity.

Policy: The instance enablePublicMcp gate and configured MCP/authorization origin govern public setup and transport. Authenticated management requires an actual board user from session or cloud_tenant. The copied company hint does not grant membership, scopes, or execution authority. HTTPS is required apart from the defined loopback development exception.

Evidence: `source-only` — reviewed at `9ef434fe79c57d976b8b03b14c5242db270b8320`. [Apps setup](../../ui/src/pages/apps/AssistantConnection.tsx), [public MCP routes](../../server/src/routes/public-mcp.ts), and [origin/gate policy](../../server/src/services/public-mcp/oauth.ts).

Verification: `not-run` — Inspect the invitation/resource/company from a permitted browser, then exercise a remote authorized client call only after separate consent. Reject unsupported management identities and check disabled/unconfigured setup without exposing secrets. Do not count copied instructions as a completed connection.

Gaps: No ordinary-agent self-consent or management path is established. Published plugin distribution, each client’s installation, and hosted interoperability require their own qualification.

## `consent`

Capability ID: `assistant-connections/consent`.

Review: `baseline`.

API: `present` — POST /mcp/oauth/register; GET /mcp/oauth/authorize; GET /api/mcp/requests/{id}; POST /api/mcp/requests/{id}/consent; POST /mcp/oauth/token with authorization-code exchange.

Agent access: `restricted` — a public client can initiate registration/authorization, but the approval belongs to the real signed-in human. Ordinary agent REST/native call_api cannot manufacture a human session or browser origin to approve itself.

Policy: Public-client authorization uses S256 PKCE, exact callback/resource binding, configured origin, and the live experimental gate. Browser consent requires the authenticated session/cloud_tenant human and a matching configured Origin/Referer. Approval requires active membership in the selected unarchived company; a company hint pins selection. A viewer may approve read only. Granted scopes must be requested and explicitly accepted, and subsequent domain operations retain the person’s current permissions.

Evidence: `source-only` — reviewed at `9ef434fe79c57d976b8b03b14c5242db270b8320`. [Public MCP routes](../../server/src/routes/public-mcp.ts), [OAuth policy](../../server/src/services/public-mcp/oauth.ts), and [consent/device UI](../../ui/src/pages/McpConnect.tsx).

Verification: `not-run` — Complete an actual client/browser authorization-code exchange and verify exact person/company/scopes by a remote tool call. Decline or expire another request; reject wrong company/origin/callback/resource/PKCE and scope escalation. A board request without the real consent identity is not acceptance evidence.

Gaps: Source fixtures establish the protocol boundary, not compatibility of every assistant/client callback or hosted signup path. Actual denied/expired browser and client states remain not run.

## `device-login`

Capability ID: `assistant-connections/device-login`.

Review: `baseline`.

API: `present` — POST /mcp/oauth/device_authorization; GET /api/mcp/device with user_code; POST /api/mcp/device/consent; POST /mcp/oauth/token with the device grant.

Agent access: `restricted` — the device flow lets a configured client wait for human authorization. Its CLI transport does not let a Paperclip agent approve the browser decision or reuse another person’s saved credential.

Policy: Human consent retains the same company membership, viewer/read-only, requested scope, browser-origin, resource, and gate constraints as browser consent. Codes expire and are single-use; polling backoff is persisted. The CLI validates issuer/resource and requires the verification URI at the issuer’s /mcp-device, so its current journey needs matching MCP and authorization origins. It calls paperclip_connection to confirm the approved company before accepting working credentials.

Evidence: `source-only` — reviewed at `9ef434fe79c57d976b8b03b14c5242db270b8320`. [Public MCP routes](../../server/src/routes/public-mcp.ts), [OAuth policy](../../server/src/services/public-mcp/oauth.ts), and [consent/device UI](../../ui/src/pages/McpConnect.tsx). [MCP commands](../../cli/src/commands/mcp.ts) and [device/credential client](../../cli/src/client/mcp-auth.ts).

Verification: `not-run` — Complete one real terminal/browser request with explicit company, inspect the approved remote identity, and reuse the saved credential for a bounded read. Reject mistyped/denied/expired/replayed codes, wrong issuer/resource/company, and excess polling without saving an unauthorized credential.

Gaps: Separate authorization-origin support for the CLI is unqualified; the server can return a verification URI that the current CLI rejects. No live CLI device/stdio journey was executed. A credential-transport unit test or local proxy initialization is not proof that the waiting client was authorized.

## `client-use`

Capability ID: `assistant-connections/client-use`.

Review: `baseline`.

API: `present` — POST /mcp/paperclip for MCP tools/list and tools/call. Supported modern request transport also includes server/discover and events/list, events/subscribe, and events/unsubscribe; these are protocol operations, not arbitrary REST endpoints.

Agent access: `available` — a configured external MCP client or the supported CLI proxy acts through the authorizing human’s grant. Each Paperclip native/remote run still needs its own actual admitted client/binding; a personal assistant connection is not automatically an agent tool or credential.

Policy: Every remote call rechecks the experimental gate, resource/client/grant/token status, expiration/revocation, human/company/membership status, scopes, and underlying domain permissions for exactly one company. The public paperclip_call_api tool permits only enumerated capabilities. An MCP bearer cannot authenticate as an ordinary REST board user or agent, and the grant confers no instance-administrator authority. The proxy does not automatically retry writes.

Evidence: `source-only` — reviewed at `9ef434fe79c57d976b8b03b14c5242db270b8320`. [MCP capabilities](../../server/src/services/public-mcp/capabilities.ts), [per-call authorization](../../server/src/services/public-mcp/oauth.ts), [public MCP routes](../../server/src/routes/public-mcp.ts), and [stdio proxy](../../cli/src/commands/mcp.ts).

Verification: `not-run` — Prove remote identity, a permitted read and separately authorized additive write with persisted attribution. Assert private/foreign resources, missing write scope, arbitrary call_api operations, disabled gate, membership loss, and misuse of the MCP bearer at ordinary REST. Check actual client discovery rather than a declared scenario tool.

Gaps: Modern event/discovery interoperability, each external client, and all allowlisted capabilities need their own live proof. Local initialize/ping results are not evidence of remote authorization or execution.

## `revocation`

Capability ID: `assistant-connections/revocation`.

Review: `baseline`.

API: `present` — GET /api/mcp/connections; DELETE /api/mcp/connections/{id}; POST /mcp/oauth/revoke for client/token/resource-bound OAuth revocation.

Agent access: `restricted` — browser management lists/revokes the real signed-in person’s grants. Ordinary agent/local-implicit/MCP bearer identities cannot use that human-management API; a client can revoke only a correctly bound OAuth token.

Policy: Management requires the session/cloud_tenant board user; mutations require the configured browser origin. List/delete are restricted to the current person. Another person’s ID can be a silent no-op. OAuth revocation binds token, client, and resource. Human list/revoke management remains available while enablePublicMcp is off, though remote tool calls do not. Already-delegated work retains its ordinary task lifecycle.

Evidence: `source-only` — reviewed at `9ef434fe79c57d976b8b03b14c5242db270b8320`. [Connection management](../../ui/src/pages/McpConnect.tsx), [Apps management](../../ui/src/pages/apps/AssistantConnection.tsx), [management routes](../../server/src/routes/public-mcp.ts), and [grant ownership/revocation](../../server/src/services/public-mcp/oauth.ts).

Verification: `not-run` — Make a remote read succeed, revoke as the grant owner, and reject the same credential afterward. Check persisted list state, another person’s untouched grant, membership loss, disabled transport with reachable management, and OAuth token/client/resource binding. Verify task cancellation separately if required.

Gaps: Revocation is not remote-provider termination or task cancellation. The account-wide management page lacks the component coverage named by the current-company recipe. No ordinary-agent delegated human-management path or live client revocation proof is claimed.
