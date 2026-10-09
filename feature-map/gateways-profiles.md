# Tool gateways and access profiles

Administrators expose selected tools through gateways and reusable access profiles, connect clients, manage tokens, and inspect gateway activity.

Implementation: [gateways](../ui/src/pages/apps/gateways/GatewaysList.tsx), [gateway detail](../ui/src/pages/apps/gateways/GatewayDetail.tsx), [profiles](../ui/src/pages/tools/profiles/ProfileWizard.tsx).

## Sub-features

- `gateway`: create/edit an endpoint and select its exposed apps/tools.
- `profiles`: define reusable tool access configuration and inspect draft/detail state.
- `client-connect`: copy the intended endpoint/configuration to an authorized test client.
- `tokens`: create/revoke client credentials and verify their scope.
- `activity`: inspect tool discovery/calls and explicit errors.

## How to get to it (user POV)

### `gateway-client`

Open `/apps/gateways`, then a gateway’s Overview, Apps/Tools, Tokens, and Activity tabs.

### `access-profile`

Open `/apps/advanced/profiles`, create a profile, or follow its detail/edit route.

## Driving it

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Use a fixture tool connection and test client. Record gateway/profile, token owner, transport, and selected company.

### `gateway-client`

Automated: [gateway service](../server/src/__tests__/tool-gateway-service.test.ts), [connect client dialog](../ui/src/pages/apps/gateways/ConnectClientDialog.test.tsx), and [token panel](../ui/src/pages/apps/gateways/panels/TokensPanel.test.tsx) cover service/UI contracts.

Manual: Create a disposable gateway with one harmless tool, connect a client using its provided configuration, discover/call that tool, and inspect activity. Revoke the client token and confirm the same call fails. Test a tool outside the allowed set.

### `access-profile`

Automated: [profile wizard](../ui/src/pages/tools/profiles/ProfileWizard.test.tsx) and [profile detail](../ui/src/pages/tools/profiles/ProfileDetail.test.tsx) cover component behavior with mocks.

Manual: Create a bounded profile, choose its offered tools and options, save or resume its draft, and reload the detail. Apply/connect it through the offered flow and inspect the actual client-visible tool set. Verify cancellation and invalid selections retain an understandable draft.

## Gotchas

- A copied endpoint is not proof of client authentication or tool discovery.
- Gateway access cannot replace underlying connection/action permission checks.
- Advanced tool routes require the appropriate admin gate; legacy tool URLs may redirect.
