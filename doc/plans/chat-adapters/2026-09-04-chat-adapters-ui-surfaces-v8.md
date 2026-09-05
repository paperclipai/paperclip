# Paperclip Chat Adapters UI Surfaces — v8

Date: 2026-09-04
Paperclip base: `8430bd897f01dd4b91e0970efffb71b97e5a2685`
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

## Screen inventory

| ID  | Group           | Surface       | Title                                 | Desktop   | Mobile   |
| --- | --------------- | ------------- | ------------------------------------- | --------- | -------- |
| 01  | Start           | Shared        | Connectors                            | 1280×800  | 375×812  |
| 02  | Start           | Shared        | Choose how to connect                 | 1280×800  | 375×812  |
| 03  | Start           | Shared        | Which agent do you want to chat with? | 1280×800  | 375×812  |
| 13  | Slack           | Setup         | Add Maya to Slack                     | 1280×800  | 375×812  |
| 42  | Slack           | Custom setup  | Create and install the Slack app      | 1280×800  | 375×1064 |
| 43  | Slack           | Custom setup  | Connect the Slack app                 | 1280×800  | 375×1176 |
| 41  | Slack           | Setup         | Try Maya in Slack                     | 1280×800  | 375×944  |
| 14  | Slack           | Settings      | Slack settings                        | 1280×984  | 375×1072 |
| 26  | Slack           | Access        | Slack access                          | 1280×880  | 375×920  |
| 27  | Slack           | Conversations | Slack conversations                   | 1280×800  | 375×916  |
| 28  | Slack           | Activity      | Slack activity                        | 1280×1200 | 375×1640 |
| 16  | GitHub          | Setup         | Create Maya in GitHub                 | 1280×800  | 375×952  |
| 45  | GitHub          | Setup         | Choose GitHub repositories            | 1280×800  | 375×1000 |
| 46  | GitHub          | Setup         | Try Maya in GitHub                    | 1280×800  | 375×1000 |
| 47  | GitHub          | Custom setup  | Connect an existing GitHub App        | 1280×960  | 375×1392 |
| 17  | GitHub          | Settings      | GitHub settings                       | 1280×816  | 375×896  |
| 30  | GitHub          | Access        | GitHub access                         | 1280×880  | 375×920  |
| 31  | GitHub          | Conversations | GitHub conversations                  | 1280×800  | 375×916  |
| 32  | GitHub          | Activity      | GitHub activity                       | 1280×1200 | 375×1640 |
| 19  | Microsoft Teams | Setup         | Create Maya for Microsoft Teams       | 1280×800  | 375×1080 |
| 49  | Microsoft Teams | Setup         | Install Maya in Microsoft Teams       | 1280×800  | 375×888  |
| 50  | Microsoft Teams | Setup         | Try Maya in Microsoft Teams           | 1280×800  | 375×1000 |
| 48  | Microsoft Teams | Custom setup  | Set up Microsoft manually             | 1280×1064 | 375×1496 |
| 20  | Microsoft Teams | Settings      | Microsoft Teams settings              | 1280×1064 | 375×1176 |
| 34  | Microsoft Teams | Access        | Microsoft Teams access                | 1280×880  | 375×920  |
| 35  | Microsoft Teams | Conversations | Microsoft Teams conversations         | 1280×800  | 375×916  |
| 36  | Microsoft Teams | Activity      | Microsoft Teams activity              | 1280×1200 | 375×1640 |
| 22  | Telegram        | Setup         | Create Maya in Telegram               | 1280×800  | 375×1128 |
| 51  | Telegram        | Setup         | Try Maya in Telegram                  | 1280×800  | 375×832  |
| 23  | Telegram        | Settings      | Telegram settings                     | 1280×984  | 375×1072 |
| 38  | Telegram        | Access        | Telegram access                       | 1280×880  | 375×920  |
| 39  | Telegram        | Conversations | Telegram conversations                | 1280×800  | 375×916  |
| 40  | Telegram        | Activity      | Telegram activity                     | 1280×1200 | 375×1640 |
| 11  | Paperclip       | Task          | Externally connected task             | 1280×800  | 375×812  |
| 12  | Paperclip       | Agent         | Agent Channels                        | 1280×800  | 375×812  |

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

### 13 · Create and install Maya in Slack

Purpose: Create the customer-owned Slack App that represents Maya.

1. The step rail is the only repeated setup context; the selected agent is not restated in the page body.
2. The page contains only the prepared-manifest handoff required for the customer-owned App.

Actions:

- **Open Slack app setup:** Opens Slack's official app-from-manifest URL with Paperclip's generated manifest encoded in the link.
- **Continue after installing:** Advances to the two credential fields after the operator installs the App in Slack.

Rationale: Bring-your-own Slack credentials are the required first-release path. A managed Add to Slack flow is an optional later convenience and cannot gate release.

### 42 · Create and install the Slack app

Purpose: Paperclip prepared a Slack App Manifest for Maya.

1. Every line is an action the operator must complete in Slack.
2. The manifest removes manual scope, event, callback, command, and interactivity configuration.
3. The page advances only after the operator confirms the app was installed.

Actions:

- **Open Slack app setup:** Opens Slack's official app-from-manifest URL with Paperclip's generated manifest encoded in the link.
- **Continue after installing:** Advances to the two credential fields after the operator has installed the new app in Slack.

Rationale: The custom path gives exact provider instructions without exposing Paperclip's automatic configuration.

### 43 · Connect the Slack app

Purpose: Copy two values from the Slack app settings.

1. The only help text tells the operator exactly where to find each required value.
2. Only the two unavoidable Slack credentials are requested.
3. Connecting verifies the values instead of showing a separate verification report.

Actions:

- **Connect Slack app:** Stores both values write-only and verifies the Slack bot identity and required scopes before continuing.
- **Back:** Returns to the Slack creation instructions without saving partially entered values.

Rationale: A customer-owned Slack App cannot return these values to Paperclip, so both fields are necessary.

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

### 16 · Create Maya in GitHub

Purpose: Create or update a dedicated customer-owned GitHub App.

1. Paperclip shows the exact webhook URL and generates a 32-byte webhook secret.
2. The secret is shown once for copying to GitHub and remains write-only afterward.
3. The operator returns only the App ID and private-key PEM to Paperclip.

Actions:

- **Generate webhook secret:** Creates and stores the secret, then exposes the one-time copy value.
- **Open GitHub:** Opens GitHub App registration so the operator can set the callback, permissions, and required events.
- **Connect and verify:** Authenticates with the App ID/private key and rejects missing permissions or events.

Rationale: The customer-owned credential path is complete without depending on an App Manifest exchange.

### 45 · Choose GitHub repositories

Purpose: Install Maya where people should be able to mention it.

1. The screen contains only GitHub's installation decisions.
2. Repository scope stays in GitHub's native approval UI.
3. One button begins the complete provider-owned installation step.

Actions:

- **Install in GitHub:** Opens GitHub's App installation page and returns the installation and selected repository IDs to Paperclip.

Rationale: There is no Paperclip form to duplicate GitHub's repository picker.

### 46 · Try Maya in GitHub

Purpose: Start one task in an installed repository.

1. The body is only the native GitHub test sequence.
2. The instructions explain that GitHub's existing issue or pull request is the task boundary.
3. There is one action: open GitHub and perform the test.

Actions:

- **Open GitHub:** Opens an installed repository while Paperclip waits for the first signed mention to complete setup.

Rationale: A real mention proves the App installation without a separate verification screen.

### 47 · Connect an existing GitHub App

Purpose: Update the App in GitHub, then provide its identity credentials.

1. The copy control provides the exact values the operator must paste into GitHub.
2. The instructions list every provider change required for an existing App.
3. Only App ID and private key return to Paperclip; the generated webhook secret is already stored.
4. Verification happens as part of Connect rather than on another screen.

Actions:

- **Copy Paperclip webhook settings:** Copies the endpoint URL and generated webhook secret needed in the existing GitHub App settings.
- **Connect and verify:** Stores the PEM file write-only, authenticates as the App, and verifies webhook, events, and least-privilege permissions.
- **Back:** Returns to the customer-owned GitHub App setup.

Rationale: New and existing Apps use the same minimal credential path and the same Paperclip-generated webhook secret.

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

Purpose: Register a customer-owned Entra App and Azure Bot with Microsoft.

1. Paperclip provides the exact public messaging endpoint.
2. The operator creates the single-tenant Entra App, client secret, Azure Bot, and Teams channel in Microsoft.
3. Paperclip asks only for Application ID, Directory/Tenant ID, and the client-secret value.

Actions:

- **Copy messaging endpoint:** Copies the public callback for the Azure Bot configuration.
- **Open Microsoft setup:** Opens the provider-owned registration flow.
- **Connect and verify:** Stores the client secret write-only and verifies the tenant and application identity.

Rationale: Bring-your-own credentials are sufficient to ship. A future CLI helper may automate these steps but is optional and cannot gate release.

### 49 · Install Maya in Microsoft Teams

Purpose: Open the Microsoft install page and add the app.

1. The install link replaces package download and upload on the normal path.
2. The body contains only the two actions performed in Microsoft Teams.
3. Tenant approval is handled by Microsoft's install experience, not another Paperclip choice.

Actions:

- **Install Maya in Teams:** Opens the install link returned by Microsoft. Tenant policy may route the same request to an administrator for approval.

Rationale: Microsoft's CLI returns an install link, so normal setup should use it directly.

### 50 · Try Maya in Microsoft Teams

Purpose: Start one task in a channel post.

1. The body is only the Teams channel test sequence.
2. The instructions teach the channel-post-and-replies task boundary.
3. There is one action: open Teams and perform the test.

Actions:

- **Open Microsoft Teams:** Opens Teams while Paperclip waits for the first authenticated mention and reply to complete setup.

Rationale: The final provider event is the verification; no installation report is shown first.

### 48 · Set up Microsoft manually

Purpose: Create the bot in Microsoft, then paste the three identity values.

1. The copy control provides the one Paperclip value required by Microsoft.
2. Every instruction is a portal operation the tenant administrator must perform.
3. The three fields are the minimum identity values Paperclip needs to send as the bot.
4. Connect verifies the identity and produces the same install step as the default flow.

Actions:

- **Copy Paperclip endpoint:** Copies the public messaging endpoint that must be entered on the Azure Bot resource.
- **Connect and create Teams app:** Stores the client secret write-only, verifies Microsoft bot authentication, and creates the installable Teams app and install link.
- **Back:** Returns to the guided one-command setup.

Rationale: The manual fallback is longer because Microsoft has no manifest callback equivalent; no optional Azure choices are exposed.

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
