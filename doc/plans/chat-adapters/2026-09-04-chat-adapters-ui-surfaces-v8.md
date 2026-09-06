# Paperclip Chat Adapters UI Surfaces — v8

Date: 2026-09-04
Original planning base: `d593463ab6394cd356bf27448ea28bad8cccf4ec`; release qualification records the exact tested revision separately.
Review viewer: [`index.html`](./index.html)
Wireframes: [`wireframes-v8/`](./wireframes-v8/)

## Permission model

- **Provider availability:** Slack, Teams, and Telegram decide where the bot is installed or invited. GitHub decides which repositories belong to the App installation.
- **Paperclip enablement:** Paperclip responds only in provider resources that a Paperclip administrator has enabled for this connection. Invitation or installation alone is not permission to create a task.
- **Effective reach:** A message is eligible only when the provider delivers it, its resource is enabled in Paperclip, the connection is active, and the sender has authority for the requested action.
- **Safe default:** The destination used for the successful setup test becomes the first enabled resource. Resources discovered later start disabled.

## Access tab

**Settings answers where the bot may work. Access answers who an external sender represents and what Paperclip authority applies.** A linked external identity acts as its mapped Paperclip user and is checked against current permissions on every action. An unlinked identity may be allowed under the fixed restricted profile: it can converse within enabled resources and attach safe files, but it cannot approve, change budgets, hire, manage permissions or connections, or reassign agents. The connection owner remains an internal audit and authority ceiling; it is not ordinary UI configuration.

## Conversations tab

Each provider has one plain list. Every row contains the external conversation, Paperclip task, current state, an Open-provider link, and Open task. There is no separate binding-management section or conversation-boundary explainer. If provider access disappears, the row becomes unavailable while its history remains inspectable.

The former "How conversations work" screens are removed. Provider-native activation and reply behavior remains implementation documentation, not a standalone product page.

## Five-provider implementation addendum — 2026-09-06

Discord now uses the same product shell even though the v8 generated wireframe inventory below predates that implementation. Its current UI contract is:

- **Setup:** enter a customer-owned Application ID, Server ID, and write-only bot token; inspect the server-pinned `bot`-scope install URL; connect; then enable and test one channel. No webhook URL, interactions key, slash command, managed provisioning, or delivery-mode choice appears.
- **Settings:** show provider identity and only the plausible direct-message reach switch. Provider capabilities are automatic.
- **Access:** list Discord text channels available to the installed bot, with Paperclip enablement as an independent narrower allowlist, plus linked numeric Discord-user identities and the unlinked-participation policy.
- **Conversations:** show the Discord thread or DM generation, Paperclip task, current state, **Open Discord**, and **Open task**. There are no detach or rebinding controls.
- **Activity:** show Gateway/runtime health, durable deliveries/publications, redacted provider failures, and contextual reconnect/rotation actions.

The linked v8 SVGs remain a four-provider visual-design artifact; they are not evidence that Discord is absent from the product or that Discord has passed live qualification. The live browser runbook and dated qualification result are the current five-provider acceptance sources.

## Screen inventory

| ID | Group | Surface | Title | Desktop | Mobile |
|---|---|---|---|---|---|
| 01 | Start | Shared | Connectors | 1280×800 | 375×812 |
| 02 | Start | Shared | Choose how to connect | 1280×800 | 375×812 |
| 03 | Start | Shared | Which agent do you want to chat with? | 1280×800 | 375×812 |
| 13 | Slack | Setup | Connect a Slack app | 1280×800 | 375×812 |
| 41 | Slack | Setup | Try Maya in Slack | 1280×800 | 375×944 |
| 14 | Slack | Settings | Slack settings | 1280×984 | 375×1072 |
| 26 | Slack | Access | Slack access | 1280×880 | 375×920 |
| 27 | Slack | Conversations | Slack conversations | 1280×800 | 375×916 |
| 28 | Slack | Activity | Slack activity | 1280×1200 | 375×1640 |
| 16 | GitHub | Setup | Create or connect a GitHub App | 1280×920 | 375×1312 |
| 46 | GitHub | Setup | Try Maya in GitHub | 1280×800 | 375×812 |
| 17 | GitHub | Settings | GitHub settings | 1280×816 | 375×896 |
| 30 | GitHub | Access | GitHub access | 1280×880 | 375×920 |
| 31 | GitHub | Conversations | GitHub conversations | 1280×800 | 375×916 |
| 32 | GitHub | Activity | GitHub activity | 1280×1200 | 375×1640 |
| 19 | Microsoft Teams | Setup | Create Maya for Microsoft Teams | 1280×800 | 375×1080 |
| 49 | Microsoft Teams | Setup | Install Maya in Microsoft Teams | 1280×800 | 375×888 |
| 50 | Microsoft Teams | Setup | Try Maya in Microsoft Teams | 1280×800 | 375×1000 |
| 48 | Microsoft Teams | Setup | Microsoft provider setup details | 1280×1064 | 375×1496 |
| 20 | Microsoft Teams | Settings | Microsoft Teams settings | 1280×1064 | 375×1176 |
| 34 | Microsoft Teams | Access | Microsoft Teams access | 1280×880 | 375×920 |
| 35 | Microsoft Teams | Conversations | Microsoft Teams conversations | 1280×800 | 375×916 |
| 36 | Microsoft Teams | Activity | Microsoft Teams activity | 1280×1200 | 375×1640 |
| 22 | Telegram | Setup | Create Maya in Telegram | 1280×800 | 375×1128 |
| 51 | Telegram | Setup | Try Maya in Telegram | 1280×800 | 375×832 |
| 23 | Telegram | Settings | Telegram settings | 1280×984 | 375×1072 |
| 38 | Telegram | Access | Telegram access | 1280×880 | 375×920 |
| 39 | Telegram | Conversations | Telegram conversations | 1280×800 | 375×916 |
| 40 | Telegram | Activity | Telegram activity | 1280×1200 | 375×1640 |
| 11 | Paperclip | Task | Externally connected task | 1280×800 | 375×812 |
| 12 | Paperclip | Agent | Agent Channels | 1280×800 | 375×812 |

## Annotation and action notes

### 01 · Connectors

Purpose: Connect tools and places where people talk to agents.

1. The existing Apps catalog remains the entry point.
2. Filters separate chat and tool methods.
3. Each connector row has one Connect action.
4. Connection state remains visible in the catalog.

Rationale: The current Connectors surface remains canonical.

### 02 · Choose how to connect

Purpose: Shown for every connector that supports both chat and tool methods.

1. The existing connection wizard shell and selected provider are reused.
2. Chat with an agent is the incoming-conversation path.
3. Use this connection as an agent tool is the outbound tool/credential path.
4. Single-purpose providers skip the choice.

Rationale: The registry drives the same direction choice for every dual-surface connector.

### 03 · Which agent do you want to chat with?

Purpose: Choose the one agent represented by this connection.

1. The existing agent selector is reused.
2. Only active agents can be selected.
3. One selection is required.
4. Continue begins provider setup.

Rationale: This is the only shared Paperclip-specific setup decision.

### 13 · Connect a Slack app

Purpose: Bring your own Slack app using Paperclip's prepared manifest.

1. The prepared manifest and exact provider locations make the customer-owned App the complete required path.
2. Only the Bot User OAuth Token and Signing Secret are entered, and both remain write-only.
3. Managed Add to Slack is not shipped; a later convenience cannot gate this path or release.

Actions:

- **Connect Slack app:** Stores the two write-only credentials and verifies the Slack bot identity and required scopes.
- **Open Slack app settings:** Opens Slack's app-management page where the operator creates and installs the customer-owned App.

Rationale: Bring-your-own credentials are the complete shipped path; no managed installation is required or currently shown.

### 41 · Try Maya in Slack

Purpose: Start one task and reply to it once.

1. The body is only the three actions needed to test the real Slack interaction.
2. The instructions teach the root-mention-to-thread Paperclip task boundary.
3. There is one action: open Slack and perform the test.

Actions:

- **Open Slack:** Opens the installed workspace while Paperclip waits for the root mention and thread reply to complete setup.

Rationale: Installation health and automatic verification do not belong on an instruction screen.

### 14 · Slack settings

Purpose: Enable the Slack channels where Maya may create and continue tasks.

1. Only provider-available destinations appear here.
2. Each toggle is Paperclip's independent allow or deny decision.
3. The provider action changes availability; newly discovered destinations remain disabled.
4. Private-conversation reach is an explicit Paperclip choice.

Rationale: Provider membership is the ceiling; Paperclip enablement is the narrower enforcement boundary.

### 26 · Slack access

Purpose: Decide how people are identified when they message Maya.

1. The only guest-policy choice is whether unlinked people may participate.
2. The restricted profile permits task conversation but never Paperclip governance.
3. Linked accounts map a stable Slack workspace ID + user ID to a Paperclip user and can be revoked.

Rationale: Settings controls where the bot works; Access controls who external people represent and which authority model applies.

### 27 · Slack conversations

Purpose: Conversations created through this connection.

1. The active row pairs one Slack conversation with its task, state, Open Slack, and Open task links.
2. The waiting row keeps the same compact fields and actions.
3. The completed row remains available as history with the same two links.

Rationale: Conversations is a plain cross-linking list, not a binding-management surface.

### 28 · Slack activity

Purpose: Health, deliveries, publications, and repair actions.

1. Provider, credential, callback, and deployment-selected delivery health are summarized in one operational section.
2. Inbound deliveries, callbacks, and outbound publications share a durable chronological ledger.
3. Operators can inspect redacted errors and replay only safe, authorized failed deliveries.
4. Rate limits, permission drift, uninstall or revocation, and provider-specific diagnostics stay visible.

Rationale: Diagnostics and conditional repairs live here instead of Settings.

### 16 · Create or connect a GitHub App

Purpose: Bring your own dedicated GitHub App and verify it with Paperclip.

1. The customer-owned App path is the complete shipped setup; no managed App Manifest exchange is required.
2. Paperclip generates the webhook secret and never returns it from normal endpoint reads.
3. Grant Metadata read, Issues and Pull requests read/write, plus Issue comment and Pull request review comment events; installation lifecycle events are automatic.
4. GitHub installation scope and Paperclip repository enablement remain independent reach controls.

Actions:

- **Generate webhook secret:** Creates and stores the webhook secret, then exposes its one-time copy value.
- **Open new GitHub App form:** Opens GitHub App registration; GitHub remains the authority for App ownership and repository installation.
- **Connect and verify:** Authenticates with the App ID and private key, verifies the immutable App identity, required permissions and events, installation, and signed webhook ping.

Rationale: Bring-your-own App credentials are sufficient to ship and preserve one provider bot identity per Paperclip agent.

### 46 · Try Maya in GitHub

Purpose: Start one task in an installed repository.

1. The test uses the real GitHub issue or pull-request conversation boundary.
2. The first addressed setup repository becomes enabled; other discovered repositories remain disabled.
3. One external conversation maps to one Paperclip task.

Actions:

- **Open GitHub:** Opens an installed repository while Paperclip waits for the first signed mention and follow-up to complete setup.

Rationale: A signed provider round trip proves installation, reach, identity, and conversation continuity.

### 17 · GitHub settings

Purpose: Enable the repositories where Maya may respond to mentions.

1. Only provider-available destinations appear here.
2. Each toggle is Paperclip's independent allow or deny decision.
3. The provider action changes availability; newly discovered destinations remain disabled.

Rationale: Provider membership is the ceiling; Paperclip enablement is the narrower enforcement boundary.

### 30 · GitHub access

Purpose: Decide how people are identified when they mention Maya.

1. The only guest-policy choice is whether unlinked people may participate.
2. The restricted profile permits task conversation but never Paperclip governance.
3. Linked accounts map a stable GitHub host + numeric user ID to a Paperclip user and can be revoked.

Rationale: Settings controls where the bot works; Access controls who external people represent and which authority model applies.

### 31 · GitHub conversations

Purpose: Conversations created through this connection.

1. The active row pairs one GitHub conversation with its task, state, Open GitHub, and Open task links.
2. The waiting row keeps the same compact fields and actions.
3. The completed row remains available as history with the same two links.

Rationale: Conversations is a plain cross-linking list, not a binding-management surface.

### 32 · GitHub activity

Purpose: Health, deliveries, publications, and repair actions.

1. Provider, credential, callback, and deployment-selected delivery health are summarized in one operational section.
2. Inbound deliveries, callbacks, and outbound publications share a durable chronological ledger.
3. Operators can inspect redacted errors and replay only safe, authorized failed deliveries.
4. Rate limits, permission drift, uninstall or revocation, and provider-specific diagnostics stay visible.

Rationale: Diagnostics and conditional repairs live here instead of Settings.

### 19 · Create Maya for Microsoft Teams

Purpose: Register a customer-owned Entra App and Azure Bot.

1. Paperclip provides the exact public messaging endpoint.
2. The operator creates the single-tenant Entra App, Azure Bot, and Teams app in Microsoft.
3. No provisioning helper is shipped or required for the customer-owned path.

Actions:

- **Copy messaging endpoint:** Copies the public callback for Azure Bot configuration.
- **Open Microsoft setup:** Opens Microsoft's provider-owned registration surfaces.
- **Connect and verify:** Stores the client secret write-only and verifies the tenant and application identity.

Rationale: Bring-your-own credentials are the required portable setup path.

### 49 · Install Maya in Microsoft Teams

Purpose: Publish or upload the customer-owned app, then add it in Teams.

1. Microsoft owns app creation, packaging, publication, approval, and installation.
2. Paperclip does not generate a complete Teams package or promise an install link.
3. Tenant approval remains in Microsoft's install experience.

Actions:

- **Open Teams Developer Portal:** Opens the provider-owned app surface; tenant policy may require administrator approval.

Rationale: Customer-owned registration is required; Microsoft owns the app artifact and installation.

### 50 · Try Maya in Microsoft Teams

Purpose: Start one task in a channel post.

1. The body is only the Teams channel test sequence.
2. The instructions teach the channel-post-and-replies task boundary.
3. There is one action: open Teams and perform the test.

Actions:

- **Open Microsoft Teams:** Opens Teams while Paperclip waits for the authenticated mention and reply.

Rationale: The final provider event is the verification.

### 48 · Microsoft provider setup details

Purpose: Create the customer-owned bot and app, then paste the three identity values.

1. The endpoint is the one Paperclip-specific value required by Microsoft.
2. Every instruction is a provider portal operation.
3. The three identity fields are the minimum credentials Paperclip needs.
4. Connect does not generate a Teams package or install link.

Actions:

- **Copy Paperclip endpoint:** Copies the public messaging endpoint for the Azure Bot resource.
- **Connect and verify:** Stores the client secret write-only and verifies Microsoft bot authentication.
- **Back:** Returns to the primary customer-owned credential setup.

Rationale: This is reference detail for the complete required customer-owned path.

### 20 · Microsoft Teams settings

Purpose: Enable the Teams channels where Maya may create and continue tasks.

1. Only provider-available destinations appear here.
2. Each toggle is Paperclip's independent allow or deny decision.
3. The provider action changes availability; newly discovered destinations remain disabled.
4. Private-conversation reach is an explicit Paperclip choice.

Rationale: Provider membership is the ceiling; Paperclip enablement is the narrower enforcement boundary.

### 34 · Microsoft Teams access

Purpose: Decide how people are identified when they message Maya.

1. The only guest-policy choice is whether unlinked people may participate.
2. The restricted profile permits task conversation but never Paperclip governance.
3. Linked accounts map a stable Microsoft tenant ID + Entra object ID to a Paperclip user and can be revoked.

Rationale: Settings controls where the bot works; Access controls who external people represent and which authority model applies.

### 35 · Microsoft Teams conversations

Purpose: Conversations created through this connection.

1. The active row pairs one Microsoft Teams conversation with its task, state, Open Teams, and Open task links.
2. The waiting row keeps the same compact fields and actions.
3. The completed row remains available as history with the same two links.

Rationale: Conversations is a plain cross-linking list, not a binding-management surface.

### 36 · Microsoft Teams activity

Purpose: Health, deliveries, publications, and repair actions.

1. Provider, credential, callback, and deployment-selected delivery health are summarized in one operational section.
2. Inbound deliveries, callbacks, and outbound publications share a durable chronological ledger.
3. Operators can inspect redacted errors and replay only safe, authorized failed deliveries.
4. Rate limits, permission drift, uninstall or revocation, and provider-specific diagnostics stay visible.

Rationale: Diagnostics and conditional repairs live here instead of Settings.

### 22 · Create Maya in Telegram

Purpose: Create the bot with BotFather and paste its token.

1. The page contains the exact three BotFather actions.
2. The bot token is Telegram's only unavoidable setup input.
3. The two buttons let the operator leave for BotFather and connect after returning.

Actions:

- **Open BotFather:** Opens Telegram's verified BotFather conversation so the operator can run /newbot.
- **Connect bot:** Stores the token write-only, verifies the bot with getMe, and continues to the test step.

Rationale: Webhook, polling, commands, and identity checks are automatic and therefore absent.

### 51 · Try Maya in Telegram

Purpose: Send the bot its first message.

1. The minimum proof is one private message; group and forum reach can be added after connection.
2. The body contains only the two Telegram actions required for the test.
3. There is one action: open the bot and send the message.

Actions:

- **Open Maya in Telegram:** Opens the bot's t.me link while Paperclip waits for the first verified private message to complete setup.

Rationale: A private chat is Telegram's shortest path from BotFather token to a working Paperclip conversation.

### 23 · Telegram settings

Purpose: Enable the Telegram chats and topics where Maya may create and continue tasks.

1. Only provider-available destinations appear here.
2. Each toggle is Paperclip's independent allow or deny decision.
3. The provider action changes availability; newly discovered destinations remain disabled.
4. Private-conversation reach is an explicit Paperclip choice.

Rationale: Provider membership is the ceiling; Paperclip enablement is the narrower enforcement boundary.

### 38 · Telegram access

Purpose: Decide how people are identified when they message Maya.

1. The only guest-policy choice is whether unlinked people may participate.
2. The restricted profile permits task conversation but never Paperclip governance.
3. Linked accounts map a stable Telegram bot ID + numeric user ID to a Paperclip user and can be revoked.

Rationale: Settings controls where the bot works; Access controls who external people represent and which authority model applies.

### 39 · Telegram conversations

Purpose: Conversations created through this connection.

1. The active row pairs one Telegram conversation with its task, state, Open Telegram, and Open task links.
2. The waiting row keeps the same compact fields and actions.
3. The completed row remains available as history with the same two links.

Rationale: Conversations is a plain cross-linking list, not a binding-management surface.

### 40 · Telegram activity

Purpose: Health, deliveries, publications, and repair actions.

1. Provider, credential, callback, and deployment-selected delivery health are summarized in one operational section.
2. Inbound deliveries, callbacks, and outbound publications share a durable chronological ledger.
3. Operators can inspect redacted errors and replay only safe, authorized failed deliveries.
4. Rate limits, permission drift, uninstall or revocation, and provider-specific diagnostics stay visible.

Rationale: Diagnostics and conditional repairs live here instead of Settings.

### 11 · Externally connected task

Purpose: A normal Paperclip task connected to its provider conversation.

1. The task shows its external source and provider link.
2. External actors remain attributed.
3. Eligible agent output shows publication status.
4. Board comments remain internal unless Send to channel is selected.

Rationale: The agent assignment stays fixed for the lifetime of the external task; a different agent requires a new connection.

### 12 · Agent Channels

Purpose: See every provider identity representing this agent.

1. Channel identities are summarized per provider.
2. Health and recent tasks remain visible.
3. Connections open in Connectors.
4. Connect a channel preselects this agent.

Rationale: Agent detail summarizes endpoints while Connectors manages them.
