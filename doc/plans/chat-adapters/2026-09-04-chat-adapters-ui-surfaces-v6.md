# Paperclip Chat Adapters UI Surfaces — v6

> Historical revision. The current review is [`2026-09-04-chat-adapters-ui-surfaces-v7.md`](./2026-09-04-chat-adapters-ui-surfaces-v7.md); v7 removes Overview and reduces Settings to destination reach.

Date: 2026-09-04
Paperclip base: `7b094724e65c04949706df638d497afb02c84b62`
Review viewer: [`index.html`](./index.html)
Wireframes: [`wireframes-v6/`](./wireframes-v6/)
Minimum-setup specification: [`2026-09-04-chat-adapters-minimum-setup-v6.md`](./2026-09-04-chat-adapters-minimum-setup-v6.md)

## Relevance rule

A setup screen may show only something the operator must click, copy, paste, upload, choose, or perform at the provider during that step. Do not repeat the selected agent, describe automatic Paperclip work, list capabilities, or show successful checks. Errors and unmet prerequisites appear only when they occur.

## Current setup inventory

- Slack: Add to Slack and a three-step customer-owned-App fallback converge on one test screen.
- GitHub: App Manifest creation, repository installation, and test; existing App is an advanced fallback.
- Microsoft Teams: one guided command, one install link, and test; manual Microsoft registration is an advanced fallback.
- Telegram: BotFather token and one private-message test.
- Capabilities and health remain on Overview and the interaction walkthroughs, never in setup.

## Inventory

| ID  | Group           | Surface                  | Title                                  | Desktop   | Mobile   |
| --- | --------------- | ------------------------ | -------------------------------------- | --------- | -------- |
| 01  | Start           | Shared                   | Connectors                             | 1280×800  | 375×812  |
| 02  | Start           | Shared                   | Choose how to connect                  | 1280×800  | 375×812  |
| 03  | Start           | Shared                   | Which agent do you want to chat with?  | 1280×800  | 375×812  |
| 13  | Slack           | Setup                    | Add Maya to Slack                      | 1280×800  | 375×812  |
| 42  | Slack           | Custom setup             | Create and install the Slack app       | 1280×800  | 375×1064 |
| 43  | Slack           | Custom setup             | Connect the Slack app                  | 1280×800  | 375×1176 |
| 41  | Slack           | Setup                    | Try Maya in Slack                      | 1280×800  | 375×944  |
| 25  | Slack           | Overview                 | Slack overview                         | 1280×1472 | 375×1928 |
| 14  | Slack           | Settings                 | Slack settings                         | 1280×1250 | 375×1676 |
| 26  | Slack           | Access                   | Slack access                           | 1280×1256 | 375×1592 |
| 27  | Slack           | Conversations            | Slack conversations                    | 1280×1160 | 375×1600 |
| 28  | Slack           | Activity                 | Slack activity                         | 1280×1200 | 375×1640 |
| 15  | Slack           | Conversation walkthrough | How Slack conversations work           | 1280×960  | 375×1320 |
| 16  | GitHub          | Setup                    | Create Maya in GitHub                  | 1280×800  | 375×952  |
| 45  | GitHub          | Setup                    | Choose GitHub repositories             | 1280×800  | 375×1000 |
| 46  | GitHub          | Setup                    | Try Maya in GitHub                     | 1280×800  | 375×1000 |
| 47  | GitHub          | Custom setup             | Connect an existing GitHub App         | 1280×960  | 375×1392 |
| 29  | GitHub          | Overview                 | GitHub overview                        | 1280×1472 | 375×1928 |
| 17  | GitHub          | Settings                 | GitHub settings                        | 1280×1178 | 375×1564 |
| 30  | GitHub          | Access                   | GitHub access                          | 1280×1256 | 375×1592 |
| 31  | GitHub          | Conversations            | GitHub conversations                   | 1280×1160 | 375×1600 |
| 32  | GitHub          | Activity                 | GitHub activity                        | 1280×1200 | 375×1640 |
| 18  | GitHub          | Conversation walkthrough | How GitHub conversations work          | 1280×960  | 375×1320 |
| 19  | Microsoft Teams | Setup                    | Create Maya for Microsoft Teams        | 1280×800  | 375×1080 |
| 49  | Microsoft Teams | Setup                    | Install Maya in Microsoft Teams        | 1280×800  | 375×888  |
| 50  | Microsoft Teams | Setup                    | Try Maya in Microsoft Teams            | 1280×800  | 375×1000 |
| 48  | Microsoft Teams | Custom setup             | Set up Microsoft manually              | 1280×1064 | 375×1496 |
| 33  | Microsoft Teams | Overview                 | Microsoft Teams overview               | 1280×1472 | 375×1928 |
| 20  | Microsoft Teams | Settings                 | Microsoft Teams settings               | 1280×1322 | 375×1788 |
| 34  | Microsoft Teams | Access                   | Microsoft Teams access                 | 1280×1256 | 375×1592 |
| 35  | Microsoft Teams | Conversations            | Microsoft Teams conversations          | 1280×1160 | 375×1600 |
| 36  | Microsoft Teams | Activity                 | Microsoft Teams activity               | 1280×1200 | 375×1640 |
| 21  | Microsoft Teams | Conversation walkthrough | How Microsoft Teams conversations work | 1280×960  | 375×1320 |
| 22  | Telegram        | Setup                    | Create Maya in Telegram                | 1280×800  | 375×1128 |
| 51  | Telegram        | Setup                    | Try Maya in Telegram                   | 1280×800  | 375×832  |
| 37  | Telegram        | Overview                 | Telegram overview                      | 1280×1472 | 375×1928 |
| 23  | Telegram        | Settings                 | Telegram settings                      | 1280×1322 | 375×1788 |
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

### 25 · Slack overview

Purpose: Identity, health, capabilities, and lifecycle.

1. The endpoint keeps one Paperclip agent and one provider-native bot identity together.
2. Installation and delivery health are summarized before any configuration detail.
3. Every safe capability available to this provider is included automatically; this is status, not a set of switches.
4. Test, pause, reconnect, and remove remain ordinary connector lifecycle actions.

Rationale: Overview remains provider-specific and outside onboarding.

### 14 · Slack settings

Purpose: Scope, task boundaries, and necessary provider operations.

1. Reach is an operator choice and is always bounded by the Slack installation and actual bot membership.
2. Root mention, native thread creation, subscribed replies, and DM task boundaries are explicit.
3. Delivery is read-only status; only credential rotation and installation repair require operator action here. Slack capabilities are reported on Overview and demonstrated in the walkthrough, never configured here.

Rationale: Settings remains provider-specific and outside onboarding.

### 26 · Slack access

Purpose: Identity links, sponsored guests, and effective authority.

1. The endpoint sponsor supplies the maximum authority available to unlinked external people.
2. Linked provider identities act as their current Paperclip users and retain ordinary permission checks.
3. Unlinked people use the restricted sponsored-guest profile and cannot perform governance actions.
4. Provider identity and scope details make effective authority explainable and auditable.

Rationale: Access remains provider-specific and outside onboarding.

### 27 · Slack conversations

Purpose: Native conversation-to-Paperclip task bindings.

1. Each row names the provider-native conversation boundary and its single Paperclip issue.
2. Participants, assigned agent, state, and last activity make live bindings scannable.
3. Open in provider and Open task take an operator to either side of the binding.
4. Detach preserves history and publication records; a later activation creates or claims a new binding.

Rationale: Conversations remains provider-specific and outside onboarding.

### 28 · Slack activity

Purpose: Provider health, deliveries, publications, and retries.

1. Provider, credential, callback, and deployment-selected delivery health are summarized in one operational section.
2. Inbound deliveries, callbacks, and outbound publications share a durable chronological ledger.
3. Operators can inspect redacted errors and replay only safe, authorized failed deliveries.
4. Rate limits, permission drift, uninstall or revocation, and provider-specific diagnostics stay visible.

Rationale: Activity remains provider-specific and outside onboarding.

### 15 · How Slack conversations work

Purpose: The provider-native interaction and fallback model.

1. Ari starts in a Slack channel with a root @maya mention; unrelated root messages do not start work.
2. Maya acknowledges inside a Slack thread, making the thread—not the channel—the visible conversation boundary.
3. Paperclip creates exactly one assigned issue and shows its Slack source, external participant, and publication state.
4. Ari continues by replying in the same thread without another mention; files and actions remain in that context.
5. Maya's safe progress and final answer publish in the thread; failures offer retry or a Paperclip link.

Rationale: Capabilities are demonstrated here, not configured during setup.

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

### 29 · GitHub overview

Purpose: Identity, health, capabilities, and lifecycle.

1. The endpoint keeps one Paperclip agent and one provider-native bot identity together.
2. Installation and delivery health are summarized before any configuration detail.
3. Every safe capability available to this provider is included automatically; this is status, not a set of switches.
4. Test, pause, reconnect, and remove remain ordinary connector lifecycle actions.

Rationale: Overview remains provider-specific and outside onboarding.

### 17 · GitHub settings

Purpose: Scope, task boundaries, and necessary provider operations.

1. Repository and conversation-surface reach are the only content-scope choices.
2. Existing GitHub objects supply the issue boundary; optional non-mention activation remains an explicit workflow choice.
3. Host, private-key rotation, and installation drift are operational settings. GitHub response capabilities are reported on Overview and demonstrated in the walkthrough, never configured here.

Rationale: Settings remains provider-specific and outside onboarding.

### 30 · GitHub access

Purpose: Identity links, sponsored guests, and effective authority.

1. The endpoint sponsor supplies the maximum authority available to unlinked external people.
2. Linked provider identities act as their current Paperclip users and retain ordinary permission checks.
3. Unlinked people use the restricted sponsored-guest profile and cannot perform governance actions.
4. Provider identity and scope details make effective authority explainable and auditable.

Rationale: Access remains provider-specific and outside onboarding.

### 31 · GitHub conversations

Purpose: Native conversation-to-Paperclip task bindings.

1. Each row names the provider-native conversation boundary and its single Paperclip issue.
2. Participants, assigned agent, state, and last activity make live bindings scannable.
3. Open in provider and Open task take an operator to either side of the binding.
4. Detach preserves history and publication records; a later activation creates or claims a new binding.

Rationale: Conversations remains provider-specific and outside onboarding.

### 32 · GitHub activity

Purpose: Provider health, deliveries, publications, and retries.

1. Provider, credential, callback, and deployment-selected delivery health are summarized in one operational section.
2. Inbound deliveries, callbacks, and outbound publications share a durable chronological ledger.
3. Operators can inspect redacted errors and replay only safe, authorized failed deliveries.
4. Rate limits, permission drift, uninstall or revocation, and provider-specific diagnostics stay visible.

Rationale: Activity remains provider-specific and outside onboarding.

### 18 · How GitHub conversations work

Purpose: The provider-native interaction and fallback model.

1. Ari mentions the bot in an existing GitHub issue, PR conversation, or inline review thread.
2. Maya acknowledges with a reaction and one GitHub-Flavored Markdown comment rather than opening another thread.
3. Paperclip binds that exact GitHub object or review thread to one assigned issue; PR conversation and inline review stay distinct.
4. Later comments continue the same issue, while bot-authored comments and duplicate deliveries are ignored.
5. Progress edits the existing comment; files and governed actions use authenticated Paperclip links.

Rationale: Capabilities are demonstrated here, not configured during setup.

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

### 33 · Microsoft Teams overview

Purpose: Identity, health, capabilities, and lifecycle.

1. The endpoint keeps one Paperclip agent and one provider-native bot identity together.
2. Installation and delivery health are summarized before any configuration detail.
3. Every safe capability available to this provider is included automatically; this is status, not a set of switches.
4. Test, pause, reconnect, and remove remain ordinary connector lifecycle actions.

Rationale: Overview remains provider-specific and outside onboarding.

### 20 · Microsoft Teams settings

Purpose: Scope, task boundaries, and necessary provider operations.

1. Tenant, installed team/channel, personal, and group-chat reach are explicit scope choices.
2. Channel threads and linear-conversation active tasks are different, visible issue boundaries.
3. Bot identity, RSC, Graph consent, and installation drift are the only provider-level operations. Teams capabilities are reported on Overview and demonstrated in the walkthrough, never configured here.

Rationale: Settings remains provider-specific and outside onboarding.

### 34 · Microsoft Teams access

Purpose: Identity links, sponsored guests, and effective authority.

1. The endpoint sponsor supplies the maximum authority available to unlinked external people.
2. Linked provider identities act as their current Paperclip users and retain ordinary permission checks.
3. Unlinked people use the restricted sponsored-guest profile and cannot perform governance actions.
4. Provider identity and scope details make effective authority explainable and auditable.

Rationale: Access remains provider-specific and outside onboarding.

### 35 · Microsoft Teams conversations

Purpose: Native conversation-to-Paperclip task bindings.

1. Each row names the provider-native conversation boundary and its single Paperclip issue.
2. Participants, assigned agent, state, and last activity make live bindings scannable.
3. Open in provider and Open task take an operator to either side of the binding.
4. Detach preserves history and publication records; a later activation creates or claims a new binding.

Rationale: Conversations remains provider-specific and outside onboarding.

### 36 · Microsoft Teams activity

Purpose: Provider health, deliveries, publications, and retries.

1. Provider, credential, callback, and deployment-selected delivery health are summarized in one operational section.
2. Inbound deliveries, callbacks, and outbound publications share a durable chronological ledger.
3. Operators can inspect redacted errors and replay only safe, authorized failed deliveries.
4. Rate limits, permission drift, uninstall or revocation, and provider-specific diagnostics stay visible.

Rationale: Activity remains provider-specific and outside onboarding.

### 21 · How Microsoft Teams conversations work

Purpose: The provider-native interaction and fallback model.

1. Ari mentions Maya in a new Teams channel post; that post and its replies are the native thread.
2. Maya acknowledges under the post. If the installed permissions cannot deliver unmentioned replies, the bot says to mention Maya again.
3. Paperclip creates one assigned issue and records tenant, team/channel, thread, and external participant attribution.
4. Replies, files, and Adaptive Card or task-module actions continue only when current Teams delivery and Paperclip permissions allow.
5. DMs may stream natively; channel and group output buffers or edits, with targeted-message, DM, or text-link fallback.

Rationale: Capabilities are demonstrated here, not configured during setup.

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

### 37 · Telegram overview

Purpose: Identity, health, capabilities, and lifecycle.

1. The endpoint keeps one Paperclip agent and one provider-native bot identity together.
2. Installation and delivery health are summarized before any configuration detail.
3. Every safe capability available to this provider is included automatically; this is status, not a set of switches.
4. Test, pause, reconnect, and remove remain ordinary connector lifecycle actions.

Rationale: Overview remains provider-specific and outside onboarding.

### 23 · Telegram settings

Purpose: Scope, task boundaries, and necessary provider operations.

1. Chat, topic, DM, and optional user reach are real scope choices.
2. DM/group active tasks and forum-topic bindings make Telegram's non-Slack boundaries explicit.
3. Delivery is read-only status; privacy mode and token rotation are the only provider operations exposed here. Telegram capabilities are reported on Overview and demonstrated in the walkthrough, never configured here.

Rationale: Settings remains provider-specific and outside onboarding.

### 38 · Telegram access

Purpose: Identity links, sponsored guests, and effective authority.

1. The endpoint sponsor supplies the maximum authority available to unlinked external people.
2. Linked provider identities act as their current Paperclip users and retain ordinary permission checks.
3. Unlinked people use the restricted sponsored-guest profile and cannot perform governance actions.
4. Provider identity and scope details make effective authority explainable and auditable.

Rationale: Access remains provider-specific and outside onboarding.

### 39 · Telegram conversations

Purpose: Native conversation-to-Paperclip task bindings.

1. Each row names the provider-native conversation boundary and its single Paperclip issue.
2. Participants, assigned agent, state, and last activity make live bindings scannable.
3. Open in provider and Open task take an operator to either side of the binding.
4. Detach preserves history and publication records; a later activation creates or claims a new binding.

Rationale: Conversations remains provider-specific and outside onboarding.

### 40 · Telegram activity

Purpose: Provider health, deliveries, publications, and retries.

1. Provider, credential, callback, and deployment-selected delivery health are summarized in one operational section.
2. Inbound deliveries, callbacks, and outbound publications share a durable chronological ledger.
3. Operators can inspect redacted errors and replay only safe, authorized failed deliveries.
4. Rate limits, permission drift, uninstall or revocation, and provider-specific diagnostics stay visible.

Rationale: Activity remains provider-specific and outside onboarding.

### 24 · How Telegram conversations work

Purpose: The provider-native interaction and fallback model.

1. In a DM, Ari's first message creates the active issue; New task or /new deliberately starts another.
2. In a privacy-on group, @maya starts work and replying to Maya continues; unrelated group traffic is not consumed.
3. A forum topic can bind one issue through message_thread_id when the bot is present and allowed.
4. Paperclip shows the active issue and makes the linear-chat boundary explicit instead of implying a Slack-style native thread.
5. Maya uses throttled post/edit and inline buttons; unsupported or governed actions return text or DM with a Paperclip link.

Rationale: Capabilities are demonstrated here, not configured during setup.

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
