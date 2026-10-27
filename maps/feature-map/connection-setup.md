---
navigation: {"section":"Apps, channels, and extensions","sectionOrder":50,"order":10}
---

# Connection setup

People connect an app or account, choose who may use it, and recover incomplete
setup from either Apps or a task that needs access. A saved draft, a completed
provider login, a usable connection, and a resumed task are separate checkpoints.
Chat channels additionally require an endpoint and linked sender identity.

Feature ID: `connection-setup`.

Agent access: [companion](../agent-access-map/connection-setup.md).

Prompt Injection Prevention reuses shared OpenRouter API-key setup directly from
Settings → Connections. It adds no Apps provider or transport. Credential ownership
and audience rules are the existing connection rules; saving a connection alone
does not activate the service. See [service configuration](../../doc/prompt-injection-prevention.md).

1Password is available from Apps with a service-account token and an official
service-account creation link. Its vault access is chosen in 1Password; action
policies use the ordinary Permissions screen. See [connector notes](../../doc/connections/1PASSWORD.md).

## Sub-features

- `catalog`: `connection-setup/catalog` — find a provider, inspect its available methods, and open setup;
  unavailable methods explain their prerequisite rather than silently switching.
- `identity-and-access`: `connection-setup/identity-and-access` — select personal/shared identity and eligible agents;
  an empty explicit selection and company-wide access must not be confused.
- `credentials`: `connection-setup/credentials` — provider sign-in, key, or generic MCP URL follows its supported
  setup method; credentials are not retained in browser draft storage.
- `handoff`: `connection-setup/handoff` — provider popup/full-page callback returns to the correct setup
  host with the original task intent and identity choice intact.
- `draft-recovery`: `connection-setup/draft-recovery` — cancel, Back, Save & exit, reload, Finish setup, and reconnect
  preserve the exact draft rather than creating duplicate connections.
- `task-request`: `connection-setup/task-request` — only the addressed person resolves the requested connection;
  usable access releases the pending task request through normal continuation.
- `channel-setup`: `connection-setup/channel-setup` — provider endpoint, represented agent, linked sender, and
  communication instructions are configured before an external message is used.
- `failure`: `connection-setup/failure` — denied login, unreachable/private URL, expired credentials, and
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

## Driving it with Playwright and the Paperclip CLI

Preconditions: follow the [baseline](./README.md#before-driving-a-journey).
Choose a disposable provider account/resource and record its auth method,
deployment mode, account ownership, and access selection. For live setup, use
the provider's documented prerequisites in the
[connector playbook](../../doc/connections/CONNECTOR-PLAYBOOK.md). Automated fixtures
do not establish OAuth registration, public callbacks, or production provider access.

### `apps-catalog`

Automated: [Browse](../../ui/src/pages/apps/Browse.test.tsx),
[unconnected app](../../ui/src/pages/apps/AppNotConnected.test.tsx), and
[AppsConnect](../../ui/src/pages/apps/AppsConnect.test.tsx) cover catalog entry,
access selection, provider-specific method choices, and setup failures with
mocked APIs. [Connection intents](../../tests/e2e/connection-intents.spec.ts)
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

Notebook is internally gated by `enablePaperclipNotebook` (default off, no settings toggle). Disabled instances hide setup/discovery and deny curated Notebook dispatch and publishing; local removal and grant revocation remain available.

Availability is catalog metadata evaluated by shared connector checks. Notebook
publication and file uploads stay in the Notebook service.

Paperclip Notebook uses the existing personal-account MCP OAuth setup at
`https://notebook.paperclip.app/mcp`. Sign in through Cloud, assign agents, and
verify tool discovery. The connection keeps its default catalog name.
Reconnect must preserve agent assignments and Allowed / Ask first / Off choices.
Removal disables local use and clears saved credentials. Remote authorization
can be revoked separately in Notebook's Connected apps screen; automatic remote
cleanup and custom keyed refresh recovery are deferred. A lost rotating-token
response may require reconnecting. Notebook tools use the selected connection's
ordinary action gateway. See [Notebook](../../doc/connections/PAPERCLIP-NOTEBOOK.md)
for the Notebook-owned uploader and fixture coverage. Live Notebook qualification
still requires the deployed service and both hosted and self-hosted clients.

Daytona follows this same key/access wizard. Its native method exposes the
published platform and Toolbox HTTP actions using provider sandbox IDs, without
a Paperclip task or lease requirement. [Daytona browser setup](../../tests/e2e/daytona-connector.spec.ts)
checks the catalog, password field, access controls, and optional organization
pin. It does not submit a key or qualify a real provider account. See
[Daytona](../../doc/connections/DAYTONA.md) for API-key authority and OAuth limits.

For Braintrust, verify US OAuth (default), US API key, EU OAuth, and EU API key
from both Apps and `/apps/connect?source=braintrust`. Inspect the exact regional
endpoint and method after Save & exit, cancellation/resume, and reconnect;
these operations must retain the saved connection and its access choices.
Verify the key stays out of browser draft storage and public responses, then
perform a bounded read and disposable write through an actual eligible run.
The [Braintrust qualification matrix](../../doc/connections/BRAINTRUST.md#qualification-record)
records completed US OAuth connect/discovery, bounded read, synthetic write
through actual process-agent gateway calls, catalog refresh, reconnect, local
removal, and structural redaction. US API-key and both EU methods still need
account-bound proof. Live token expiry/refresh, remote OAuth revocation, and
native CLI automatic capability delivery remain unqualified; public metadata
and fixtures do not establish those results.

Unikraft follows the same key/access wizard. Setup asks only for the API token;
the default metro is an optional select under Advanced, and each action can name
another published metro. [Unikraft browser setup](../../tests/e2e/unikraft-connector.spec.ts)
checks the catalog, password field, access controls and the advanced metro. It
does not submit a token or qualify a real provider account. See
[Unikraft](../../doc/connections/UNIKRAFT.md) for token authority and metros.

### `mcp-link`

Automated: AppsConnect's generic MCP cases cover probe-driven auth, private or
unreachable endpoints, preregistered clients, secret-backed headers, and unsafe
authorization URLs. These are component/API mocks, not remote provider proof.

[Catalog publication](../../server/src/__tests__/tool-catalog-publication.test.ts)
uses PostgreSQL and a controlled MCP response to check bounded writes, repeated
page entries, preserved action choices, rollback, and concurrent publication.
It does not verify a live provider's discovery contract.

Manual: connect a known test MCP URL through the link flow, verify its saved
endpoint and a read-only action, then repeat with a bad URL and wrong credential.
The error should explain the next action and preserve non-secret setup context.
Test no-auth and authenticated endpoints separately; never infer one from the other.

### `task-request`

Automated: [interaction card](../../ui/src/components/IssueThreadInteractionCard.test.tsx)
checks addressed-user controls. AppsConnect tests cover page/dialog parity,
task-bound OAuth, popup handoff, and verifying a saved connection before closing.
Withdrawn requests render a terminal acknowledgement with no setup action; the
interaction-body test and narrow Storybook journey cover this recovery state.
The connection-intents browser suite above exercises fixture-backed continuation.

Manual: ask an agent to use an unavailable app, open its request as the named
user, and complete setup in the dialog. Verify the card settles, the exact task
resumes, and the agent returns a useful provider result. Repeat the page-host
fallback and denied OAuth path. As another user, confirm that merely seeing the
task does not grant the right to resolve the request.

### `resume-connection`

Automated: AppsConnect tests cover exact-draft resume, declined OAuth, reconnect
lookup failure/retry, response-lost creation, archived connection revival, and
saved account reuse. [App detail](../../ui/src/pages/apps/AppDetail.test.tsx) covers
the connection host. These tests do not complete a real provider login.

Manual: leave setup through its footer, reload Apps, choose Finish setup, and
confirm the same connection is resumed. Decline provider login and recover from
that checkpoint. Reconnect an expired disposable account and verify a permitted
action afterwards. Count connections before/after to catch accidental duplicates.

### `chat-channel`

Automated: [setup routing](../../ui/src/pages/apps/chat/ChatEndpointSetup.routing.test.tsx),
[saved setup state](../../ui/src/pages/apps/chat/ChatEndpointSetup.state.test.ts),
[email setup](../../ui/src/pages/apps/chat/EmailEndpointSetup.test.tsx), and
[identity confirmation](../../ui/src/pages/apps/chat/ChatIdentityConfirm.test.tsx)
cover shared UI logic with fixtures. Provider-specific live setup is not implied.

[Channel integration](../../server/src/__tests__/chat-channels.integration.test.ts)
also covers bounded Telegram subscription recovery at startup and after committed
configuration changes, saved retry deadlines, rollback, and parking pending
repair while an endpoint or connection is inactive. The provider responses are
fixtures. Settled maintenance leaves no discovery timer or database scans.

GitHub Cloud setup also covers an older empty-queue backoff, concurrent setup and
background leases, and retry after a Cloud error in the
[event poller regression](../../server/src/services/github-connection-events.test.ts).
Channel integration checks that active setup drains its signed ping through the
normal webhook handler; a forged ping still cannot verify the endpoint. These
fixtures do not establish live Cloud delivery. For live proof, start a disposable
App after an idle personal GitHub connection, complete installation, and confirm
that the same draft advances after authenticating the queued ping.

Manual: complete setup for one named provider, reload endpoint settings, link
the intended sender, and send a disposable message. Verify one task and a useful
reply in the originating conversation. Inspect an unlinked sender's denial and
the endpoint's pause behavior. Repeat independently for each provider at issue;
Slack setup does not qualify Discord, Telegram, GitHub, email, or iMessage.

## Gotchas

- For connecting an assistant to Paperclip itself, use [Assistant connections (MCP)](./assistant-connections.md). This recipe's MCP-link journey connects Paperclip to an external app server.
- Private endpoint rejection depends on deployment: owned loopback MCP servers
  are supported in local-trusted/private instances. Public authenticated
  deployments apply the private-network restriction.

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

### Documentation scope: App catalog and connection setup

Provider-specific authentication/revocation, credential-only accounts, and aggregator administrative variants still need their own detailed matrices.

Supabase and Vercel deployment connections (2026-10-22): Apps offers Supabase
browser sign-in, hosted MCP personal access token, and project-scoped Management
API methods, plus Vercel's team-scoped access token method. Supabase's optional
MCP project pin leaves project creation available when unset; the native method
requires a project and offers Edge Function deployment and selected configuration.
Vercel supports preview/production deployment, build settings, environment
variables and existing domain attachment. Personal/shared credential ownership,
action permissions, reconnect and removal use the regular setup flow. See
[Supabase](../../doc/connections/SUPABASE.md) and
[Vercel](../../doc/connections/vercel.md) for method boundaries and qualification.

For these native methods, continue past a successful connection test into an
actual native agent task: readiness, assigned-tool delivery, and task-card reuse
must all work. The 2026-10-23 walkthrough exposed and repaired omitted REST
admission at those boundaries. Verify a served deployment and provider settings,
not only the catalog action count. Vercel preview requires an existing deployment;
its provider makes the first deployment production, so an empty-project preview
must fail before submission and explain the explicit production prerequisite.
