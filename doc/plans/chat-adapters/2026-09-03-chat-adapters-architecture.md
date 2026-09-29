# Paperclip Chat Adapters Architecture

**Status:** decision-complete implementation plan
**Date:** 2026-09-03
**Paperclip base:** `origin/master` at `8430bd897f01dd4b91e0970efffb71b97e5a2685`
**Earlier planning references:** `origin/master` was initially observed at `b872cd3d1b404bdaff70af493a2973ceb7e5d6ec`, then refreshed through `112ef5beecf518ce9e0cbbead3eac297c09fc775`, `b84964e5a2fa8b1e6498a1ccb471f6adba97d470`, `7b094724e65c04949706df638d497afb02c84b62`, and `d593463ab6394cd356bf27448ea28bad8cccf4ec`; the implementation branch is rebased onto the SHA above.
**Research snapshots:** Vercel Chat SDK `51322dde8f4aafd8a7fc7a20cbfd7ae45cafaa5c` (`chat` 4.39.0); OpenTag `6a770d862349f8e996c23c145aef6d6275914a23`

## 1. Decision summary

Paperclip will let a company expose any of its agents through external chat systems without turning those systems into a second control plane. External chat is transport and presentation. Paperclip remains authoritative for agents, tasks, runs, permissions, approvals, budgets, artifacts, liveness, and audit history.

The first release ships Slack, Microsoft Teams, Discord, Telegram, and GitHub. The architecture is registry- and capability-driven so Google Chat, Linear, Notion, WhatsApp, Twilio, X, Messenger, Instagram, email through Resend, iMessage providers, and vetted community adapters can be enabled without redesigning persistence or routing.

The decisive identity choice is **one native bot identity per Paperclip agent endpoint**. A Slack workspace may contain several Paperclip agents, but each is installed as a distinct Slack app/bot and addressed through its native mention. Paperclip will not hide several agents behind one dispatcher bot in v1.

Thread-capable providers use a Hermes-style activation model. A person mentions the bot in the channel's root timeline; the bot creates or opens a native thread rooted at that message, creates exactly one Paperclip issue for its endpoint, and moves the conversation into that thread. Slack and Discord can continue eligible replies in the bound thread without another mention. Teams uses the same post/reply boundary and its required app manifest requests the resource-specific consent needed to deliver unmentioned channel-thread replies; setup cannot complete until the live root-and-reply test proves that grant is effective. GitHub binds an existing issue, pull-request conversation, or inline review-comment thread rather than manufacturing a second GitHub thread.

## 2. Product invariants

1. A channel endpoint belongs to one company, one Apps connection, one adapter, and exactly one Paperclip agent. The endpoint's assigned agent is immutable after creation. Connecting a different agent requires a new connection/endpoint; the setup and connector-detail UI never offers **Change agent**.
2. On a provider with `create_thread_from_root`, a new root-level native mention is an activation envelope: verify it, create or open the provider thread, create the Paperclip issue, reply in the thread, and leave the root timeline quiet except for the provider's normal thread indicator.
3. One bot-owned external thread maps to exactly one Paperclip issue for that endpoint. The binding is idempotent by endpoint plus activation root/thread id. The exceptional case where another Paperclip bot joins through an explicit route still creates a separate related issue because Paperclip preserves single assignment; it may not silently share or steal the first endpoint's issue.
4. Once bound, every eligible human message delivered from that provider thread continues the same Paperclip issue. Slack, Discord, and a correctly installed Teams app need no repeated mention. Paperclip requires and live-verifies Teams RSC rather than exposing a weaker mention-per-turn mode. Telegram privacy-on groups require a reply to the bot or another mention. A fresh unmentioned root message is ignored. A mention inside a pre-existing provider thread may activate that thread when policy allows, but it still yields only one issue binding.
5. Providers without creatable native threads use a declared fallback: use the existing provider conversation/comment thread, or combine the stable conversation with an explicit Paperclip session generation. GitHub uses the existing issue/PR or inline review-comment thread. Telegram forum topics use `message_thread_id`; ordinary Telegram DMs/groups maintain one active issue until `/new`, **New task**, or `/close` advances/closes the binding.
6. A provider's stable direct-message conversation key plus active session generation is the DM issue boundary. The first message creates the active issue; subsequent messages continue it; an explicit new-task action starts a new generation when the provider does not supply multiple native DM threads.
7. The issue remains a normal Paperclip task. Its title, description, status, project, goal, priority, documents, and artifacts remain editable. Its assigned agent is locked to the endpoint agent for the lifetime of the external task. Connecting a different agent requires a new connection and a new external task; there is no normal detach-and-reassign flow.
8. Incoming messages are attributed to an external principal. Linked principals act as their mapped Paperclip user. When enabled in Access, unlinked principals act only through the fixed restricted external profile; the internal sponsoring principal is not a selectable end-user role.
9. Agent execution always uses the assigned Paperclip agent's existing adapter, runtime, permissions, budgets, checkout rules, and approval gates. A channel message never creates a new execution authority.
10. Only a safe, explicitly external publication projection leaves Paperclip. Raw chain-of-thought, internal comments, tool traces, run logs, secrets, hidden activities, and internal identifiers do not.
11. Agent output is eligible for automatic publication. Board comments are Paperclip-only unless their author explicitly chooses **Send to channel**.
12. External agent-to-agent turns are disabled by default. Enabling them requires a directed route, endpoint allowlists, a bounded hop count, self-message suppression, causal fingerprints, and immutable audit events.
13. Bring-your-own provider credentials is sufficient to ship. A managed Add to Slack path can be added later but cannot block the first release.
14. Every active endpoint uses the maximum safe capability set available to its adapter, provider installation, current conversation type, and current Paperclip permission check. Reactions, streaming, rich messages/cards, buttons, modals, commands, files, edits, DMs, and private-response fallbacks are implementation behavior, not per-endpoint on/off settings. Capability negotiation selects the best legal path and degrades unsupported behavior to safe text plus a Paperclip URL; it never bypasses Paperclip authorization.

## 3. Ownership boundary

### 3.1 Native Paperclip chat-adapters subsystem

Chat adapters are part of Paperclip itself, not a bundled or separately installed plugin. The subsystem owns:

- company boundary and actor extraction;
- external-principal authorization contract;
- task creation, single assignment, checkout, wakeup, liveness, and budget gates;
- externally bound task assignment lock and immutable binding lifecycle;
- safe-publication projection and secret/redaction policy;
- attachment ingestion and work-product creation;
- activity records for every mutation;
- public ingress registration and raw-body access needed for signature verification;
- secret references and credential resolution;
- adapter registry and endpoint lifecycle;
- Chat SDK adapter construction;
- provider webhook verification and normalized event conversion;
- provider-thread creation and reconciliation;
- activation/subscription rules;
- conversation and task binding;
- delivery, action, and publication workers;
- provider rendering, streaming, reactions, cards, modals, and fallbacks;
- relay client/server protocol;
- Apps, agent, task, identity-link, and diagnostics UI surfaces;
- first-party schema migrations and lifecycle controls.

### 3.2 Chat SDK

Use Chat SDK for platform-specific normalization and presentation, not as Paperclip's authority. Chat SDK supplies:

- provider adapters and signature helpers;
- mentions, subscribed messages, reactions, slash commands, actions, and modals;
- message/card/file abstractions;
- native streaming where available and post-plus-edit fallbacks elsewhere;
- direct messages and ephemeral-message fallbacks;
- provider capability differences.

Paperclip supplies a database-backed Chat SDK state adapter. In-memory and standalone Redis state may be used in adapter unit tests, but never as the production source of truth for endpoint subscriptions, locks, queues, history, or task bindings.

## 4. Apps model and connection identity

Apps remains the only integration catalog and `/apps` remains the only discovery and setup entry point. Add a `chat_sdk` transport and a `channel` purpose to the connection contract. A provider may expose two separate methods:

- **Chat with an agent** — a channel connection accepting inbound conversation and publishing task output.
- **Use this connection as an agent tool** — the existing tool-connection path, granting provider actions to agents under the existing credential and human-access model.

These methods may share provider branding but never silently share credentials, grants, or identity. The UI must always name which direction is being configured.

The connection-purpose choice is conditional, not a permanent extra wizard step. Show it for every selected provider whose registry entry exposes both chat and tool connection surfaces, not through a provider-name exception. A chat-only provider skips directly to **Which agent do you want to chat with?** using Paperclip's existing single-agent selector. Selection is final for that endpoint.

Provider setup then uses a persistent step-rail wizard with one focused external handoff per phase. The completed agent-selection step remains visible in the rail, but the page body never repeats the selected agent. The wizard preserves completed steps across provider redirects/admin waits and gives every button an explicit consequence. It does not repeat reach, behavior, route, capability, transport, automatic work, or successful verification results. A setup screen may contain only something the operator must click, choose, copy, paste, upload, run, or perform at the provider during that phase. Errors and missing prerequisites appear only when they occur. A successful real provider message completes the connection; **Save & exit** preserves an unfinished draft.

Default installation must minimize exposed credentials while keeping the bring-your-own path complete:

- customer-owned Slack Apps request only Bot User OAuth Token and Signing Secret and treat them as write-only;
- Paperclip generates and stores GitHub's webhook secret, reveals it once for copying to GitHub, and requests only the App ID and private-key PEM;
- Teams requests Client ID, tenant ID, and client secret from the customer-owned Entra App/Azure Bot registration;
- Telegram requests the BotFather bot token because BotFather has no OAuth installation callback.

The customer-owned Slack App path opens a prepared Slack App Manifest, instructs the operator to create and install it, then requests only Bot User OAuth Token and Signing Secret before the channel mention/thread-reply test. A standardized **Add to Slack** handoff may be added later when Paperclip has access to that program; it is optional, may not change runtime authority, and cannot gate the BYO path or release.

All nonessential configuration is post-connect. A chat connection reuses the current connector-detail shell with provider-specific `Settings`, `Access`, `Conversations`, and `Activity` tabs. There is no read-only Overview tab. Settings contain only destination reach that an operator can plausibly change: allowed channels, repositories, chats, or topics, plus direct-message and group-chat toggles where the provider supports those surfaces. The assigned agent, provider account/workspace, task boundaries, activation rules, delivery transport, credentials, installation drift, and response capabilities are not settings.

Provider installation is an availability ceiling, not Paperclip authorization. Slack/Discord/Teams channel membership, Telegram chat membership, and the repositories selected in a GitHub App installation determine the resources whose events the provider can deliver. Paperclip independently enables a subset of those resources. Effective reach is the intersection of provider availability, Paperclip enablement, active endpoint state, and current actor authorization.

The destination used to complete the setup test becomes the connection's first enabled resource because the operator explicitly selected and exercised it. A channel, chat, topic, or repository discovered later appears in Settings as available but disabled. Invitation or installation alone never creates a task or permits a response. Enabling a resource that is not currently available at the provider is rejected with the appropriate provider action, such as **Add Maya to Slack** or **Manage GitHub installation**. Losing provider membership or repository access marks the resource unavailable, blocks new work, and preserves existing task and conversation history.

The management tabs therefore have deliberately separate jobs:

- **Settings** controls where the connection may act inside the provider's available resource set.
- **Access** controls who external people represent. Linked identities use current Paperclip user permissions; allowed unlinked identities use the fixed restricted external profile. The endpoint's sponsoring principal remains an internal authority ceiling and audit field, not ordinary UI configuration.
- **Conversations** is a read-only cross-link list: external conversation, Paperclip task, current state, **Open provider**, and **Open task**. It has no binding controls, detach action, or boundary explainer.
- **Activity** contains delivery health, redacted errors, replay, and contextual repair actions.

The first release makes these product choices instead of exposing policy selectors:

- a root mention in Slack or Teams creates a provider-native thread and one Paperclip task; later replies in that bound thread continue the same task without another mention when the provider delivers them;
- the first mention inside an unbound existing Slack or Teams thread binds that thread to one new task from that point forward and does not import earlier history;
- a DM has one open task at a time; after that task completes, the next message creates a new task, while **New task** or `/new` starts another explicitly;
- a GitHub mention binds the addressed issue, pull-request conversation, or inline review thread to one task;
- Telegram DMs and ordinary groups use one open task at a time, while a forum topic has one stable topic-to-task binding;
- direct verified webhook versus outbound relay is selected by instance deployment and reachability, not by the endpoint operator;
- credential replacement, revoked installations, missing membership, and permission drift appear only as contextual reconnect/repair actions in Activity;
- linked users use current Paperclip permissions, allowed unlinked users receive the fixed restricted external profile, overlapping turns queue, only safe milestones and final output publish, and agent-to-agent routes remain off.

Paperclip always uses the maximum safe provider capability set. Activity owns health, delivery diagnostics, and conditional repair actions. Relay and provider-specific developer transports live under instance administration, not endpoint onboarding.

Each live channel connection has one `chat_endpoints` row. Creating a second bot for another agent creates another connection/endpoint, even inside the same provider workspace. Bot display name and avatar default from the agent, while provider-specific immutable identity fields are displayed separately.

## 5. Persistence model

All records carry `company_id`, timestamps, and appropriate foreign keys. These are first-party Paperclip tables in the normal database schema and migration lifecycle.

### `chat_endpoints`

One-to-one with the parent Apps connection. Fields include adapter slug/version, immutable assigned agent, public endpoint id, provider account/workspace identity, bot identity, internal sponsoring principal, deployment mode (`direct | relay`), lifecycle status (`draft | verifying | active | paused | attention | revoked | archived`), and versioned behavior policy. Credentials are secret references on the parent connection, never inline JSON. The deployment mode is selected by instance reachability/policy and reported to the endpoint; it is not a connector-wizard preference. The sponsoring principal is derived from the connection owner or an instance policy and is not exposed as a normal endpoint setting.

Unique: parent connection; public endpoint id; provider bot identity within an installation where the provider requires it.

### `chat_endpoint_resources`

Provider-available external resources such as Slack channels, Teams conversations, Discord servers/channels, Telegram groups/topics, GitHub repositories, Notion pages, phone numbers, or email domains. Store normalized resource type/id, human label, provider availability (`available | unavailable | removed`), Paperclip enablement, discovery source/time, last verification time, and provider-specific membership/install metadata. Only an available and enabled resource may activate or continue work.

Unique: endpoint plus provider resource type/id.

### `chat_external_principals`

Normalized external users and bots. Store provider tenant/workspace id, provider principal id, principal kind, display metadata, last-seen time, and disabled/deleted markers. Never treat display names or email addresses as identity keys.

Unique: company, adapter, provider tenant, provider principal id.

### `chat_identity_links`

Explicit mapping from an external principal to one Paperclip user, with creator, confirmation time, revocation, and last authorization check. Links are company-scoped and never inferred from matching email alone.

Unique: company plus external principal. A principal has at most one active Paperclip-user mapping in a company.

### `chat_conversations`

Maps endpoint plus normalized external conversation/thread identity to one Paperclip issue. Store conversation kind, thread activation mode, activation root message/event id, provider thread id, provisioning state, subscription state, activation source, issue id, lifecycle (`active | completed | unavailable | endpoint_removed`), latest inbound/outbound ids, and timestamps. A provisional row keyed by the root activation survives a crash between Paperclip issue creation and provider-thread creation and lets reconciliation finish without duplicating either side. Lifecycle changes never unlock agent reassignment or erase the historical link.

Unique: endpoint plus activation root message id; endpoint plus external conversation/thread id. An issue has at most one active binding for the same endpoint.

### `chat_deliveries`

Durable inbound ledger. Store provider event id, normalized kind, raw payload digest, a bounded/redacted normalized envelope, receipt time, processing state (`received | processing | applied | ignored | retrying | failed | dead_letter`), attempt count, lease, result references, and redacted error. The raw provider payload is retained only when explicitly enabled with bounded TTL and encryption.

Unique: endpoint plus provider event id; otherwise endpoint plus deterministic payload fingerprint for providers without stable event ids.

### `chat_message_links`

Maps an inbound comment/action or outbound publication to provider message ids. Store direction, message/thread ids, revision, deletion state, and the Paperclip comment/publication/action reference.

### `chat_publications`

Durable outbound outbox. Store source kind/id, safe payload version, idempotency key, target conversation, rendering plan, lifecycle (`queued | streaming | posted | edited | delivered | retrying | failed | suppressed`), attempt data, and provider result.

Unique: endpoint plus idempotency key.

### `chat_actions`

Stores action/button/select/modal/slash-command callbacks with action id, principal, target interaction or command, payload digest, permission result, exact-once result, and provider acknowledgement.

Unique: endpoint plus provider action id or callback fingerprint.

### `chat_agent_routes`

Directed source-endpoint to destination-endpoint rules. Store activation mode, permitted external resources, maximum hop count, enabled state, and creator. Reject self-routes and cross-company routes.

### `chat_endpoint_leases`

Short durable leases for delivery processing, per-conversation sequencing, publication streaming, and relay ownership. A lease has resource kind/key, owner, fencing token, heartbeat, and expiry.

Unique: endpoint plus resource kind/key.

### `chat_sdk_state`

Versioned endpoint-scoped key/value records for Chat SDK state that cannot safely be derived. Known categories are subscriptions, provider cursors, adapter history, and SDK locks. Keys are bounded and values are schema/version checked.

## 6. Shared contracts and APIs

### 6.1 Shared types

Add stable shared types for:

- `ChatAdapterSlug`, `ChatAdapterMaturity`, and `ChatAdapterCapabilities`;
- `ChatEndpoint`, `ChatEndpointStatus`, and redacted endpoint summaries;
- normalized event kinds: root mention, thread message, subscribed message, DM, reaction, file, edit, delete, action, modal, slash command, lifecycle;
- `ChatActivationPolicy`, `ChatThreadPolicy`, `ChatDmPolicy`, `ChatConcurrencyPolicy`, `ChatProgressPolicy`, `ChatFailurePolicy`, and `ChatPublicationPolicy`;
- thread capabilities and modes: `create_thread_from_root | use_existing_thread | conversation_is_thread`, plus provider thread provisioning/reconciliation state;
- `ExternalPrincipalRef` and external actor attribution;
- safe publication text, artifact, card, interaction, and link blocks;
- delivery/publication state and redacted diagnostics;
- agent-route source stamps and hop metadata;
- adapter setup fields derived from a pinned Chat SDK catalog snapshot.

### 6.2 Company and endpoint APIs

All authenticated APIs are under `/api`, company-scoped, and use existing HTTP/error conventions.

```text
GET|POST  /companies/:companyId/chat/endpoints
GET|PATCH|DELETE /chat/endpoints/:endpointId
POST      /chat/endpoints/:endpointId/test
POST      /chat/endpoints/:endpointId/pause
POST      /chat/endpoints/:endpointId/resume
POST      /chat/endpoints/:endpointId/reconnect
GET|PUT   /chat/endpoints/:endpointId/resources
GET|PUT   /chat/endpoints/:endpointId/behavior
GET       /chat/endpoints/:endpointId/principals
POST      /chat/endpoints/:endpointId/principals/:principalId/link-intent
DELETE    /chat/endpoints/:endpointId/principals/:principalId/link
GET|PUT   /chat/endpoints/:endpointId/routes
GET       /chat/endpoints/:endpointId/conversations
GET       /chat/endpoints/:endpointId/deliveries
POST      /chat/endpoints/:endpointId/deliveries/:deliveryId/replay
GET       /chat/endpoints/:endpointId/publications
GET|POST  /chat/endpoints/:endpointId/relay
POST      /chat/endpoints/:endpointId/relay/rotate-key
DELETE    /chat/endpoints/:endpointId/relay
```

### 6.3 Public ingress and linking

```text
POST /api/chat/webhooks/:publicEndpointId
GET  /chat/link/:oneTimeToken
POST /api/chat/link/:oneTimeToken/confirm
```

The endpoint id is random and unguessable but is not treated as the authentication secret. Each adapter verifies the provider signature/token against the exact raw request body before a delivery becomes processable. Verification challenges are handled without starting a task.

One-time identity links are short-lived, single-use, bound to company/endpoint/principal, and completed only after Paperclip authentication. The confirmation page displays both identities and the target company before mutation.

### 6.4 Task APIs

Task responses include a derived, redacted `externalChannelBinding` summary. Add operations to inspect the immutable binding and explicitly publish a board-authored comment or existing eligible output.

```text
GET  /issues/:issueId/chat-binding
POST /issues/:issueId/chat-publications
```

Attempting to change `assigneeAgentId` on an externally connected task returns `409 chat_binding_agent_locked` with a safe explanation that a different agent requires a new connection. Removing an endpoint or losing provider access changes the binding lifecycle to unavailable but does not unlock reassignment or erase attribution, messages, publications, or activity.

## 7. Durable event flows

### 7.1 Inbound message

1. Resolve the public endpoint and read the raw request under strict size/time limits.
2. Verify the provider signature/token before parsing untrusted fields for routing.
3. Insert the delivery ledger row and return the provider's acknowledgement within its deadline. Slow work continues from the durable row.
4. Claim the delivery with a fencing lease; duplicate claims return the existing result.
5. Normalize event, tenant, resource, conversation, thread, sender, attachments, and causal ids through Chat SDK.
6. Resolve or create the external principal. Suppress self messages and known outbound echoes.
7. Enforce endpoint status, provider availability, Paperclip resource enablement, rate limits, route policy, and principal authorization. A valid event from an available but disabled resource is recorded as ignored with only the minimum safe metadata; it creates no task, wakes no agent, and sends no response.
8. Apply the adapter's thread policy. For a root mention on Slack, Discord, or a thread-capable Teams channel, claim an activation lease keyed by endpoint plus root event/message id. For GitHub, claim the existing issue/PR/discussion thread. Unaddressed fresh root messages are recorded as ignored.
9. Transactionally create the assigned Paperclip issue and a provisional conversation row before any non-idempotent provider call. The issue includes source metadata and a backlink, but no provider secret.
10. Create/open the native provider thread through Chat SDK and finalize the binding. On Slack, the first bot reply under the root message establishes the thread; on Discord, create a native thread; on Teams, reply within the stable channel-post thread when supported. A crash leaves a reconcilable provisional binding rather than a second issue.
11. For an already bound provider thread, append every eligible human reply to the same issue without requiring another mention. A mention inside an unbound pre-existing thread may bind it once when endpoint policy allows.
12. Persist the incoming message/attachment as an issue comment or typed interaction with immutable external attribution.
13. Use Paperclip's normal wakeup path. Existing checkout, active-run, budget, pause, and liveness rules decide whether work queues, steers, or waits.
14. Publish the acknowledgement and all later output inside the bound provider thread. Use a reaction only as an optional immediate receipt; otherwise use ephemeral or concise threaded output. Record every mutation and final delivery state.

### 7.2 Thread activation modes

| Mode                      | Providers                                                                                                                               | Activation and binding                                                                                                                                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create_thread_from_root` | Slack, Discord, thread-capable Teams channels                                                                                           | A root `@bot` mention creates/opens a native thread and exactly one endpoint-owned Paperclip issue. All output stays in that thread; follow-ups continue there when delivered under the provider's mention/subscription/RSC rules. |
| `use_existing_thread`     | GitHub issues, pull-request conversations, inline review-comment threads; providers where the mention is already inside a native thread | The addressed existing thread becomes the external boundary and maps once to one endpoint-owned Paperclip issue.                                                                                                                   |
| `conversation_is_thread`  | Telegram chats/topics and providers without nested threads                                                                              | A stable topic maps directly; a linear chat combines its stable key with an active session generation advanced by **New task**/`/new`. Activation copy makes the broader visibility explicit.                                      |

Thread creation is capability-driven, never inferred from provider name alone. The registry records whether a surface can create a thread, whether the root message itself is the thread key, and whether bot replies, edits, files, actions, and streaming are legal inside it.

### 7.3 Outbound publication

1. An eligible agent result, interaction, or explicit board **Send to channel** action emits an outbox candidate.
2. The safe-projection service validates visibility and produces a versioned payload containing only external text, approved links, sanitized artifacts, and supported interactions.
3. The publication worker claims the per-conversation lease and renders against adapter capabilities.
4. Prefer native streaming where supported. Otherwise post a working message and edit it at a bounded cadence. If editing is unsupported, post coarse milestones and one final response.
5. Store provider ids after every acknowledged send. Retries use the same idempotency key and edit the known message where possible.
6. On success, link the provider message to the Paperclip source. On terminal failure, retain a visible diagnostic and Paperclip retry control without mutating the task result.

### 7.4 Interactive callback

1. Verify and durably record the action exactly like other ingress.
2. Resolve the external principal and its current Paperclip mapping.
3. Re-read the target task/interaction and its current resolver audience or approval policy.
4. Authorize as the linked Paperclip user. An allowed unlinked principal may answer only non-governed interactions allowed by the restricted profile; it cannot approve, hire, spend, change permissions, change budgets, or reassign agents.
5. Apply the Paperclip mutation transactionally and exactly once. Resolution never implies authorization for its downstream effect.
6. Return an ephemeral/card update where supported or a text result with a Paperclip URL.

## 8. Identity and permission model

### Linked principals

A linked principal becomes a Paperclip user actor only after explicit confirmation. Every action is reauthorized using current membership and permissions; a stale link conveys no cached authority. Activity includes provider/tenant/principal, Paperclip user, endpoint, delivery/action id, and authorization result.

### Restricted external principals

Every endpoint has an internal sponsoring principal and a versioned restricted external profile. The sponsoring principal is derived from the connection owner or instance policy; it is an audit and authority ceiling, not an Access-tab choice. Effective unlinked authority is the intersection of that ceiling, the enabled endpoint resource, restricted-profile operations, and target-state constraints. The initial allowlist is limited to starting/continuing the endpoint's bound task, uploading allowed attachments, and answering explicitly guest-resolvable non-governed questions. Unlinked people cannot use Paperclip as a general API principal and cannot govern the company. The Access tab exposes only whether unlinked participation is allowed and the explicit linked-identity list.

### Agent messages

Messages from another Paperclip bot resolve as external bot principals. They are ignored unless a matching directed route is active. Routed events carry an immutable origin endpoint, publication id, route id, visited endpoint set, and hop count. The receiving endpoint creates/continues its own task. Exceeding the hop limit, revisiting an endpoint, repeating a causal fingerprint, or targeting the source endpoint suppresses the event and writes audit evidence.

## 9. Chat SDK feature policy

The table below is an implementation contract, not a menu of endpoint toggles. For each publication or callback, Paperclip intersects adapter capabilities, provider installation/permission health, conversation type, safe-publication rules, and the current actor's Paperclip authority. It then uses the most capable legal rendering or interaction path automatically.

| Feature                      | Paperclip behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mentions and thread messages | A root mention creates/opens a provider thread and one issue when supported; later messages in that thread continue without mentions; fresh unaddressed root messages are silent.                                                                                                                                                                                                                                                                                                                   |
| Streaming                    | Safe text only; native stream, draft preview, or post/edit fallback selected per adapter.                                                                                                                                                                                                                                                                                                                                                                                                           |
| Cards                        | Render safe artifacts, status, questions, approvals, and links; fall back to text plus Paperclip URL.                                                                                                                                                                                                                                                                                                                                                                                               |
| Actions/dropdowns            | Resolve typed Paperclip interactions after identity and permission checks.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Modals                       | Use for provider-supported forms; validate again server-side and fall back to link.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Slash commands               | Map registered commands to explicit chat-subsystem operations where the adapter exposes command events. Slack `status`, `new`, and `close` controls are DM-scoped because Slack's slash-command payload has a channel id but no native thread timestamp; channel work remains managed from its mention-created thread and Paperclip task link. On Telegram, parse the small `/new`, `/status`, and `/close` vocabulary as ordinary messages. Never treat arbitrary command text as board authority. |
| Emoji/reactions              | Use a provider-safe acknowledgement vocabulary; custom emoji is optional.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Files                        | Inbound files use bounded sanitized attachment ingestion; outbound files use signed, expiring content URLs or provider upload.                                                                                                                                                                                                                                                                                                                                                                      |
| Direct messages              | One open task is active per DM conversation. After completion, the next inbound message creates a new task; **New task** or `/new` starts another explicitly. Proactive DM requires endpoint policy and target authorization.                                                                                                                                                                                                                                                                       |
| Ephemeral messages           | Preferred for denials, link prompts, and private receipts; fall back to DM or safe public text.                                                                                                                                                                                                                                                                                                                                                                                                     |
| Overlap/concurrency          | Support burst, queue, debounce, drop, and concurrent modes; default to queue and serialize task mutation.                                                                                                                                                                                                                                                                                                                                                                                           |
| Edits/deletes                | Map provider edits/deletes to append-only correction/tombstone events; never silently rewrite audit history.                                                                                                                                                                                                                                                                                                                                                                                        |

Safe progress states are `queued`, `working`, `waiting_for_input`, `approval_needed`, `completed`, and `failed`. They may name the current task phase or public artifact, but not private prompts, hidden tools, internal logs, or chain-of-thought.

## 10. Deployment model

### Direct mode

Paperclip exposes `/api/chat/webhooks/:publicEndpointId` at a stable HTTPS origin. This is selected automatically for cloud and publicly reachable authenticated/self-hosted instances. Provider credentials and signing material are secret references. Health checks confirm reachability, credential validity, subscription state, and a real test event. The endpoint wizard never asks the user to choose “direct webhook.”

### Relay mode

A private instance opens an outbound authenticated WebSocket to a lightweight relay. Providers send to the relay; the relay verifies its outer endpoint binding and forwards an encrypted, bounded envelope. Paperclip still performs provider signature verification before processing. The relay retains only retry metadata and encrypted payloads for a short configured TTL, has no Paperclip user credential, and cannot invoke arbitrary APIs. Fenced endpoint ownership prevents two connected instances from consuming one delivery. Instance administration selects/configures relay once; individual endpoint wizards inherit it automatically.

### Non-shipped managed installation

Bring-your-own provider credentials are the required first-release default. Managed Slack or GitHub provisioning may later reduce credential handling, but these are optional conveniences rather than separate runtime or permission models and cannot block activation or release.

Slack Socket Mode and Telegram polling are not ordinary endpoint choices. They are instance-level developer/on-premises escape hatches used only when the deployment cannot accept provider callbacks and has no configured relay. Enabling either requires explicit instance administration and provider-specific credentials; normal connector setup continues to say only that delivery is automatic.

## 11. Delivery phases

1. **Core contracts and mock adapter:** shared types, first-party schema and migrations, Paperclip state adapter, public ingress, delivery/outbox workers, safe projection, thread-provisioning state machine, and exhaustive mock-provider tests.
2. **Apps and task surfaces:** extend the existing `/apps` setup shell with the registry-driven conditional purpose choice, immutable single-agent selector, persistent provider step rail, resumable external handoffs, and documented action consequences; add chat-specific connector-detail navigation, the agent Channels view, task binding banner, identity linking, and diagnostics. Delivery and capability mechanics never become onboarding questions.
3. **Slack:** implement the complete guided customer-owned App path, signed callbacks/relay inheritance, root-mention-to-thread activation, one-thread/one-issue binding, threaded follow-ups, DMs, reactions, files, streaming/edit fallback, cards/actions/modals/commands, and a real-workspace harness. Add to Slack remains optional when platform access becomes available.
4. **Teams, Discord, Telegram, and GitHub:** implement adapter-specific setup and capability tests against the same contracts. Teams and Discord exercise native thread behavior; Telegram exercises active linear-chat generations and forum-topic boundaries; GitHub exercises existing issue/PR/review-comment bindings. GitHub Discussions are deferred unless adapter support is added and tested.
5. **Private relay:** outbound registration, rotation, reconnect, backlog limits, and failover diagnostics.
6. **Agent routes:** directed allowlists, causal stamps, loop/hop protection, and multi-bot channel tests.
7. **Catalog expansion:** enable official and reviewed vendor/community adapters by capability and maturity; no schema redesign.
8. **Managed provisioning expansion:** broaden Slack organization deployment and other provider-managed installation paths without changing endpoint identity, task, permission, or transport contracts.

Each phase ships behind endpoint-level maturity flags (`experimental | preview | stable`). Migrations are additive. Pausing an endpoint or disabling chat adapters at the instance level stops new ingress/publications but preserves tasks, comments, attachments, and audit history.

## 12. Test and release gates

The live provider procedure, fixture identities, evidence contract, negative permission cases, cleanup, and per-platform browser steps are defined in [`2026-09-04-chat-adapters-browser-e2e-runbook.md`](./2026-09-04-chat-adapters-browser-e2e-runbook.md). That runbook is the stable-adapter acceptance gate; the lower-level tests below remain independently required.

- Company-boundary tests for every record, API, webhook lookup, replay, identity link, resource-enable action, and route.
- Raw-body signature fixtures and replay/deduplication races for each adapter.
- Transaction and crash-reconciliation tests for root mention, provider-thread creation, one-issue binding, existing-thread activation, immutable assignment locks, and endpoint/resource removal.
- Linked-user, revoked-link, unlinked-disabled, restricted-external, sponsoring-principal-revoked, low-trust, governance-denied, and stale-target authorization tests.
- Publication redaction tests proving secrets, raw traces, hidden comments, and internal-only artifacts never render.
- Retry/idempotency tests for receipt-before-ack, worker crash, provider timeout, duplicate callback, stream resumption, and edit fallback.
- Concurrency tests for all five overlap modes with Paperclip task mutation serialized correctly.
- Attachment tests for size, type, checksum, malware/sanitization hooks, signed URLs, and provider expiration.
- Agent-route tests for default deny, directed allow, self suppression, repeated causal fingerprint, hop bound, and two bots sharing one provider thread.
- Direct and relay deployment tests, including relay disconnect/backlog/credential rotation and competing consumers.
- UI tests for setup, provider-available versus Paperclip-enabled reach, permissions, identity linking, immutable task assignment, explicit publication, conversation cross-links, diagnostics, empty/error/revoked states, and responsive layouts.
- Live smoke per stable adapter: root mention, provider thread creation/opening, exactly one issue, unmentioned threaded follow-up, silent fresh unmentioned root message, DM continuation, file, interaction, progress/final publication, duplicate event, and permission denial.

The first stable release is complete when an operator can connect any active Paperclip agent to Slack, Teams, Discord, Telegram, or GitHub; explicitly enable a subset of provider-available resources; an addressed native thread/object or explicit linear-chat session in that subset creates exactly one bound Paperclip issue for that endpoint; eligible follow-ups continue it using the provider's documented reply/mention rule; the existing Paperclip agent runs it under normal governance; safe output and artifacts return to the same conversation; failures are diagnosable and retryable; and every state transition is auditable. The provider-specific setup, permission, boundary, and fallback contract is maintained in `2026-09-04-chat-adapters-platform-surfaces.md`; the current navigation and UI inventory is maintained in `2026-09-04-chat-adapters-ui-surfaces-v8.md` and `index.html`.
