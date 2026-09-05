# Paperclip Chat Adapters UI Surfaces — v5

Status: historical snapshot; current product flow is [`2026-09-04-chat-adapters-ui-surfaces-v8.md`](./2026-09-04-chat-adapters-ui-surfaces-v8.md). Managed-install and helper-first concepts below are not shipped requirements.
Date: 2026-09-04
Paperclip base: `7b094724e65c04949706df638d497afb02c84b62`
Review viewer: [`index.html`](./index.html)
Wireframes: [`wireframes-v5/`](./wireframes-v5/)
Setup audit: [`2026-09-04-chat-adapters-setup-audit-v5.md`](./2026-09-04-chat-adapters-setup-audit-v5.md)

## What changed

- The purpose choice now says **Use this connection as an agent tool** and applies to every provider that exposes both chat and tool connection surfaces.
- Agent selection is one-way. Setup shows the chosen agent as **Locked**; connecting another agent means creating another connection.
- Every provider setup is a persistent step-rail wizard. Each SVG represents one real phase, including the advanced custom/existing-app branches.
- Normal setup never asks for direct webhook, relay, Socket Mode, or polling. Paperclip chooses delivery from the instance deployment and reports it after the fact.
- Authenticated provider handoffs keep credentials invisible. Only customer-owned flows expose irreducible secrets: two for a custom Slack app, an App ID/private key/webhook secret for an existing GitHub App, Microsoft bot identity values for Teams, and the BotFather token for Telegram.
- Every button is documented below with the state change or external handoff behind it.
- Provider detail tabs remain complete. Capability inventories live on Overview and the native walkthroughs; feature toggles are absent from Settings.
- Red dashed marks and numbers are review annotations, not proposed UI.

## Inventory

| ID  | Group           | Surface                  | Title                                  | Desktop   | Mobile   |
| --- | --------------- | ------------------------ | -------------------------------------- | --------- | -------- |
| 01  | Start           | Shared                   | Connectors                             | 1280×800  | 375×812  |
| 02  | Start           | Shared                   | Choose how to connect                  | 1280×800  | 375×812  |
| 03  | Start           | Shared                   | Which agent do you want to chat with?  | 1280×800  | 375×812  |
| 13  | Slack           | Setup                    | Add Maya to Slack                      | 1280×1064 | 375×1608 |
| 41  | Slack           | Setup                    | Try Maya in Slack                      | 1280×1136 | 375×1720 |
| 42  | Slack           | Advanced setup           | Create a custom Slack app              | 1280×992  | 375×1552 |
| 43  | Slack           | Advanced setup           | Connect the custom Slack app           | 1280×1112 | 375×1640 |
| 44  | Slack           | Advanced setup           | Verify the custom Slack app            | 1280×920  | 375×1352 |
| 25  | Slack           | Overview                 | Slack overview                         | 1280×1472 | 375×1928 |
| 14  | Slack           | Settings                 | Slack settings                         | 1280×1250 | 375×1676 |
| 26  | Slack           | Access                   | Slack access                           | 1280×1256 | 375×1592 |
| 27  | Slack           | Conversations            | Slack conversations                    | 1280×1160 | 375×1600 |
| 28  | Slack           | Activity                 | Slack activity                         | 1280×1200 | 375×1640 |
| 15  | Slack           | Conversation walkthrough | How Slack conversations work           | 1280×960  | 375×1320 |
| 16  | GitHub          | Setup                    | Create Maya in GitHub                  | 1280×1064 | 375×1664 |
| 45  | GitHub          | Setup                    | Choose GitHub repositories             | 1280×1136 | 375×1776 |
| 46  | GitHub          | Setup                    | Try Maya in GitHub                     | 1280×1064 | 375×1648 |
| 47  | GitHub          | Advanced setup           | Connect an existing GitHub App         | 1280×1160 | 375×1632 |
| 29  | GitHub          | Overview                 | GitHub overview                        | 1280×1472 | 375×1928 |
| 17  | GitHub          | Settings                 | GitHub settings                        | 1280×1178 | 375×1564 |
| 30  | GitHub          | Access                   | GitHub access                          | 1280×1256 | 375×1592 |
| 31  | GitHub          | Conversations            | GitHub conversations                   | 1280×1160 | 375×1600 |
| 32  | GitHub          | Activity                 | GitHub activity                        | 1280×1200 | 375×1640 |
| 18  | GitHub          | Conversation walkthrough | How GitHub conversations work          | 1280×960  | 375×1320 |
| 19  | Microsoft Teams | Setup                    | Register Maya for Microsoft Teams      | 1280×1064 | 375×1720 |
| 48  | Microsoft Teams | Setup                    | Connect the Microsoft bot identity     | 1280×1024 | 375×1536 |
| 49  | Microsoft Teams | Setup                    | Install Maya in Microsoft Teams        | 1280×920  | 375×1504 |
| 50  | Microsoft Teams | Setup                    | Try Maya in Microsoft Teams            | 1280×984  | 375×1616 |
| 33  | Microsoft Teams | Overview                 | Microsoft Teams overview               | 1280×1472 | 375×1928 |
| 20  | Microsoft Teams | Settings                 | Microsoft Teams settings               | 1280×1322 | 375×1788 |
| 34  | Microsoft Teams | Access                   | Microsoft Teams access                 | 1280×1256 | 375×1592 |
| 35  | Microsoft Teams | Conversations            | Microsoft Teams conversations          | 1280×1160 | 375×1600 |
| 36  | Microsoft Teams | Activity                 | Microsoft Teams activity               | 1280×1200 | 375×1640 |
| 21  | Microsoft Teams | Conversation walkthrough | How Microsoft Teams conversations work | 1280×960  | 375×1320 |
| 22  | Telegram        | Setup                    | Create Maya with BotFather             | 1280×1200 | 375×1800 |
| 51  | Telegram        | Setup                    | Add Maya to Telegram chats             | 1280×1136 | 375×1760 |
| 52  | Telegram        | Setup                    | Try Maya in Telegram                   | 1280×1136 | 375×1760 |
| 37  | Telegram        | Overview                 | Telegram overview                      | 1280×1472 | 375×1928 |
| 23  | Telegram        | Settings                 | Telegram settings                      | 1280×1322 | 375×1788 |
| 38  | Telegram        | Access                   | Telegram access                        | 1280×1256 | 375×1592 |
| 39  | Telegram        | Conversations            | Telegram conversations                 | 1280×1160 | 375×1600 |
| 40  | Telegram        | Activity                 | Telegram activity                      | 1280×1200 | 375×1640 |
| 24  | Telegram        | Conversation walkthrough | How Telegram conversations work        | 1280×960  | 375×1320 |
| 11  | Paperclip       | Shared                   | Externally bound task                  | 1280×800  | 375×812  |
| 12  | Paperclip       | Shared                   | Agent Channels                         | 1280×800  | 375×812  |

## Annotation and action notes

### 01 · Connectors

Purpose: Connect tools and places where people talk to agents.

1. Existing global and Connectors navigation stays unchanged.
2. Search remains the primary catalog control; a small capability filter narrows to Chat, Tools, or Connected.
3. Each provider row keeps one primary Connect action and summarizes existing tool/chat connections underneath.
4. Provider capability and maturity are secondary metadata, not additional setup steps.

Rationale: The existing Apps catalog remains the single entry point.

### 02 · Choose how to connect

Purpose: This choice appears for every provider that supports both chat and tool connection surfaces.

1. The existing connection wizard shell and selected provider are reused.
2. Chat with an agent is the incoming-conversation path.
3. Use this connection as an agent tool is the outbound tool/credential path.
4. Chat-only or tool-only providers skip this choice entirely.

Rationale: The same directional choice applies to GitHub and any future dual-purpose connector.

### 03 · Which agent do you want to chat with?

Purpose: Choose the one Paperclip agent represented by this connection.

1. The heading asks exactly **Which agent do you want to chat with?**
2. The existing agent selector shows active agents, role, avatar, and selected state.
3. One-line helper copy states that Slack will show this agent as its own bot.
4. Continue is enabled for exactly one active agent; there is no bot identity configuration step.

Rationale: Agent choice happens once; every provider setup screen then shows it as immutable.

### 13 · Add Maya to Slack

Purpose: Approve one agent installation. Paperclip handles credentials and delivery in the background.

1. The left rail shows the three-step happy path and preserves progress when Slack redirects away and back.
2. Maya is shown as immutable; there is no Change agent action. Another agent requires another connection.
3. The external Slack authorization is explained before the one primary action.
4. Credentials and delivery are explicitly automatic, while custom-app setup is a secondary advanced branch.

Actions:

- **Add Maya to Slack:** Opens Slack's agent-installation authorization, then returns to Paperclip with the scoped installation stored internally.
- **Use a custom Slack app:** Enters the advanced self-hosted/existing-app branch; it does not expose transport choices on this screen.

Rationale: The common case is one Slack authorization button, not an infrastructure questionnaire.

### 41 · Try Maya in Slack

Purpose: Mention Maya once. Paperclip verifies the real workspace event and creates the first task thread.

1. Completed rail steps make the Slack redirect and successful return obvious.
2. Agent, workspace, and capability checks are read-only results—not editable setup options.
3. The test teaches the Hermes root-mention-to-thread behavior directly.
4. The first real signed event completes verification; finishing early remains possible without inventing another setup form.

Actions:

- **Open Slack:** Opens the installed workspace; Paperclip remains on this step and listens for the first valid event.
- **Finish without testing:** Activates the endpoint with verified installation health and leaves the first-message check visible on Overview.

Rationale: The final step teaches the real interaction and proves inbound delivery with the smallest possible user action.

### 42 · Create a custom Slack app

Purpose: Advanced path for self-hosted deployments or organizations that require a customer-owned app.

1. The rail clearly marks this as a separate custom-app branch.
2. Agent assignment remains immutable in the advanced path.
3. Paperclip precomputes identity, callbacks, permissions, and events; none become user choices.
4. One external action replaces the old manifest copy, delivery selection, and provider-configuration rows.

Actions:

- **Open prefilled Slack setup:** Opens Slack's app-from-manifest URL with Paperclip's generated manifest already encoded.
- **Back to Add to Slack:** Returns to the managed/default installation path without losing the selected agent.

Rationale: A custom app remains possible, but Paperclip collapses it to the provider action that only the customer can perform.

### 43 · Connect the custom Slack app

Purpose: Provide only the two secrets Slack cannot return to Paperclip for a customer-owned app.

1. Only provider credentials that cannot be recovered automatically are shown.
2. Help text explains exactly why Paperclip needs each secret.
3. Webhook, relay, Socket Mode, and app-token choices are absent from endpoint onboarding.
4. Saving is write-only and immediately followed by provider verification.

Actions:

- **Save and verify:** Writes both values to the secret store, calls Slack auth.test, validates expected scopes, and advances to verification.
- **Back:** Returns to the manifest step without persisting partially entered secrets.

Rationale: Customer-owned Slack apps require credentials, but the form is limited to the irreducible two values.

### 44 · Verify the custom Slack app

Purpose: Paperclip checks identity, callbacks, permissions, and installation before activation.

1. All prior custom-app phases remain visible in the completed rail.
2. Checks are results with direct remediation, not setup toggles.
3. The chosen delivery path is disclosed but cannot be changed from the endpoint wizard.
4. Activation is the only primary action after every required check passes.

Actions:

- **Activate Maya:** Marks the endpoint active and opens the ordinary Slack connector Overview.
- **Back:** Returns to credential entry; existing verified secret references remain selected.

Rationale: The advanced path ends with evidence, while transport mechanics remain owned by the deployment.

### 25 · Slack overview

Purpose: Identity, installation health, automatic capabilities, and connector lifecycle.

1. The endpoint keeps one Paperclip agent and one provider-native bot identity together.
2. Installation and delivery health are summarized before any configuration detail.
3. Every safe capability available to this provider is included automatically; this is status, not a set of switches.
4. Test, pause, reconnect, and remove remain ordinary connector lifecycle actions.

Rationale: Overview reports everything this connection can do automatically without turning capabilities into settings.

### 14 · Slack settings

Purpose: Only scope, task-boundary, delivery, and provider-permission choices.

1. Reach is an operator choice and is always bounded by the Slack installation and actual bot membership.
2. Root mention, native thread creation, subscribed replies, and DM task boundaries are explicit.
3. Delivery is read-only status; only credential rotation and installation repair require operator action here. Slack capabilities are reported on Overview and demonstrated in the walkthrough, never configured here.

Rationale: Settings contains genuine operator decisions; the maximum safe provider feature set is automatic.

### 26 · Slack access

Purpose: External identities, linked Paperclip users, sponsored guests, and effective authority.

1. The endpoint sponsor supplies the maximum authority available to unlinked external people.
2. Linked provider identities act as their current Paperclip users and retain ordinary permission checks.
3. Unlinked people use the restricted sponsored-guest profile and cannot perform governance actions.
4. Provider identity and scope details make effective authority explainable and auditable.

Rationale: The shared permission model is made concrete with provider-specific stable identity keys and edge cases.

### 27 · Slack conversations

Purpose: Inspect native conversation-to-Paperclip issue bindings.

1. Each row names the provider-native conversation boundary and its single Paperclip issue.
2. Participants, assigned agent, state, and last activity make live bindings scannable.
3. Open in provider and Open task take an operator to either side of the binding.
4. Detach preserves history and publication records; a later activation creates or claims a new binding.

Rationale: Operators can see and manage the exact native boundary used for each durable task binding.

### 28 · Slack activity

Purpose: Inspect provider health, deliveries, callbacks, publications, and retries.

1. Provider, credential, callback, and deployment-selected delivery health are summarized in one operational section.
2. Inbound deliveries, callbacks, and outbound publications share a durable chronological ledger.
3. Operators can inspect redacted errors and replay only safe, authorized failed deliveries.
4. Rate limits, permission drift, uninstall or revocation, and provider-specific diagnostics stay visible.

Rationale: The durable ledger is shared in concept but includes the diagnostics and lifecycle states of this provider.

### 15 · How Slack conversations work

Purpose: What Ari sees in Slack and the single Paperclip issue created behind the thread.

1. Ari starts in a Slack channel with a root @maya mention; unrelated root messages do not start work.
2. Maya acknowledges inside a Slack thread, making the thread—not the channel—the visible conversation boundary.
3. Paperclip creates exactly one assigned issue and shows its Slack source, external participant, and publication state.
4. Ari continues by replying in the same thread without another mention; files and actions remain in that context.
5. Maya's safe progress and final answer publish in the thread; failures offer retry or a Paperclip link.

Rationale: This is a product-behavior walkthrough: the external conversation people see beside the Paperclip issue it creates.

### 16 · Create Maya in GitHub

Purpose: GitHub creates a dedicated App from Paperclip's manifest and returns its credentials automatically.

1. The wizard rail follows provider handoffs and keeps the selected agent visible.
2. Maya is immutable and chat-purpose GitHub access is explicitly separate from tool-purpose access.
3. The manifest fixes permissions and events instead of asking the operator to configure them.
4. Default App credentials return server-to-server; only the existing-App branch exposes fields.

Actions:

- **Create in GitHub:** Posts Paperclip's manifest to GitHub; GitHub confirms the App, redirects back, and Paperclip exchanges the one-time code for credentials.
- **Use an existing GitHub App:** Opens the advanced credential form for an App the company already owns.

Rationale: GitHub's App Manifest flow removes nearly every manual setup row while preserving a dedicated native bot.

### 45 · Choose GitHub repositories

Purpose: Install Maya on an organization or account, then choose all or selected repositories in GitHub.

1. The App-creation phase is complete before repository installation begins.
2. The agent and App identity are read-only results.
3. All organization and repository choices happen at GitHub, where policy and approval live.
4. Paperclip receives the installation ID and repository inventory automatically.

Actions:

- **Install in GitHub:** Opens the GitHub App installation page; GitHub collects owner/repository approval and returns the installation ID.
- **Back:** Returns to App creation without deleting the already-created GitHub App.

Rationale: Repository scope is the only meaningful default-flow choice, and GitHub already owns its UI.

### 46 · Try Maya in GitHub

Purpose: Mention Maya in an allowed issue, pull-request conversation, or review thread.

1. All setup phases remain visible and resumable.
2. Installation scope and chat-only authority are confirmed before testing.
3. The test covers issue, PR, and review-thread behavior without manufacturing a separate GitHub thread.
4. A real signed webhook completes verification; the endpoint may still be finished for later testing.

Actions:

- **Open GitHub:** Opens an installed repository while Paperclip waits for the first signed mention event.
- **Finish without testing:** Activates the endpoint and leaves the first-delivery check visible on Overview.

Rationale: Testing teaches the native object binding while proving the provider's actual delivery path.

### 47 · Connect an existing GitHub App

Purpose: Advanced path for organizations that already own and govern the dedicated chat App.

1. The existing-App rail is a distinct advanced branch.
2. Only App ID, private key, webhook secret, and optional GHES host are requested.
3. Paperclip verifies events and permissions instead of adding more setup switches.
4. The primary action stores write-only secrets and proves App authentication before continuing.

Actions:

- **Connect and verify:** Stores the private key and webhook secret, authenticates as the App, and verifies permissions/events before repository installation.
- **Back to manifest flow:** Returns to the default credential-free App Manifest path.

Rationale: Existing Apps cannot use the one-time manifest exchange, so these credentials are irreducible.

### 29 · GitHub overview

Purpose: Identity, installation health, automatic capabilities, and connector lifecycle.

1. The endpoint keeps one Paperclip agent and one provider-native bot identity together.
2. Installation and delivery health are summarized before any configuration detail.
3. Every safe capability available to this provider is included automatically; this is status, not a set of switches.
4. Test, pause, reconnect, and remove remain ordinary connector lifecycle actions.

Rationale: Overview reports everything this connection can do automatically without turning capabilities into settings.

### 17 · GitHub settings

Purpose: Only scope, task-boundary, delivery, and provider-permission choices.

1. Repository and conversation-surface reach are the only content-scope choices.
2. Existing GitHub objects supply the issue boundary; optional non-mention activation remains an explicit workflow choice.
3. Host, private-key rotation, and installation drift are operational settings. GitHub response capabilities are reported on Overview and demonstrated in the walkthrough, never configured here.

Rationale: Settings contains genuine operator decisions; the maximum safe provider feature set is automatic.

### 30 · GitHub access

Purpose: External identities, linked Paperclip users, sponsored guests, and effective authority.

1. The endpoint sponsor supplies the maximum authority available to unlinked external people.
2. Linked provider identities act as their current Paperclip users and retain ordinary permission checks.
3. Unlinked people use the restricted sponsored-guest profile and cannot perform governance actions.
4. Provider identity and scope details make effective authority explainable and auditable.

Rationale: The shared permission model is made concrete with provider-specific stable identity keys and edge cases.

### 31 · GitHub conversations

Purpose: Inspect native conversation-to-Paperclip issue bindings.

1. Each row names the provider-native conversation boundary and its single Paperclip issue.
2. Participants, assigned agent, state, and last activity make live bindings scannable.
3. Open in provider and Open task take an operator to either side of the binding.
4. Detach preserves history and publication records; a later activation creates or claims a new binding.

Rationale: Operators can see and manage the exact native boundary used for each durable task binding.

### 32 · GitHub activity

Purpose: Inspect provider health, deliveries, callbacks, publications, and retries.

1. Provider, credential, callback, and deployment-selected delivery health are summarized in one operational section.
2. Inbound deliveries, callbacks, and outbound publications share a durable chronological ledger.
3. Operators can inspect redacted errors and replay only safe, authorized failed deliveries.
4. Rate limits, permission drift, uninstall or revocation, and provider-specific diagnostics stay visible.

Rationale: The durable ledger is shared in concept but includes the diagnostics and lifecycle states of this provider.

### 18 · How GitHub conversations work

Purpose: What Ari sees in GitHub and how the existing object becomes one Paperclip issue.

1. Ari mentions the bot in an existing GitHub issue, PR conversation, or inline review thread.
2. Maya acknowledges with a reaction and one GitHub-Flavored Markdown comment rather than opening another thread.
3. Paperclip binds that exact GitHub object or review thread to one assigned issue; PR conversation and inline review stay distinct.
4. Later comments continue the same issue, while bot-authored comments and duplicate deliveries are ignored.
5. Progress edits the existing comment; files and governed actions use authenticated Paperclip links.

Rationale: This is a product-behavior walkthrough: the external conversation people see beside the Paperclip issue it creates.

### 19 · Register Maya for Microsoft Teams

Purpose: Run one guided Microsoft command to create the customer-owned bot identity and point it at Paperclip.

1. The five-step rail reflects the irreducible Microsoft registration and package lifecycle.
2. Maya is shown as immutable before any Microsoft resources are created.
3. The recommended CLI path collapses Entra, Azure Bot, channel, endpoint, and policy setup into one provider-owned command.
4. Manual Azure Portal work is a secondary path, not a competing set of first-page options.

Actions:

- **Copy setup command:** Copies the generated Teams Developer CLI command; the user runs it locally so Microsoft owns authentication and resource provisioning.
- **Use Azure Portal instead:** Opens detailed manual instructions for locked-down tenants; it produces the same three required identity values.

Rationale: Microsoft requires customer-owned bot infrastructure today, so simplification means one guided command rather than pretending credentials do not exist.

### 48 · Connect the Microsoft bot identity

Purpose: Paste the three values created by Microsoft so Paperclip can authenticate as Maya.

1. The completed registration step remains visible in the rail.
2. Exactly three Microsoft values are requested, each with a reason.
3. Secret storage and rotation are explained; managed identity is moved to instance-level advanced setup.
4. One save action both persists and proves the identity before package generation.

Actions:

- **Save and verify:** Stores the secret, requests a Microsoft bot token, and verifies tenant, bot identity, and messaging endpoint.
- **Back:** Returns to the registration instructions without persisting partial fields.

Rationale: These credentials are required because Microsoft does not provide a GitHub-style manifest callback for the customer-owned bot.

### 49 · Install Maya in Microsoft Teams

Purpose: Download the generated app package and let Microsoft apply tenant and scope policy.

1. Registration and identity steps are complete before a package can be generated.
2. Agent, package name, validation, and scopes are read-only.
3. The screen branches only on Microsoft tenant policy, not Paperclip preferences.
4. The two actions correspond to the two external operations: obtain the package, then install it.

Actions:

- **Download Teams package:** Downloads the validated ZIP containing manifest.json and the required icons; it contains no secret.
- **Open Teams:** Opens Manage your apps so the operator can upload/install, subject to tenant policy.

Rationale: Teams package installation is provider-owned and cannot be collapsed into the credential step without hiding tenant policy.

### 50 · Try Maya in Microsoft Teams

Purpose: Mention Maya in an installed channel post or start a personal chat.

1. The rail shows every completed Microsoft-owned phase.
2. Identity and endpoint checks are complete before installation delivery is claimed.
3. Channel-thread and linear-chat boundaries are tested separately in plain language.
4. Live delivery establishes actual mention/RSC behavior rather than assuming it from the package.

Actions:

- **Open Microsoft Teams:** Opens Teams while Paperclip waits for the first authenticated activity from an installed scope.
- **Finish without testing:** Activates the endpoint and leaves package/install delivery health visible on Overview.

Rationale: A real Teams activity is the only reliable final proof of package installation and conversation delivery.

### 33 · Microsoft Teams overview

Purpose: Identity, installation health, automatic capabilities, and connector lifecycle.

1. The endpoint keeps one Paperclip agent and one provider-native bot identity together.
2. Installation and delivery health are summarized before any configuration detail.
3. Every safe capability available to this provider is included automatically; this is status, not a set of switches.
4. Test, pause, reconnect, and remove remain ordinary connector lifecycle actions.

Rationale: Overview reports everything this connection can do automatically without turning capabilities into settings.

### 20 · Microsoft Teams settings

Purpose: Only scope, task-boundary, delivery, and provider-permission choices.

1. Tenant, installed team/channel, personal, and group-chat reach are explicit scope choices.
2. Channel threads and linear-conversation active tasks are different, visible issue boundaries.
3. Bot identity, RSC, Graph consent, and installation drift are the only provider-level operations. Teams capabilities are reported on Overview and demonstrated in the walkthrough, never configured here.

Rationale: Settings contains genuine operator decisions; the maximum safe provider feature set is automatic.

### 34 · Microsoft Teams access

Purpose: External identities, linked Paperclip users, sponsored guests, and effective authority.

1. The endpoint sponsor supplies the maximum authority available to unlinked external people.
2. Linked provider identities act as their current Paperclip users and retain ordinary permission checks.
3. Unlinked people use the restricted sponsored-guest profile and cannot perform governance actions.
4. Provider identity and scope details make effective authority explainable and auditable.

Rationale: The shared permission model is made concrete with provider-specific stable identity keys and edge cases.

### 35 · Microsoft Teams conversations

Purpose: Inspect native conversation-to-Paperclip issue bindings.

1. Each row names the provider-native conversation boundary and its single Paperclip issue.
2. Participants, assigned agent, state, and last activity make live bindings scannable.
3. Open in provider and Open task take an operator to either side of the binding.
4. Detach preserves history and publication records; a later activation creates or claims a new binding.

Rationale: Operators can see and manage the exact native boundary used for each durable task binding.

### 36 · Microsoft Teams activity

Purpose: Inspect provider health, deliveries, callbacks, publications, and retries.

1. Provider, credential, callback, and deployment-selected delivery health are summarized in one operational section.
2. Inbound deliveries, callbacks, and outbound publications share a durable chronological ledger.
3. Operators can inspect redacted errors and replay only safe, authorized failed deliveries.
4. Rate limits, permission drift, uninstall or revocation, and provider-specific diagnostics stay visible.

Rationale: The durable ledger is shared in concept but includes the diagnostics and lifecycle states of this provider.

### 21 · How Microsoft Teams conversations work

Purpose: What Ari sees in a channel thread, with separate DM and group-chat behavior.

1. Ari mentions Maya in a new Teams channel post; that post and its replies are the native thread.
2. Maya acknowledges under the post. If the installed permissions cannot deliver unmentioned replies, the bot says to mention Maya again.
3. Paperclip creates one assigned issue and records tenant, team/channel, thread, and external participant attribution.
4. Replies, files, and Adaptive Card or task-module actions continue only when current Teams delivery and Paperclip permissions allow.
5. DMs may stream natively; channel and group output buffers or edits, with targeted-message, DM, or text-link fallback.

Rationale: This is a product-behavior walkthrough: the external conversation people see beside the Paperclip issue it creates.

### 22 · Create Maya with BotFather

Purpose: Create one Telegram bot and paste the token BotFather gives you.

1. The rail shows Telegram's short four-step path.
2. Maya is read-only and another agent requires another connection.
3. The sole credential field is explained as a BotFather platform limitation.
4. Webhook, relay, polling, commands, and capabilities are configured automatically after the token is saved.

Actions:

- **Connect bot:** Stores the token write-only, calls getMe, configures the deployment-selected delivery path, and registers supported commands.
- **Open BotFather:** Opens Telegram's verified BotFather conversation; it cannot return the token to Paperclip automatically.

Rationale: Telegram has no OAuth-style bot installation, so one token field is irreducible while every other setup choice disappears.

### 51 · Add Maya to Telegram chats

Purpose: Open Maya's Telegram profile, then add the bot wherever people should start tasks.

1. Bot creation is complete before provider-owned chat membership begins.
2. Agent, Telegram identity, and delivery are read-only results.
3. DM, group, and forum reach are described without asking for numeric IDs.
4. Privacy remains on and admin rights are intentionally excluded from initial setup.

Actions:

- **Open Maya in Telegram:** Opens the bot deep link so the operator can start a DM or add it to a group/forum.
- **Continue:** Advances to live verification; Paperclip does not require pre-entered numeric chat IDs during setup.

Rationale: People choose Telegram reach by adding the bot in Telegram, not by configuring a Paperclip allowlist before any chat IDs exist.

### 52 · Try Maya in Telegram

Purpose: Send one addressed message so Paperclip can verify the bot, chat, and task boundary.

1. All prior Telegram steps remain visible in the completed rail.
2. Bot API and delivery checks are separate from the first real conversation.
3. DM, group, and forum tests teach their different task boundaries.
4. A real addressed update captures stable IDs and proves the maximum safe output path.

Actions:

- **Open Telegram:** Opens Maya's bot profile while Paperclip waits for the first verified update.
- **Finish without testing:** Activates the endpoint and leaves first-delivery and chat-discovery health visible on Overview.

Rationale: The final step verifies Telegram's actual context and privacy behavior without another settings form.

### 37 · Telegram overview

Purpose: Identity, installation health, automatic capabilities, and connector lifecycle.

1. The endpoint keeps one Paperclip agent and one provider-native bot identity together.
2. Installation and delivery health are summarized before any configuration detail.
3. Every safe capability available to this provider is included automatically; this is status, not a set of switches.
4. Test, pause, reconnect, and remove remain ordinary connector lifecycle actions.

Rationale: Overview reports everything this connection can do automatically without turning capabilities into settings.

### 23 · Telegram settings

Purpose: Only scope, task-boundary, delivery, and provider-permission choices.

1. Chat, topic, DM, and optional user reach are real scope choices.
2. DM/group active tasks and forum-topic bindings make Telegram's non-Slack boundaries explicit.
3. Delivery is read-only status; privacy mode and token rotation are the only provider operations exposed here. Telegram capabilities are reported on Overview and demonstrated in the walkthrough, never configured here.

Rationale: Settings contains genuine operator decisions; the maximum safe provider feature set is automatic.

### 38 · Telegram access

Purpose: External identities, linked Paperclip users, sponsored guests, and effective authority.

1. The endpoint sponsor supplies the maximum authority available to unlinked external people.
2. Linked provider identities act as their current Paperclip users and retain ordinary permission checks.
3. Unlinked people use the restricted sponsored-guest profile and cannot perform governance actions.
4. Provider identity and scope details make effective authority explainable and auditable.

Rationale: The shared permission model is made concrete with provider-specific stable identity keys and edge cases.

### 39 · Telegram conversations

Purpose: Inspect native conversation-to-Paperclip issue bindings.

1. Each row names the provider-native conversation boundary and its single Paperclip issue.
2. Participants, assigned agent, state, and last activity make live bindings scannable.
3. Open in provider and Open task take an operator to either side of the binding.
4. Detach preserves history and publication records; a later activation creates or claims a new binding.

Rationale: Operators can see and manage the exact native boundary used for each durable task binding.

### 40 · Telegram activity

Purpose: Inspect provider health, deliveries, callbacks, publications, and retries.

1. Provider, credential, callback, and deployment-selected delivery health are summarized in one operational section.
2. Inbound deliveries, callbacks, and outbound publications share a durable chronological ledger.
3. Operators can inspect redacted errors and replay only safe, authorized failed deliveries.
4. Rate limits, permission drift, uninstall or revocation, and provider-specific diagnostics stay visible.

Rationale: The durable ledger is shared in concept but includes the diagnostics and lifecycle states of this provider.

### 24 · How Telegram conversations work

Purpose: How DMs, privacy-on groups, and forum topics establish an explicit active issue.

1. In a DM, Ari's first message creates the active issue; New task or /new deliberately starts another.
2. In a privacy-on group, @maya starts work and replying to Maya continues; unrelated group traffic is not consumed.
3. A forum topic can bind one issue through message_thread_id when the bot is present and allowed.
4. Paperclip shows the active issue and makes the linear-chat boundary explicit instead of implying a Slack-style native thread.
5. Maya uses throttled post/edit and inline buttons; unsupported or governed actions return text or DM with a Paperclip link.

Rationale: This is a product-behavior walkthrough: the external conversation people see beside the Paperclip issue it creates.

### 11 · Externally bound task

Purpose: A normal Paperclip task with explicit publication and detach controls.

1. A compact source banner links the provider thread and explains the locked assignee.
2. External comments retain provider attribution and linked-user status.
3. Agent publications show queued, streaming, delivered, or failed state.
4. The board composer remains internal by default; **Send to channel** is explicit and detach requires confirmation.

Rationale: External work remains governed by the ordinary task experience.

### 12 · Agent Channels

Purpose: See every provider identity representing this agent.

1. Channels is an Agent detail destination under Runtime.
2. Endpoint rows show provider bot identity, reach summary, and health.
3. Recent channel-created tasks link to normal task detail.
4. **Connect a channel** opens `/apps` with this agent preselected; management returns to the connector.

Rationale: Agent detail summarizes endpoints; Connectors continues to manage them.
