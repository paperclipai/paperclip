---
navigation: {"section":"Apps, channels, and extensions","sectionOrder":50,"order":40}
---

# Tool gateways and access profiles

Administrators expose selected tools through gateways and reusable access profiles, connect clients, manage tokens, and inspect gateway activity.

Implementation: [gateways](../../ui/src/pages/apps/gateways/GatewaysList.tsx), [gateway detail](../../ui/src/pages/apps/gateways/GatewayDetail.tsx), [profiles](../../ui/src/pages/tools/profiles/ProfileWizard.tsx).

Agent access: [companion](../agent-access-map/gateways-profiles.md).

## Sub-features

- `gateway`: create/edit an endpoint backed by a tool access profile.
- `profiles`: define reusable tool access configuration and inspect draft/detail state.
- `client-connect`: copy the intended endpoint/configuration to an authorized test client.
- `tokens`: create/revoke client credentials and verify their scope.
- `activity`: inspect tool discovery/calls and explicit errors.

## How to get to it (user POV)

### `gateway-client`

Open `/apps/gateways`, then a gateway’s Overview, Apps/Tools, Tokens, and Activity tabs.

### `access-profile`

Open `/apps/advanced/profiles`, create a profile, or follow its detail/edit route.

## Driving it with Playwright and an MCP client

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Use a fixture tool connection and test client. Record gateway/profile, token owner, transport, and selected company.

Gateway creation selects a profile. Maintain that profile's app/action selection
through the Apps/Tools links; the gateway form is not a separate tool picker.
Use an active organization member for human-scoped access, and check the actual
endpoint authorization independently of whether the admin UI is visible.

### `gateway-client`

Automated: [gateway service](../../server/src/__tests__/tool-gateway-service.test.ts), [connect client dialog](../../ui/src/pages/apps/gateways/ConnectClientDialog.test.tsx), and [token panel](../../ui/src/pages/apps/gateways/panels/TokensPanel.test.tsx) cover service/UI contracts.

Gateway regressions also cover a failed remote call followed by a successful
sibling tool call. Transient failures preserve the catalog. Authentication
failures retain their access gates. Real HTTP timeout fixtures verify an explicit
retry starts a fresh MCP session without replaying the failed action. These
checks do not establish a live provider journey.

Manual: Create a disposable gateway with one harmless tool, connect a client using its provided configuration, discover/call that tool, and inspect activity. Revoke the client token and confirm the same call fails. Test a tool outside the allowed set.

### `access-profile`

Automated: [profile wizard](../../ui/src/pages/tools/profiles/ProfileWizard.test.tsx) and [profile detail](../../ui/src/pages/tools/profiles/ProfileDetail.test.tsx) cover component behavior with mocks.

Backend: [profile entry validation](../../server/src/__tests__/tool-profile-entry-validation.test.ts)
uses isolated PostgreSQL to create and replace a 518-selector assignment with
bounded reference reads. It checks exact selector retention, company boundaries,
invalid input order, and fresh validation after deletion. This does not establish
live client latency.

Manual: Create a bounded profile, choose its offered tools and options, save or resume its draft, and reload the detail. Apply/connect it through the offered flow and inspect the actual client-visible tool set. Verify cancellation and invalid selections retain an understandable draft.

## Gotchas

- A copied endpoint is not proof of client authentication or tool discovery.
- Gateway access cannot replace underlying connection/action permission checks.
- Advanced tool routes require the appropriate admin gate; legacy tool URLs may redirect.

### Storybook verification

#### `tokens`

Scope: ui
Storybook: Mount current TokensPanel with issue controls, once-only token reveal, expiry/actions, revocation confirmation and failures. Old GatewaysTab fixtures and assistant OAuth revocation are insufficient.
Production: Issue bounded token via POST /tool-gateway/gateways/{id}/tokens; call allowed and excluded tools; revoke via /tool-gateway/gateway-tokens/{id}/revoke and verify denial using same client.
Sources: Source: [TokensPanel.tsx](../../ui/src/pages/apps/gateways/panels/TokensPanel.tsx), [tool-gateway.ts](../../server/src/routes/tool-gateway.ts), [tools.ts](../../ui/src/api/tools.ts). Tests: [TokensPanel.test.tsx](../../ui/src/pages/apps/gateways/panels/TokensPanel.test.tsx), [tool-gateway-service.test.ts](../../server/src/__tests__/tool-gateway-service.test.ts), [tool-gateway.test.ts](../../server/src/__tests__/tool-gateway.test.ts)
