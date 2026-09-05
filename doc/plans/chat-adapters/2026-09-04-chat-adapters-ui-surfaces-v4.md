# Paperclip Chat Adapters UI Surfaces — v4

Status: historical snapshot; current product flow is [`2026-09-04-chat-adapters-ui-surfaces-v5.md`](./2026-09-04-chat-adapters-ui-surfaces-v5.md)
Date: 2026-09-04
Paperclip base: `7b094724e65c04949706df638d497afb02c84b62`
Review viewer: [`index.html`](./index.html)
Wireframes: [`wireframes-v4/`](./wireframes-v4/)

## Product rules represented

- `/apps` remains the Connectors catalog. A purpose choice appears only for platforms such as GitHub that can be both a chat medium and an agent tool.
- Chat setup asks for the agent first, then performs a provider-owned installation handoff with reasonable defaults.
- Each provider endpoint has the complete existing-style detail shell: Overview, Settings, Access, Conversations, and Activity.
- Setup and settings use ordinary top-to-bottom sections. Desktop canvases grow to fit their content; the pages are not compressed into an 800px dashboard or bento grid.
- Provider capabilities are implementation guarantees, not endpoint preferences. Paperclip automatically uses the maximum safe set available to that adapter, provider installation, conversation type, and current Paperclip permission check.
- Settings therefore contain only genuine choices: scope, task boundaries, delivery/deployment, credentials, and explicit provider permission grants. Reactions, streaming, rich messages/cards, actions, modals, commands, files, edits, and private fallbacks are never shown as on/off settings.
- Overview reports the capability set as **Available automatically**. Conversation walkthroughs demonstrate it in the provider's native medium.
- Red dashed marks and numbers are review annotations, not proposed UI.

## Complete tab coverage

Every provider group contains Setup, Overview, Settings, Access, Conversations, Activity, and a behavior walkthrough. The five tab names shown in the endpoint sidebar each have a provider-specific desktop and mobile wireframe. Shared generic Overview/Access/Conversations/Activity mockups are removed from the current viewer so they cannot be mistaken for the provider-specific designs.

## Inventory

| ID  | Group           | Surface                                | Desktop   | Mobile   |
| --- | --------------- | -------------------------------------- | --------- | -------- |
| 01  | Start           | Connectors                             | 1280×800  | 375×812  |
| 02  | Start           | Connect GitHub                         | 1280×800  | 375×812  |
| 03  | Start           | Which agent do you want to chat with?  | 1280×800  | 375×812  |
| 13  | Slack           | Invite Maya to Slack                   | 1280×1694 | 375×2264 |
| 25  | Slack           | Slack overview                         | 1280×1472 | 375×1928 |
| 14  | Slack           | Slack settings                         | 1280×1250 | 375×1676 |
| 26  | Slack           | Slack access                           | 1280×1256 | 375×1592 |
| 27  | Slack           | Slack conversations                    | 1280×1160 | 375×1600 |
| 28  | Slack           | Slack activity                         | 1280×1200 | 375×1640 |
| 15  | Slack           | How Slack conversations work           | 1280×960  | 375×1320 |
| 16  | GitHub          | Connect Maya to GitHub conversations   | 1280×1838 | 375×2512 |
| 29  | GitHub          | GitHub overview                        | 1280×1472 | 375×1928 |
| 17  | GitHub          | GitHub settings                        | 1280×1178 | 375×1564 |
| 30  | GitHub          | GitHub access                          | 1280×1256 | 375×1592 |
| 31  | GitHub          | GitHub conversations                   | 1280×1160 | 375×1600 |
| 32  | GitHub          | GitHub activity                        | 1280×1200 | 375×1640 |
| 18  | GitHub          | How GitHub conversations work          | 1280×960  | 375×1320 |
| 19  | Microsoft Teams | Invite Maya to Microsoft Teams         | 1280×1838 | 375×2488 |
| 33  | Microsoft Teams | Microsoft Teams overview               | 1280×1472 | 375×1928 |
| 20  | Microsoft Teams | Microsoft Teams settings               | 1280×1322 | 375×1788 |
| 34  | Microsoft Teams | Microsoft Teams access                 | 1280×1256 | 375×1592 |
| 35  | Microsoft Teams | Microsoft Teams conversations          | 1280×1160 | 375×1600 |
| 36  | Microsoft Teams | Microsoft Teams activity               | 1280×1200 | 375×1640 |
| 21  | Microsoft Teams | How Microsoft Teams conversations work | 1280×960  | 375×1320 |
| 22  | Telegram        | Invite Maya to Telegram                | 1280×1766 | 375×2376 |
| 37  | Telegram        | Telegram overview                      | 1280×1472 | 375×1928 |
| 23  | Telegram        | Telegram settings                      | 1280×1322 | 375×1788 |
| 38  | Telegram        | Telegram access                        | 1280×1256 | 375×1592 |
| 39  | Telegram        | Telegram conversations                 | 1280×1160 | 375×1600 |
| 40  | Telegram        | Telegram activity                      | 1280×1200 | 375×1640 |
| 24  | Telegram        | How Telegram conversations work        | 1280×960  | 375×1320 |
| 11  | Paperclip       | Externally bound task                  | 1280×800  | 375×812  |
| 12  | Paperclip       | Agent Channels                         | 1280×800  | 375×812  |

## Annotation notes

### 01 · Connectors

Purpose: Connect tools and places where people talk to agents.

1. Existing global and Connectors navigation stays unchanged.
2. Search remains the primary catalog control; a small capability filter narrows to Chat, Tools, or Connected.
3. Each provider row keeps one primary Connect action and summarizes existing tool/chat connections underneath.
4. Provider capability and maturity are secondary metadata, not additional setup steps.

Rationale: The existing Apps catalog remains the single entry point.

### 02 · Connect GitHub

Purpose: Choose chat or tool use only when a provider supports both.

1. The existing connection wizard shell and provider identity are reused.
2. **Chat with an agent** is one concise radio card describing incoming conversation.
3. **Use this channel as an agent tool** is one concise radio card that enters the existing tool flow.
4. Continue advances immediately; chat-only providers never see this screen.

Rationale: The purpose decision appears only when the provider is ambiguous.

### 03 · Which agent do you want to chat with?

Purpose: Choose the one Paperclip agent represented by this bot.

1. The heading asks exactly **Which agent do you want to chat with?**
2. The existing agent selector shows active agents, role, avatar, and selected state.
3. One-line helper copy states that Slack will show this agent as its own bot.
4. Continue is enabled for exactly one active agent; there is no bot identity configuration step.

Rationale: This is the only shared Paperclip-specific setup decision.

### 13 · Invite Maya to Slack

Purpose: Create or select one Slack app, install it, and verify the workspace connection.

1. Agent and native bot identity are the first and only Paperclip binding decision.
2. Direct webhook is the default; relay and Socket Mode are explicit deployment alternatives.
3. Paperclip provides a manifest, while Slack owns app creation, approval, installation, and channel invitation.
4. Tokens and signing secrets are masked secret references with independent rotation.
5. Activation follows specific identity, signature, scope, event, interactivity, and membership checks.

Rationale: Provider-owned setup is a resumable, top-to-bottom handoff rather than a dense card dashboard.

### 25 · Slack overview

Purpose: Identity, installation health, automatic capabilities, and connector lifecycle.

1. The endpoint keeps one Paperclip agent and one provider-native bot identity together.
2. Installation and delivery health are summarized before any configuration detail.
3. Every safe capability available to this provider is included automatically; this is status, not a set of switches.
4. Test, pause, reconnect, and remove remain ordinary connector lifecycle actions.

Rationale: Overview reports everything this connection can do automatically without turning capabilities into settings.

### 14 · Slack settings

Purpose: Only scope, task boundaries, access, and necessary provider operations.

1. Reach is an operator choice and is always bounded by the Slack installation and actual bot membership.
2. Root mention, native thread creation, subscribed replies, and DM task boundaries are explicit.
3. Delivery is read-only status; only credential rotation and installation repair require operator action here. Slack capabilities are reported on Overview and demonstrated in the walkthrough, never configured here.

Rationale: Settings contains genuine operator decisions and repair actions; provider capabilities are automatic and live on Overview.

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

Rationale: The walkthrough demonstrates the automatic maximal capability policy in the provider-native medium.

### 16 · Connect Maya to GitHub conversations

Purpose: Install a least-privilege GitHub App on the repositories where people will talk to Maya.

1. The endpoint is explicitly chat-only; repository code/tool credentials stay separate.
2. GitHub App is the production default, with host and Enterprise Server handled before registration.
3. Paperclip gives the operator exact webhook, permission, and event values in one vertical sequence.
4. GitHub owns organization approval and repository selection; Paperclip stores only secret references.
5. Verification proves delivery and installation while confirming that broad code permissions were not granted.

Rationale: Provider-owned setup is a resumable, top-to-bottom handoff rather than a dense card dashboard.

### 29 · GitHub overview

Purpose: Identity, installation health, automatic capabilities, and connector lifecycle.

1. The endpoint keeps one Paperclip agent and one provider-native bot identity together.
2. Installation and delivery health are summarized before any configuration detail.
3. Every safe capability available to this provider is included automatically; this is status, not a set of switches.
4. Test, pause, reconnect, and remove remain ordinary connector lifecycle actions.

Rationale: Overview reports everything this connection can do automatically without turning capabilities into settings.

### 17 · GitHub settings

Purpose: Only scope, task boundaries, access, and necessary provider operations.

1. Repository and conversation-surface reach are the only content-scope choices.
2. Existing GitHub objects supply the issue boundary; optional non-mention activation remains an explicit workflow choice.
3. Host, private-key rotation, and installation drift are operational settings. GitHub response capabilities are reported on Overview and demonstrated in the walkthrough, never configured here.

Rationale: Settings contains genuine operator decisions and repair actions; provider capabilities are automatic and live on Overview.

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

Rationale: The walkthrough demonstrates the automatic maximal capability policy in the provider-native medium.

### 19 · Invite Maya to Microsoft Teams

Purpose: Register the bot, package the Teams app, install it to the intended scopes, and verify delivery.

1. The selected agent, Teams identity, and copyable public endpoint lead the setup.
2. Cloud, tenant mode, and exactly one bot-authentication strategy are chosen before registration.
3. Paperclip provides CLI, manifest, and package values in a conventional top-to-bottom handoff.
4. Tenant approval and installation happen in Microsoft Teams; Paperclip keeps the draft if admin action is required.
5. Verification separates registration, manifest, endpoint, installation, and doctor checks without requesting broad Graph consent.

Rationale: Provider-owned setup is a resumable, top-to-bottom handoff rather than a dense card dashboard.

### 33 · Microsoft Teams overview

Purpose: Identity, installation health, automatic capabilities, and connector lifecycle.

1. The endpoint keeps one Paperclip agent and one provider-native bot identity together.
2. Installation and delivery health are summarized before any configuration detail.
3. Every safe capability available to this provider is included automatically; this is status, not a set of switches.
4. Test, pause, reconnect, and remove remain ordinary connector lifecycle actions.

Rationale: Overview reports everything this connection can do automatically without turning capabilities into settings.

### 20 · Microsoft Teams settings

Purpose: Only scope, task boundaries, access, and necessary provider operations.

1. Tenant, installed team/channel, personal, and group-chat reach are explicit scope choices.
2. Channel threads and linear-conversation active tasks are different, visible issue boundaries.
3. Bot identity, RSC, Graph consent, and installation drift are the only provider-level operations. Teams capabilities are reported on Overview and demonstrated in the walkthrough, never configured here.

Rationale: Settings contains genuine operator decisions and repair actions; provider capabilities are automatic and live on Overview.

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

Rationale: The walkthrough demonstrates the automatic maximal capability policy in the provider-native medium.

### 22 · Invite Maya to Telegram

Purpose: Create one BotFather bot, choose a delivery mode, add it to chats, and verify privacy behavior.

1. Agent and unique Telegram bot username are the first binding decision.
2. BotFather owns creation and profile controls; privacy mode stays on by default.
3. Webhook, relay, and local polling are shown as mutually exclusive delivery paths.
4. The token is a masked secret reference, while Telegram chat membership remains an external step.
5. Activation verifies getMe, webhook or polling state, privacy, membership, pending updates, and a test message.

Rationale: Provider-owned setup is a resumable, top-to-bottom handoff rather than a dense card dashboard.

### 37 · Telegram overview

Purpose: Identity, installation health, automatic capabilities, and connector lifecycle.

1. The endpoint keeps one Paperclip agent and one provider-native bot identity together.
2. Installation and delivery health are summarized before any configuration detail.
3. Every safe capability available to this provider is included automatically; this is status, not a set of switches.
4. Test, pause, reconnect, and remove remain ordinary connector lifecycle actions.

Rationale: Overview reports everything this connection can do automatically without turning capabilities into settings.

### 23 · Telegram settings

Purpose: Only scope, task boundaries, access, and necessary provider operations.

1. Chat, topic, DM, and optional user reach are real scope choices.
2. DM/group active tasks and forum-topic bindings make Telegram's non-Slack boundaries explicit.
3. Delivery is read-only status; privacy mode and token rotation are the only provider operations exposed here. Telegram capabilities are reported on Overview and demonstrated in the walkthrough, never configured here.

Rationale: Settings contains genuine operator decisions and repair actions; provider capabilities are automatic and live on Overview.

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

Rationale: The walkthrough demonstrates the automatic maximal capability policy in the provider-native medium.

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

## Verification intent

- Desktop SVGs use 1280px width and whatever height their ordinary vertical content requires.
- Mobile SVGs use 375px width, minimum 48px controls, and enough height to avoid clipping.
- The house palette remains white, black, `#e6e6e6`, `#666`, and annotation-only `#d33`, with 1.5px black strokes and 12/14/20/28px type.
- Secrets appear only as masked references. No provider feature toggle can disable a safe supported capability.
