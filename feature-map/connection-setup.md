# Connection setup

People connect an app or account, choose who may use it, and recover incomplete
setup from either Apps or a task that needs access. A saved draft, a completed
provider login, a usable connection, and a resumed task are separate checkpoints.
Chat channels additionally require an endpoint and linked sender identity.

## Sub-features

- `catalog`: find a provider, inspect its available methods, and open setup;
  unavailable methods explain their prerequisite rather than silently switching.
- `identity-and-access`: select personal/shared identity and eligible agents;
  an empty explicit selection and company-wide access must not be confused.
- `credentials`: provider sign-in, key, or generic MCP URL follows its supported
  setup method; credentials are not retained in browser draft storage.
- `handoff`: provider popup/full-page callback returns to the correct setup
  host with the original task intent and identity choice intact.
- `draft-recovery`: cancel, Back, Save & exit, reload, Finish setup, and reconnect
  preserve the exact draft rather than creating duplicate connections.
- `task-request`: only the addressed person resolves the requested connection;
  usable access releases the pending task request through normal continuation.
- `channel-setup`: provider endpoint, represented agent, linked sender, and
  communication instructions are configured before an external message is used.
- `failure`: denied login, unreachable/private URL, expired credentials, and
  permission errors leave an actionable state rather than a false success.

## How to get to it (user POV)

### `apps-catalog`

Open Apps (`/apps`), choose an app, and connect from its landing page. Select an
available method and access, then complete setup. Existing connections open
their details; unfinished ones offer a way to finish setup.

### `mcp-link`

Use **Connect with a link** or `/apps/byo` for a generic MCP server. Paste its
URL, select access, and follow the probe's sign-in/key guidance. Provider-specific
catalog setup and a generic endpoint may use different flows.

### `task-request`

Open the task's pending connection request and its setup action as the named
user. Setup can open in a task dialog and may use an OAuth popup. Follow the
request's original link if setup falls back to a standalone page.

### `resume-connection`

From Apps or connection details, use Finish setup, reconnect, or the offered
authentication recovery action. Reload or return from the provider before
checking whether the same saved connection became usable.

### `chat-channel`

With chat connectors enabled, select a supported chat/email provider in Apps
or open `/apps/chat/connect`. Complete that provider's endpoint setup, then
open its settings (`/apps/chat/:endpointId/settings`). Follow identity linking
as the intended sender before messaging the agent externally.

## Driving it

Preconditions: follow the [baseline](./README.md#before-driving-a-journey).
Choose a disposable provider account/resource and record its auth method,
deployment mode, account ownership, and access selection. For live setup, use
the provider's documented prerequisites in the
[connector playbook](../doc/connections/CONNECTOR-PLAYBOOK.md). Automated fixtures
do not establish OAuth registration, public callbacks, or production provider access.

### `apps-catalog`

Automated: [Browse](../ui/src/pages/apps/Browse.test.tsx),
[unconnected app](../ui/src/pages/apps/AppNotConnected.test.tsx), and
[AppsConnect](../ui/src/pages/apps/AppsConnect.test.tsx) cover catalog entry,
access selection, provider-specific method choices, and setup failures with
mocked APIs. [Connection intents](../tests/e2e/connection-intents.spec.ts)
drives store and task setup against one fake provider through a useful continuation:

```sh
pnpm exec vitest run ui/src/pages/apps/Browse.test.tsx ui/src/pages/apps/AppsConnect.test.tsx
pnpm exec playwright test -c tests/e2e/playwright.config.ts tests/e2e/connection-intents.spec.ts
```

Manual: connect from an unconnected provider landing. Select the intended
identity and agent access, complete authentication, reload, and inspect the
saved connection. Run a permitted read-only action with an eligible agent and
verify its useful result. Try an ineligible agent and confirm denial. Repeat
with a user who cannot install company-wide; the UI must not imply broad access.

### `mcp-link`

Automated: AppsConnect's generic MCP cases cover probe-driven auth, private or
unreachable endpoints, preregistered clients, secret-backed headers, and unsafe
authorization URLs. These are component/API mocks, not remote provider proof.

Manual: connect a known test MCP URL through the link flow, verify its saved
endpoint and a read-only action, then repeat with a bad URL and wrong credential.
The error should explain the next action and preserve non-secret setup context.
Test no-auth and authenticated endpoints separately; never infer one from the other.

### `task-request`

Automated: [interaction card](../ui/src/components/IssueThreadInteractionCard.test.tsx)
checks addressed-user controls. AppsConnect tests cover page/dialog parity,
task-bound OAuth, popup handoff, and verifying a saved connection before closing.
The connection-intents browser suite above exercises fixture-backed continuation.

Manual: ask an agent to use an unavailable app, open its request as the named
user, and complete setup in the dialog. Verify the card settles, the exact task
resumes, and the agent returns a useful provider result. Repeat the page-host
fallback and denied OAuth path. As another user, confirm that merely seeing the
task does not grant the right to resolve the request.

### `resume-connection`

Automated: AppsConnect tests cover exact-draft resume, declined OAuth, reconnect
lookup failure/retry, response-lost creation, archived connection revival, and
saved account reuse. [App detail](../ui/src/pages/apps/AppDetail.test.tsx) covers
the connection host. These tests do not complete a real provider login.

Manual: leave setup through its footer, reload Apps, choose Finish setup, and
confirm the same connection is resumed. Decline provider login and recover from
that checkpoint. Reconnect an expired disposable account and verify a permitted
action afterwards. Count connections before/after to catch accidental duplicates.

### `chat-channel`

Automated: [setup routing](../ui/src/pages/apps/chat/ChatEndpointSetup.routing.test.tsx),
[saved setup state](../ui/src/pages/apps/chat/ChatEndpointSetup.state.test.ts),
[email setup](../ui/src/pages/apps/chat/EmailEndpointSetup.test.tsx), and
[identity confirmation](../ui/src/pages/apps/chat/ChatIdentityConfirm.test.tsx)
cover shared UI logic with fixtures. Provider-specific live setup is not implied.

Manual: complete setup for one named provider, reload endpoint settings, link
the intended sender, and send a disposable message. Verify one task and a useful
reply in the originating conversation. Inspect an unlinked sender's denial and
the endpoint's pause behavior. Repeat independently for each provider at issue;
Slack setup does not qualify Discord, Telegram, GitHub, email, or iMessage.

## Gotchas

- A successful OAuth callback is not proof of saved connection access or task
  continuation. Verify all three checkpoints.
- Personal identity, shared account access, and per-agent access are distinct.
  Connecting an account does not waive an Off action or Ask first review.
- A tool app connection is not a chat endpoint. The same provider can offer both.
- Old Apps/Connections URLs can redirect to Apps. Use the current navigation and
  record the actual destination rather than documenting an obsolete screen.
- Full provider matrix, AI-account selection, gateway/profile administration,
  and account revocation lifecycles remain outside this seed recipe.
- For governed actions after setup, use [questions and approvals](./questions-and-approvals.md).
