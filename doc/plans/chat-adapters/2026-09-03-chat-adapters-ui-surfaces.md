# Chat Adapters UI Surface Specification

**Status:** historical v1 requirements inventory; current product flow is `2026-09-04-chat-adapters-ui-surfaces-v8.md`. Managed-install and helper-first concepts below are not shipped requirements.
**Date:** 2026-09-03
**Paperclip base:** `origin/master` at `8430bd897f01dd4b91e0970efffb71b97e5a2685` (refreshed from earlier planning references through `d593463ab6394cd356bf27448ea28bad8cccf4ec`)
**Current wireframe viewer:** `index.html` in this directory renders the v5 step-rail package. The 19-screen inventory below is retained as architecture-coverage history, not the proposed onboarding flow.

## 1. Information architecture

Channel integrations extend existing Paperclip surfaces rather than adding a new global product area.

- **Apps / Connectors** remains discovery and connection management.
- Chat adapters are a native Paperclip subsystem surfaced through Apps; they are not installed or managed as a plugin.
- A provider with channel support exposes a clearly separate **Talk to an agent here** connection method beside any **Let agents use this app** tool method.
- A channel connection reuses the App detail shell with `Overview`, `Access`, `Behavior`, `Conversations`, and `Activity` views.
- Agent detail adds **Channels** under Runtime, between Tools and Governance.
- Task detail adds a channel-source banner, external actor attribution, outbound-publication state, and detach controls only when bound.
- Identity linking uses a minimal public Paperclip route reached from an ephemeral provider message or DM.
- Private self-host relay configuration lives inside the channel endpoint; it is not a global infrastructure page.
- Slack, Teams, Discord, Telegram, and GitHub are the initial supported set. Adapter capabilities determine whether Paperclip creates a native thread, binds an existing thread, or uses the stable conversation as the issue boundary.

The default audience is a company operator connecting and governing an agent. External participants see their native provider, not these configuration screens.

## 2. Cross-surface rules

- Always name the selected Paperclip agent and provider bot identity together.
- Always distinguish tool access from chat presence.
- State who can trigger the agent, where, and as which Paperclip principal before activation.
- Describe effective permissions; never imply that a provider membership grants Paperclip authority.
- Put safe defaults first: root mention creates/opens a provider thread and one Paperclip issue, threaded replies continue without mentions, queued overlap, public milestones only, linked-user permissions, sponsored restricted guests, agent routes off.
- Hide unsupported configuration and show the provider fallback beside partially supported behavior.
- Never display secrets after save. Show secret labels, source, last rotation, and health only.
- Every failed setup or delivery state says what happened, whether work was accepted, and the next safe action.
- Desktop uses the existing Paperclip primary and contextual sidebars. Mobile uses the existing drawer/header pattern with one full-width content column and 48px actions.

## 3. Screen specifications and annotations

### 01 — Connectors catalog

Purpose: discover providers and see whether each is connected for tools, channels, or both.

1. Existing Apps contextual navigation remains the entry point.
2. Filter chips select All, Tools, Channels, or Connected; search remains provider-wide.
3. Provider rows show separate tool/channel status and endpoint count.
4. Maturity and deployment badges prevent unsupported adapters from looking connectable.
5. Primary action opens provider detail; mobile keeps filters horizontally scrollable and rows stacked.

### 02 — Connection method

Purpose: make directionality unambiguous before credentials are requested.

1. Provider header and current accounts preserve Apps context.
2. Tool method explains the agent calls the provider as an external tool.
3. Channel method explains people message one selected Paperclip agent.
4. Identity/credential warning states that the methods are independently governed.
5. Continue is attached to the selected method; mobile cards become a vertical radio list.

### 03 — Choose agent and bot identity

Purpose: establish the endpoint's permanent Paperclip owner.

1. Wizard progress names the current step and retains a safe exit.
2. Agent selector shows active/invokable agents and their roles.
3. Native bot preview derives name/avatar from the agent and shows provider identity constraints.
4. One-bot-per-agent explanation shows how multiple agents coexist in one channel.
5. Collision/inactive-agent warnings block continuation; mobile preview follows the selector.

### 04 — Provider installation

Purpose: connect a real provider installation without hiding manual work.

1. Setup pattern switcher demonstrates Slack while allowing adapter-generated instructions.
2. BYO setup checklist exposes manifest/app creation, scopes, webhook URL, and event subscription.
3. Credentials are secret-reference fields with masking and source labels.
4. Verification checks signature, bot identity, scopes, and reachability independently.
5. Managed install is visibly optional/unavailable and never blocks BYO continuation.

### 05 — Conversation reach

Purpose: constrain where the bot can listen and explain root-mention-to-thread activation.

1. Workspace/tenant identity is read-only after verification.
2. Resource allowlist supports discovery plus exact external ids.
3. On Slack, Discord, and compatible Teams channels, a root mention creates/opens a native thread and exactly one endpoint-owned Paperclip issue; later thread replies need no mention.
4. DM policy explains its task boundary and proactive-DM restriction.
5. Example panel shows root mention, bot-created thread, threaded follow-up, and ignored fresh root message; mobile puts it in a disclosure.

### 06 — People and permissions

Purpose: establish external-to-Paperclip authority before activation.

1. Endpoint sponsor selection explains why a sponsor is required.
2. Linked-user path maps a provider principal to one Paperclip user after confirmation.
3. Unlinked-user path shows the restricted guest profile and allowed operations.
4. Effective-authority formula visibly intersects sponsor, resource, guest, and target controls.
5. Governance actions are explicitly denied to guests; mobile presents the formula as ordered rows.

### 07 — Output and interaction behavior

Purpose: choose what the bot exposes and how it behaves across provider capabilities.

1. Acknowledgement policy selects reaction, ephemeral, or short-message fallback.
2. Progress policy exposes safe milestones and update cadence, never reasoning traces.
3. Output controls cover final text, artifacts, cards, actions, modals, files, and URLs.
4. Command/reaction/edit/delete behavior is capability-aware.
5. Concurrency selects queue by default plus burst, debounce, drop, or concurrent modes.

### 08 — Agent-to-agent routes

Purpose: make bot-to-bot participation an explicit governed exception.

1. Master control is off by default and explains the risk.
2. Directed route chooses a source endpoint, destination endpoint, and permitted resources.
3. Trigger and maximum-hop controls limit when a bot message activates another agent.
4. Loop-protection summary lists self-message, revisit, fingerprint, and hop suppression.
5. Audit preview shows what route provenance is retained.

### 09 — Review and activate

Purpose: provide one comprehensible safety review and a real delivery test.

1. Readback names agent, bot, workspace, resources, people policy, and behavior.
2. Provider checks distinguish credential, signature, webhook, scope, and bot-membership health.
3. Test message instructions verify root mention, provider-thread creation, one Paperclip issue, unmentioned threaded follow-up, and fresh-root silence.
4. Activation control remains disabled until required checks pass.
5. Managed provisioning notice is informational; BYO completion is sufficient.

### 10 — Endpoint overview

Purpose: answer what is connected, whether it works, and what the operator can do.

1. Header binds agent identity, bot identity, provider installation, and endpoint status.
2. Health summary shows provider, ingress/relay, credentials, and last delivery separately.
3. Activity summary counts conversations, active tasks, failed deliveries, and linked people.
4. Test, pause/resume, reconnect, and open-provider actions are available near status.
5. Remove lives in a distinct danger section and describes task/history retention.

### 11 — Endpoint access

Purpose: manage reachable resources and external identities after setup.

1. Resource allowlist supports enable/disable and verification state.
2. Principal table distinguishes linked user, sponsored guest, bot, revoked, and unknown.
3. Link intent produces a one-time URL without exposing credentials.
4. Sponsor and guest profile changes show their effective impact before save.
5. Revocation stops future user attribution but preserves historical audit identity.

### 12 — Endpoint behavior

Purpose: edit the policies chosen during setup with provider fallbacks visible.

1. Activation, provider-thread creation mode, existing-thread binding, and DM policies are grouped by inbound behavior.
2. Queue/overlap policy names the Paperclip run consequence.
3. Progress, streaming, and publication settings are grouped by outbound behavior.
4. Files/interactions/commands/reactions show supported, fallback, or unavailable states.
5. Save creates a versioned policy and previews material changes.

### 13 — Conversations and tasks

Purpose: inspect the external-thread-to-issue binding ledger and prove the one-thread/one-issue invariant.

1. Rows show provider resource/thread, exactly one endpoint-owned Paperclip issue, participant count, subscription, and activity.
2. Filters cover active, waiting, failed, detached, and DM conversations.
3. Selection opens a detail panel with provider and Paperclip backlinks.
4. Detach explains that history remains and future messages may create a new task.
5. Agent assignment is visible but not editable while bound.

### 14 — Deliveries and diagnostics

Purpose: make ingress/publication failures operable without exposing sensitive payloads.

1. Unified ledger filters inbound, outbound, actions, retries, ignored, and failures.
2. Each row shows event kind, thread/task, state, attempt, timing, and dedupe result.
3. Detail drawer contains redacted normalized fields, provider ids, leases, and error/remediation.
4. Replay is authorized, idempotent, and unavailable for successfully applied mutations.
5. Provider rate limit and relay/ingress health sit above the ledger.

### 15 — Agent Channels view

Purpose: see everywhere a particular Paperclip agent can be reached.

1. Agent contextual navigation adds Channels under Runtime.
2. Endpoint cards show provider bot identity, workspace/resources, health, and trigger policy.
3. Recent externally created tasks link into normal task detail.
4. Add channel starts Apps setup with this agent preselected.
5. Empty state explains that the agent still works normally inside Paperclip.

### 16 — Externally bound task

Purpose: preserve normal task work while making channel ownership and publication explicit.

1. Source banner links to provider conversation and endpoint and explains the assignment lock.
2. External participant comments use provider attribution without impersonating a Paperclip user.
3. Agent output shows queued/streaming/delivered/failed publication state.
4. Board composer defaults to internal; **Send to channel** is an explicit option with preview.
5. Assignee control is locked until detach; the confirmation preserves history and warns about future messages.

### 17 — Identity-link flow

Purpose: safely map one provider principal to the currently authenticated Paperclip user.

1. Landing page shows provider identity, bot/endpoint, company, and expiration.
2. Authentication is required before confirmation and returns to the same intent.
3. Confirmation names both identities; no email-based auto-linking occurs.
4. Success explains that future actions use current Paperclip permissions.
5. Expired, used, revoked, company-mismatch, and wrong-account states provide safe remediation.

### 18 — Self-hosted relay

Purpose: let private instances receive provider events without becoming publicly reachable.

1. Direct and relay modes are compared with current reachability detection.
2. Relay enrollment shows a redacted command/config and a one-time secret handoff.
3. Health shows connection owner, heartbeat, backlog, last delivery, and provider verification.
4. Key rotation and revoke controls explain connection interruption.
5. Offline/degraded states distinguish provider acceptance from Paperclip processing.

### 19 — Adapter and state matrix

Purpose: prove the design generalizes beyond Slack and specify shared empty/error language.

1. Provider taxonomy covers workspace apps, comment systems, bot tokens, Meta messaging, phone/iMessage, public social, email, and embedded web.
2. Capability columns cover mentions/messages, stream/edit, cards/actions/modals, commands, emoji, files, DMs, and ephemeral responses.
3. Setup patterns show which fields are generated from the reviewed adapter registry.
4. Maturity states are experimental, preview, stable, unavailable, and revoked.
5. UI states cover loading, empty, degraded, permission denied, unsupported fallback, rate limited, and dead letter.

## 4. Flow map

`wireframes/flow.svg` connects discovery, method choice, the seven setup decisions, activation, endpoint management, agent view, task view, identity linking, relay setup, diagnostics, detach, and rebind. Solid arrows represent the primary operator path; dashed arrows represent identity, relay, failure, and detach branches.

## 5. Copy and state defaults

- Use **channel connection** for the Paperclip configuration and **bot identity** for the provider-visible account.
- Use **external participant** for an unlinked provider human and **linked user** after confirmation.
- Use **sponsored guest** only in permission explanations, not as the person's display name.
- Default activation on thread-capable channels: “Mention this agent in the channel. It opens a thread and one Paperclip issue; continue in that thread without mentioning it again.”
- Existing-thread activation: “Mention this agent in a GitHub issue, pull request, discussion, or another supported existing thread. That thread binds to one Paperclip issue.”
- Conversation fallback: “This provider has no nested threads; this chat or topic is the Paperclip issue boundary.”
- Default overlap: “Queue messages on this task.”
- Default publication: acknowledgement, coarse safe milestones, final agent output, approved artifacts, and interactions; no reasoning trace.
- Default board composer label: “Internal note”; explicit alternate: “Send to channel.”
- Assignment denial: “This task belongs to the channel connection for {agent}. Detach it before assigning another agent.”
- Guest governance denial: “Link your Paperclip account and use an authorized user, or open this action in Paperclip.”
- Unsupported feature: name the text/link fallback rather than only saying “unsupported.”

## 6. Responsive and accessibility requirements

- Desktop wires use the current Paperclip global/contextual sidebar structure and preserve scanning density.
- Mobile wires use a 375×812 canvas, 16px outer margin, a 48px header/action rhythm, and one content column.
- Tables become stacked summary rows or cards; detail drawers become full-height sheets.
- Wizard steps use a compact progress label rather than a horizontally clipped stepper.
- All key state is expressed in text, not color.
- Annotation red is review-only and not part of the proposed UI.
- Provider icons are grayscale placeholders with visible text labels.
- Long ids, timestamps, delivery ids, and secret labels use the eventual machine-value style; wireframes abbreviate them without presenting real secrets.

## 7. Acceptance matrix

Every architecture capability has a visible place:

- discovery/directional choice: 01–02;
- endpoint identity/setup: 03–04;
- resource, identity, and permission configuration: 05–06, 11;
- complete Chat SDK behavior set: 07, 12, 19;
- agent routing: 08;
- verification and lifecycle: 09–10;
- conversation/task binding and publication: 13, 15–16;
- durable delivery operations: 14;
- explicit identity linking: 17;
- private self-host deployment: 18;
- provider differences and edge states: 19.

The initial launch matrix is Slack, Microsoft Teams, Discord, Telegram, and GitHub. Slack and Discord use root-mention thread creation; Teams uses that mode on channel surfaces with stable post/reply threads; GitHub binds an existing issue/PR/discussion thread; Telegram uses the stable chat/topic boundary.

No external provider client is wireframed: those products own their UI. The package specifies the Paperclip surfaces and describes provider-visible behavior in annotations and examples.
