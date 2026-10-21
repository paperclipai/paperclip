---
navigation: {"section":"Apps, channels, and extensions","sectionOrder":50,"order":15}
---

# Assistant connections (MCP)

A person connects an external assistant to one Paperclip company, approves its requested access, uses company-scoped tools, and can revoke the personal connection. Browser consent, device login, and client execution have separate evidence requirements.

Feature ID: `assistant-connections`.

Implementation: [Apps setup](../../ui/src/pages/apps/AssistantConnection.tsx), [consent/device/management](../../ui/src/pages/McpConnect.tsx), [MCP CLI](../../cli/src/commands/mcp.ts).

Agent access: [companion](../agent-access-map/assistant-connections.md).

## Sub-features

- `setup`: `assistant-connections/setup` — find the configured MCP connection instructions and copy an invitation for the intended company.
- `consent`: `assistant-connections/consent` — approve or decline requested assistant access as the intended person, with explicit company and scope selection.
- `device-login`: `assistant-connections/device-login` — authorize a waiting client through a browser device code and save credentials only for the approved company/resource.
- `client-use`: `assistant-connections/client-use` — use the approved company’s MCP tools with current human permissions and exact granted scopes.
- `revocation`: `assistant-connections/revocation` — list personal assistant grants and revoke one without changing another person’s connection or already-delegated work.

## How to get to it (user POV)

### `apps-setup`

Open Apps → **Assistant Connection (MCP)** at `/apps/assistant-connection`. Copy the scoped invitation or expand the manual setup instructions. Public instance instructions are also available at `/mcp/setup` and `/mcp/setup.md` when enabled.

### `browser-consent`

Start connection from the external MCP client or scoped invitation, then open its `/mcp-connect/:id` browser request. Sign in if required, inspect the client/company/requested access, and choose **Connect organization** or **Cancel**.

### `device-authorization`

Run `paperclipai mcp login --device --url <exact-mcp-url> --company <company-uuid>`. For the current CLI journey, the configured authorization origin must equal the MCP issuer origin. Open the displayed verification page at `/mcp-device`, enter or inspect its code, choose the company/access, and approve or decline before returning to the waiting client.

### `assistant-client`

Use the assistant’s configured MCP client, or start `paperclipai mcp proxy --url <exact-mcp-url>` after device login. The local stdio proxy exposes initialize/ping/tools/list/tools/call and forwards authorized tool calls to the configured Paperclip resource.

### `manage-connections`

Open the current-company Assistant Connection card or `/assistant-connections` for your personal grants. Revoke the selected connection, then retry the same client credential. Client-side OAuth revocation is a separate supported transport.

## Driving it with Playwright, an MCP client, and the Paperclip CLI

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Use an owned authenticated instance with Assistant connections (MCP) enabled and the configured public MCP/authorization origin. Use HTTPS, or the documented HTTP loopback development exception, a real signed-in person, a disposable company, and an actual MCP client. Local implicit board access does not prove human consent. Record client, resource URL, requested/granted scopes, company, and experimental settings without codes, credentials, or tokens. See [Public MCP](../../doc/public-mcp.md) for the instance configuration and release limits.

### `apps-setup`

Automated: [Assistant setup UI](../../ui/src/pages/apps/AssistantConnection.test.tsx) covers mocked invitation, setup, status, and revocation. [Client metadata](../../server/src/__tests__/public-mcp-client-metadata.test.ts) and [MCP routes](../../server/src/__tests__/public-mcp.test.ts) cover configured origins, metadata, and identity restrictions. They do not prove setup in an external client.

Manual: Open the Apps card as the intended signed-in person, copy the invitation, and verify the exact configured resource and company hint without embedded credentials. Follow manual instructions in an owned MCP client and proceed through the separate consent journey. Reload Apps to inspect connection status. Check signed-out, unconfigured-origin, and disabled experimental states; never substitute a guessed server URL or local implicit identity. Verify public instructions and authenticated setup metadata have their documented access boundaries.

Sources: [Apps setup](../../ui/src/pages/apps/AssistantConnection.tsx), [public MCP routes](../../server/src/routes/public-mcp.ts), and [origin/gate policy](../../server/src/services/public-mcp/oauth.ts).

### `browser-consent`

Automated: [Public MCP integration](../../server/src/__tests__/public-mcp.test.ts) uses PostgreSQL and controlled clients for OAuth/device, protocol, scopes, company/gate checks, refresh, replay, and revocation. [Consent/device UI](../../ui/src/pages/McpConnect.test.tsx) mocks API responses. These tests do not qualify every external assistant or a live consent flow.

Manual: Request a disposable connection from an actual MCP client. As the intended person, inspect the exact company and requested read/write/configuration access, approve the chosen scopes, and verify the client returns to the approved resource. Call paperclip_connection and one harmless permitted read; compare person/company/scopes, then reload Apps and inspect the saved grant. Repeat Cancel, expired request, a viewer requesting write access, missing company membership, a mismatched pinned company, and write opt-out. Verify no requested scope is silently upgraded and that the browser origin/return path cannot be replaced by an unrelated site.

Sources: [Public MCP routes](../../server/src/routes/public-mcp.ts), [OAuth policy](../../server/src/services/public-mcp/oauth.ts), and [consent/device UI](../../ui/src/pages/McpConnect.tsx).

### `device-authorization`

Automated: [Public MCP integration](../../server/src/__tests__/public-mcp.test.ts) uses PostgreSQL and controlled clients for OAuth/device, protocol, scopes, company/gate checks, refresh, replay, and revocation. [Consent/device UI](../../ui/src/pages/McpConnect.test.tsx) mocks API responses. These tests do not qualify every external assistant or a live consent flow. [MCP credential transport](../../cli/src/__tests__/mcp-auth.test.ts) covers credential protection, refresh serialization, resource/issuer validation, and failures; it does not run the complete device CLI command against a real server.

Manual: Start a device request against the owned instance with explicit company and matching issuer/authorization origin. A server with separate browser authorization origin needs separate CLI qualification; do not report its rejected verification URL as a successful device flow. Compare terminal/browser request identity, approve as the real person, and verify the CLI’s paperclip_connection result matches the approved company before credentials are saved. Restart an owned client/proxy using the saved credential and prove a harmless remote call. In separate requests test a mistyped, declined, expired, or reused code, a wrong company/resource/issuer, and polling backoff. Keep codes and tokens out of captured artifacts; record outcomes and nonsecret request identity instead.

Sources: [Public MCP routes](../../server/src/routes/public-mcp.ts), [OAuth policy](../../server/src/services/public-mcp/oauth.ts), and [consent/device UI](../../ui/src/pages/McpConnect.tsx). [MCP commands](../../cli/src/commands/mcp.ts) and [device/credential client](../../cli/src/client/mcp-auth.ts).

### `assistant-client`

Automated: [Public MCP integration](../../server/src/__tests__/public-mcp.test.ts) exercises controlled protocol clients and real domain dispatch. [MCP credential transport](../../cli/src/__tests__/mcp-auth.test.ts) covers saved credentials, refresh, and resource/issuer checks. The fixtures do not prove an actual assistant’s tool discovery or useful output.

Manual: With a read-only personal grant, list tools, call paperclip_connection, and read a known accessible task in the approved company. Check a private/foreign task and an ungranted write. With a separate explicitly write-authorized grant, create a disposable task or document and verify its persisted contents, attribution, and discoverability through a second view. Confirm application permissions still restrict the person. Restart the proxy and exercise safe credential refresh. Reject an arbitrary REST operation through paperclip_call_api and a direct ordinary-REST request with the MCP bearer. Disable the gate or remove membership and verify later remote calls stop.

Sources: [MCP capabilities](../../server/src/services/public-mcp/capabilities.ts), [per-call authorization](../../server/src/services/public-mcp/oauth.ts), [public MCP routes](../../server/src/routes/public-mcp.ts), and [stdio proxy](../../cli/src/commands/mcp.ts).

### `manage-connections`

Automated: [Apps management UI](../../ui/src/pages/apps/AssistantConnection.test.tsx) covers mocked current-company controls, and [public MCP integration](../../server/src/__tests__/public-mcp.test.ts) covers persisted own-grant/token revocation. These component tests do not cover the account-wide `/assistant-connections` page or a real remote assistant after revocation.

Manual: First prove a harmless read using a personal client grant. Revoke that grant in the browser, reload its list, and retry the exact same credential: the remote call must fail. As a second person, confirm their grant remains usable. Attempt removal using another person’s grant ID; the API may return a harmless no-op, so verify that person’s grant is unchanged rather than demanding a specific error. Disable Assistant connections and confirm tool calls stop while signed-in list/revoke management remains reachable. Observe any work already delegated before revocation through its ordinary task controls; revocation does not cancel it.

Sources: [Connection management](../../ui/src/pages/McpConnect.tsx), [Apps management](../../ui/src/pages/apps/AssistantConnection.tsx), [management routes](../../server/src/routes/public-mcp.ts), and [grant ownership/revocation](../../server/src/services/public-mcp/oauth.ts).

## Gotchas

- Removing an assistant grant stops future authorized calls. Work it already delegated continues under the existing task controls.

- Approval decides a personal grant. It does not approve every future tool operation, assign an agent run, or make an external provider available to that person.

- A personal assistant grant acts as the person who approved it and remains scoped to one company. It grants no agent identity, instance-admin authority, third-party credentials, or arbitrary REST access.
- Client initialization can succeed locally; a remote authorized tool call is separate evidence. Provider/client interoperability and hosted release qualification remain explicit gaps.
