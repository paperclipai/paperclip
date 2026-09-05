# Paperclip Chat Adapters UI Surfaces — v7

> Historical snapshot. The current permission, Access, and Conversations design is [v8](./2026-09-04-chat-adapters-ui-surfaces-v8.md), shown by [`index.html`](./index.html). Managed-install and helper-first concepts below are not shipped requirements.

Date: 2026-09-04
Paperclip base: `7b094724e65c04949706df638d497afb02c84b62`
Review viewer: [`index.html`](./index.html)
Wireframes: [`wireframes-v7/`](./wireframes-v7/)

## Product decision

Overview is removed. Activated connectors open on Settings and expose only four management tabs: Settings, Access, Conversations, and Activity. Settings contains only destination reach that a user can plausibly change.

- **Channel activation:** A root mention creates a provider-native thread and one Paperclip task on Slack and Teams. Replies in that thread continue the same task without another mention.
- **Existing provider thread:** The first mention inside an unbound Slack or Teams thread binds that existing thread to one new Paperclip task. Earlier messages are not imported automatically.
- **Direct messages:** One open task is active in a DM. A completed task stays closed; the next message starts a new task. New task or /new starts another task explicitly.
- **GitHub conversations:** A mention binds the addressed issue, pull-request conversation, or inline review thread to one Paperclip task.
- **Telegram conversations:** DMs and ordinary groups use one active task. A forum topic has one stable topic-to-task binding.
- **Delivery:** Paperclip chooses direct verified webhooks when reachable and the instance relay when private. This is deployment configuration, not an endpoint preference.
- **Credentials and drift:** Invalid credentials, revoked installs, missing membership, or permission drift appear in Activity with a reconnect or repair action. They are not ordinary settings.

## Settings inventory

- Slack: allowed channels and an Allow direct messages toggle.
- GitHub: allowed repositories only.
- Microsoft Teams: allowed channels, Allow direct messages, and Allow group chats.
- Telegram: allowed groups/topics and an Allow direct messages toggle.

## Screen inventory

| ID  | Group           | Surface                  | Title                                  | Desktop   | Mobile   |
| --- | --------------- | ------------------------ | -------------------------------------- | --------- | -------- |
| 01  | Start           | Shared                   | Connectors                             | 1280×800  | 375×812  |
| 02  | Start           | Shared                   | Choose how to connect                  | 1280×800  | 375×812  |
| 03  | Start           | Shared                   | Which agent do you want to chat with?  | 1280×800  | 375×812  |
| 13  | Slack           | Setup                    | Add Maya to Slack                      | 1280×800  | 375×812  |
| 42  | Slack           | Custom setup             | Create and install the Slack app       | 1280×800  | 375×1064 |
| 43  | Slack           | Custom setup             | Connect the Slack app                  | 1280×800  | 375×1176 |
| 41  | Slack           | Setup                    | Try Maya in Slack                      | 1280×800  | 375×944  |
| 14  | Slack           | Settings                 | Slack settings                         | 1280×800  | 375×936  |
| 26  | Slack           | Access                   | Slack access                           | 1280×1256 | 375×1592 |
| 27  | Slack           | Conversations            | Slack conversations                    | 1280×1160 | 375×1600 |
| 28  | Slack           | Activity                 | Slack activity                         | 1280×1200 | 375×1640 |
| 15  | Slack           | Conversation walkthrough | How Slack conversations work           | 1280×960  | 375×1320 |
| 16  | GitHub          | Setup                    | Create Maya in GitHub                  | 1280×800  | 375×952  |
| 45  | GitHub          | Setup                    | Choose GitHub repositories             | 1280×800  | 375×1000 |
| 46  | GitHub          | Setup                    | Try Maya in GitHub                     | 1280×800  | 375×1000 |
| 47  | GitHub          | Custom setup             | Connect an existing GitHub App         | 1280×960  | 375×1392 |
| 17  | GitHub          | Settings                 | GitHub settings                        | 1280×800  | 375×812  |
| 30  | GitHub          | Access                   | GitHub access                          | 1280×1256 | 375×1592 |
| 31  | GitHub          | Conversations            | GitHub conversations                   | 1280×1160 | 375×1600 |
| 32  | GitHub          | Activity                 | GitHub activity                        | 1280×1200 | 375×1640 |
| 18  | GitHub          | Conversation walkthrough | How GitHub conversations work          | 1280×960  | 375×1320 |
| 19  | Microsoft Teams | Setup                    | Create Maya for Microsoft Teams        | 1280×800  | 375×1080 |
| 49  | Microsoft Teams | Setup                    | Install Maya in Microsoft Teams        | 1280×800  | 375×888  |
| 50  | Microsoft Teams | Setup                    | Try Maya in Microsoft Teams            | 1280×800  | 375×1000 |
| 48  | Microsoft Teams | Custom setup             | Set up Microsoft manually              | 1280×1064 | 375×1496 |
| 20  | Microsoft Teams | Settings                 | Microsoft Teams settings               | 1280×800  | 375×968  |
| 34  | Microsoft Teams | Access                   | Microsoft Teams access                 | 1280×1256 | 375×1592 |
| 35  | Microsoft Teams | Conversations            | Microsoft Teams conversations          | 1280×1160 | 375×1600 |
| 36  | Microsoft Teams | Activity                 | Microsoft Teams activity               | 1280×1200 | 375×1640 |
| 21  | Microsoft Teams | Conversation walkthrough | How Microsoft Teams conversations work | 1280×960  | 375×1320 |
| 22  | Telegram        | Setup                    | Create Maya in Telegram                | 1280×800  | 375×1128 |
| 51  | Telegram        | Setup                    | Try Maya in Telegram                   | 1280×800  | 375×832  |
| 23  | Telegram        | Settings                 | Telegram settings                      | 1280×800  | 375×952  |
| 38  | Telegram        | Access                   | Telegram access                        | 1280×1256 | 375×1592 |
| 39  | Telegram        | Conversations            | Telegram conversations                 | 1280×1160 | 375×1600 |
| 40  | Telegram        | Activity                 | Telegram activity                      | 1280×1200 | 375×1640 |
| 24  | Telegram        | Conversation walkthrough | How Telegram conversations work        | 1280×960  | 375×1320 |
| 11  | Paperclip       | Task                     | Externally bound task                  | 1280×800  | 375×812  |
| 12  | Paperclip       | Agent                    | Agent Channels                         | 1280×800  | 375×812  |

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

### 13 · Add Maya to Slack

Purpose: Install Maya in your Slack workspace.

1. The step rail is the only repeated setup context; the selected agent is not restated in the page body.
2. The page contains only the installation action and the necessary customer-owned-App fallback.

Actions:

- **Add Maya to Slack:** Opens Slack's Add to Slack flow. The operator chooses a workspace and approves the installation; Slack then returns to the Try Maya step.
- **Set up a custom Slack app:** Opens the customer-owned Slack App instructions for self-hosted deployments or organizations that cannot use Add to Slack.

Rationale: Nothing else on this page requires operator attention.

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

Purpose: Choose where people can start conversations with Maya.

1. The connector starts on Settings; the read-only Overview tab is removed.
2. Workspace appears only as context on each allowed channel; allowed channels are the only Slack resource choice.
3. Direct messages are one explicit on/off choice.
4. Save persists only reach changes; thread boundaries, delivery, credentials, drift, and capabilities are absent.

Rationale: Only destination reach remains configurable; all conversation and delivery behavior is a product default.

### 26 · Slack access

Purpose: Identity links, sponsored guests, and effective authority.

1. The endpoint sponsor supplies the maximum authority available to unlinked external people.
2. Linked provider identities act as their current Paperclip users and retain ordinary permission checks.
3. Unlinked people use the restricted sponsored-guest profile and cannot perform governance actions.
4. Provider identity and scope details make effective authority explainable and auditable.

Rationale: Identity and authority remain independently manageable.

### 27 · Slack conversations

Purpose: Native conversation-to-Paperclip task bindings.

1. Each row names the provider-native conversation boundary and its single Paperclip issue.
2. Participants, assigned agent, state, and last activity make live bindings scannable.
3. Open in provider and Open task take an operator to either side of the binding.
4. Detach preserves history and publication records; a later activation creates or claims a new binding.

Rationale: Operators can inspect and detach durable bindings.

### 28 · Slack activity

Purpose: Health, deliveries, publications, and repair actions.

1. Provider, credential, callback, and deployment-selected delivery health are summarized in one operational section.
2. Inbound deliveries, callbacks, and outbound publications share a durable chronological ledger.
3. Operators can inspect redacted errors and replay only safe, authorized failed deliveries.
4. Rate limits, permission drift, uninstall or revocation, and provider-specific diagnostics stay visible.

Rationale: Diagnostics and conditional repairs live here instead of Settings.

### 15 · How Slack conversations work

Purpose: The fixed provider-native interaction and fallback model.

1. Ari starts in a Slack channel with a root @maya mention; unrelated root messages do not start work.
2. Maya acknowledges inside a Slack thread, making the thread—not the channel—the visible conversation boundary.
3. Paperclip creates exactly one assigned issue and shows its Slack source, external participant, and publication state.
4. Ari continues by replying in the same thread without another mention; files and actions remain in that context.
5. Maya's safe progress and final answer publish in the thread; failures offer retry or a Paperclip link.

Rationale: The walkthrough explains automatic behavior without turning it into configuration.

### 16 · Create Maya in GitHub

Purpose: Create a dedicated GitHub App from Paperclip's prepared manifest.

1. Only the two choices GitHub presents during App creation are described.
2. The normal action uses the GitHub App Manifest handoff; credentials never pass through the operator.
3. The existing-App branch remains available without cluttering the default path.

Actions:

- **Create in GitHub:** Posts Paperclip's App Manifest to GitHub. GitHub returns to Paperclip after creation, and Paperclip stores the returned App credentials.
- **Use an existing GitHub App:** Opens the advanced path for an App the organization already owns.

Rationale: The manifest already fixes permissions, events, and webhook configuration.

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
- **Back:** Returns to the credential-free App Manifest path.

Rationale: Existing Apps lack the manifest callback, so this advanced page contains the complete minimum manual configuration.

### 17 · GitHub settings

Purpose: Choose the repositories where people can mention Maya.

1. The connector starts on Settings; the read-only Overview tab is removed.
2. The account and App installation are fixed; repository reach is the only normal GitHub chat setting.
3. Save persists the repository allowlist; private-key or installation repair begins from Activity only when needed.

Rationale: Only destination reach remains configurable; all conversation and delivery behavior is a product default.

### 30 · GitHub access

Purpose: Identity links, sponsored guests, and effective authority.

1. The endpoint sponsor supplies the maximum authority available to unlinked external people.
2. Linked provider identities act as their current Paperclip users and retain ordinary permission checks.
3. Unlinked people use the restricted sponsored-guest profile and cannot perform governance actions.
4. Provider identity and scope details make effective authority explainable and auditable.

Rationale: Identity and authority remain independently manageable.

### 31 · GitHub conversations

Purpose: Native conversation-to-Paperclip task bindings.

1. Each row names the provider-native conversation boundary and its single Paperclip issue.
2. Participants, assigned agent, state, and last activity make live bindings scannable.
3. Open in provider and Open task take an operator to either side of the binding.
4. Detach preserves history and publication records; a later activation creates or claims a new binding.

Rationale: Operators can inspect and detach durable bindings.

### 32 · GitHub activity

Purpose: Health, deliveries, publications, and repair actions.

1. Provider, credential, callback, and deployment-selected delivery health are summarized in one operational section.
2. Inbound deliveries, callbacks, and outbound publications share a durable chronological ledger.
3. Operators can inspect redacted errors and replay only safe, authorized failed deliveries.
4. Rate limits, permission drift, uninstall or revocation, and provider-specific diagnostics stay visible.

Rationale: Diagnostics and conditional repairs live here instead of Settings.

### 18 · How GitHub conversations work

Purpose: The fixed provider-native interaction and fallback model.

1. Ari mentions the bot in an existing GitHub issue, PR conversation, or inline review thread.
2. Maya acknowledges with a reaction and one GitHub-Flavored Markdown comment rather than opening another thread.
3. Paperclip binds that exact GitHub object or review thread to one assigned issue; PR conversation and inline review stay distinct.
4. Later comments continue the same issue, while bot-authored comments and duplicate deliveries are ignored.
5. Progress edits the existing comment; files and governed actions use authenticated Paperclip links.

Rationale: The walkthrough explains automatic behavior without turning it into configuration.

### 19 · Create Maya for Microsoft Teams

Purpose: Run one command to register Maya with Microsoft.

1. The generated command is the only normal-path configuration artifact.
2. Both instructions are actions the operator performs locally or in Microsoft's login.
3. The manual path is available without exposing Azure choices on the default screen.

Actions:

- **Copy setup command:** Copies a one-time Paperclip command that invokes Microsoft's Teams Developer CLI, signs the operator in, creates the Teams App and bot registration, and sends the resulting identity to this setup draft.
- **Set up Microsoft manually:** Opens the Azure/Teams manual fallback for tenants that cannot run the guided command.

Rationale: The helper collapses Microsoft registration into one attended command while Microsoft remains the authority for sign-in and tenant policy.

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

Purpose: Choose where people can start conversations with Maya.

1. The connector starts on Settings; the read-only Overview tab is removed.
2. Tenant and bot identity are fixed; the tenant appears only as context on allowed Teams channels.
3. Personal and group chats are independent reach toggles.
4. Save persists only reach changes; post boundaries, consent, delivery, credentials, and drift are absent.

Rationale: Only destination reach remains configurable; all conversation and delivery behavior is a product default.

### 34 · Microsoft Teams access

Purpose: Identity links, sponsored guests, and effective authority.

1. The endpoint sponsor supplies the maximum authority available to unlinked external people.
2. Linked provider identities act as their current Paperclip users and retain ordinary permission checks.
3. Unlinked people use the restricted sponsored-guest profile and cannot perform governance actions.
4. Provider identity and scope details make effective authority explainable and auditable.

Rationale: Identity and authority remain independently manageable.

### 35 · Microsoft Teams conversations

Purpose: Native conversation-to-Paperclip task bindings.

1. Each row names the provider-native conversation boundary and its single Paperclip issue.
2. Participants, assigned agent, state, and last activity make live bindings scannable.
3. Open in provider and Open task take an operator to either side of the binding.
4. Detach preserves history and publication records; a later activation creates or claims a new binding.

Rationale: Operators can inspect and detach durable bindings.

### 36 · Microsoft Teams activity

Purpose: Health, deliveries, publications, and repair actions.

1. Provider, credential, callback, and deployment-selected delivery health are summarized in one operational section.
2. Inbound deliveries, callbacks, and outbound publications share a durable chronological ledger.
3. Operators can inspect redacted errors and replay only safe, authorized failed deliveries.
4. Rate limits, permission drift, uninstall or revocation, and provider-specific diagnostics stay visible.

Rationale: Diagnostics and conditional repairs live here instead of Settings.

### 21 · How Microsoft Teams conversations work

Purpose: The fixed provider-native interaction and fallback model.

1. Ari mentions Maya in a new Teams channel post; that post and its replies are the native thread.
2. Maya acknowledges under the post. If the installed permissions cannot deliver unmentioned replies, the bot says to mention Maya again.
3. Paperclip creates one assigned issue and records tenant, team/channel, thread, and external participant attribution.
4. Replies, files, and Adaptive Card or task-module actions continue only when current Teams delivery and Paperclip permissions allow.
5. DMs may stream natively; channel and group output buffers or edits, with targeted-message, DM, or text-link fallback.

Rationale: The walkthrough explains automatic behavior without turning it into configuration.

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

Purpose: Choose where people can start conversations with Maya.

1. The connector starts on Settings; the read-only Overview tab is removed.
2. Allowed groups and forum topics are the Telegram resource choice.
3. Direct messages are one explicit on/off choice.
4. Save persists only reach changes; task boundaries, privacy, delivery, token rotation, and health are absent.

Rationale: Only destination reach remains configurable; all conversation and delivery behavior is a product default.

### 38 · Telegram access

Purpose: Identity links, sponsored guests, and effective authority.

1. The endpoint sponsor supplies the maximum authority available to unlinked external people.
2. Linked provider identities act as their current Paperclip users and retain ordinary permission checks.
3. Unlinked people use the restricted sponsored-guest profile and cannot perform governance actions.
4. Provider identity and scope details make effective authority explainable and auditable.

Rationale: Identity and authority remain independently manageable.

### 39 · Telegram conversations

Purpose: Native conversation-to-Paperclip task bindings.

1. Each row names the provider-native conversation boundary and its single Paperclip issue.
2. Participants, assigned agent, state, and last activity make live bindings scannable.
3. Open in provider and Open task take an operator to either side of the binding.
4. Detach preserves history and publication records; a later activation creates or claims a new binding.

Rationale: Operators can inspect and detach durable bindings.

### 40 · Telegram activity

Purpose: Health, deliveries, publications, and repair actions.

1. Provider, credential, callback, and deployment-selected delivery health are summarized in one operational section.
2. Inbound deliveries, callbacks, and outbound publications share a durable chronological ledger.
3. Operators can inspect redacted errors and replay only safe, authorized failed deliveries.
4. Rate limits, permission drift, uninstall or revocation, and provider-specific diagnostics stay visible.

Rationale: Diagnostics and conditional repairs live here instead of Settings.

### 24 · How Telegram conversations work

Purpose: The fixed provider-native interaction and fallback model.

1. In a DM, Ari's first message creates the active issue; New task or /new deliberately starts another.
2. In a privacy-on group, @maya starts work and replying to Maya continues; unrelated group traffic is not consumed.
3. A forum topic can bind one issue through message_thread_id when the bot is present and allowed.
4. Paperclip shows the active issue and makes the linear-chat boundary explicit instead of implying a Slack-style native thread.
5. Maya uses throttled post/edit and inline buttons; unsupported or governed actions return text or DM with a Paperclip link.

Rationale: The walkthrough explains automatic behavior without turning it into configuration.

### 11 · Externally bound task

Purpose: A normal Paperclip task with explicit publication and detach controls.

1. The task shows its external source.
2. External actors remain attributed.
3. Publishing back to the provider is explicit for human comments.
4. The agent remains locked until detach.

Rationale: External work stays in the ordinary governed task experience.

### 12 · Agent Channels

Purpose: See every provider identity representing this agent.

1. Channel identities are summarized per provider.
2. Health and recent tasks remain visible.
3. Connections open in Connectors.
4. Connect a channel preselects this agent.

Rationale: Agent detail summarizes endpoints while Connectors manages them.
