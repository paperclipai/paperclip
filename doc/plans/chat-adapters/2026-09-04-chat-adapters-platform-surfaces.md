# Chat Adapters — Platform-specific Surfaces

**Status:** detailed wireframe companion
**Date:** 2026-09-04
**Paperclip base:** `origin/master` at `8430bd897f01dd4b91e0970efffb71b97e5a2685`
**Chat SDK snapshot:** `51322dde8f4aafd8a7fc7a20cbfd7ae45cafaa5c`
**Viewer:** `index.html` in this directory
**Generated wires:** 35 four-provider surfaces in `wireframes-v8/`; Discord is the current implementation addendum below
**Current UI companion:** `2026-09-04-chat-adapters-ui-surfaces-v8.md`
**Minimum setup specification:** `2026-09-04-chat-adapters-minimum-setup-v6.md`
**Live browser acceptance:** `2026-09-04-chat-adapters-browser-e2e-runbook.md`

## 1. Shared frame, provider-owned differences

The shared product flow remains deliberately small:

`/apps` → purpose only for a dual-purpose registry entry → choose one immutable agent → provider step-rail wizard → connected.

The provider handoff may have several resumable phases because Slack, GitHub, Microsoft Teams, Discord, and Telegram require different external actions. Each setup page shows only things the operator must click, choose, copy, paste, upload, run, or perform at the provider. The page body never repeats the selected agent and never describes Paperclip's automatic work or successful checks. Errors and missing prerequisites appear only when they occur.

After connection, the existing connector detail shell provides provider-specific **Settings**, **Access**, **Conversations**, and **Activity** tabs. The read-only Overview tab is removed. Settings contains only destination reach that an operator can plausibly change. Task boundaries, provider identities, delivery, credentials, installation drift, and response capabilities are product behavior or contextual Activity repairs—not settings.

The runtime always uses the maximum safe provider capability set. Reactions, streaming, rich messages/cards, buttons, modals, commands, files, edits, DMs, and private-response fallbacks are not per-endpoint feature toggles. Availability is negotiated from the pinned adapter, provider installation and permission health, conversation type, safe-publication policy, and current Paperclip authorization. In the first wave, agent-authored questions and confirmations may degrade to actionless text plus a Paperclip URL when a safe native control is unavailable. Richer Paperclip governance interactions remain Paperclip-only until their complete partial-resolution, terminal-settlement, and recovery semantics are implemented; the connector never emits a provider card it cannot later settle.

The current setup wireframes use the supplied reference image only for its persistent step rail, completed checkmarks, one active phase, and bottom actions. They do not copy its text or function. Provider settings remain ordinary full-width vertical sections and rows. Provider-native interaction models remain behavioral documentation below; the former standalone walkthrough screens are removed because they are not product pages.

### Shared reach and access model

The provider and Paperclip enforce different layers:

1. **Provider availability ceiling:** Slack/Teams/Telegram/Discord decide where the bot is installed or invited; a GitHub App installation decides which repositories are available. Provider permissions and membership determine which events can reach Paperclip at all.
2. **Paperclip resource enablement:** a Paperclip administrator enables a subset of those available channels, chats, topics, or repositories in Settings. An invitation alone is not authorization to create or continue a task.
3. **Actor authorization:** after resource enforcement, a linked identity acts as its current Paperclip user. If the Access toggle allows unlinked people, they receive only the fixed restricted external profile and cannot approve, change budgets, hire, manage permissions/connections, or reassign agents.

The successful setup-test destination becomes the first enabled resource. Newly discovered provider resources appear disabled until explicitly enabled. Provider removal makes a resource unavailable and blocks new work without erasing its tasks or conversation history. Settings therefore answers **where may this bot work?** Access answers **who does this external person represent, and what authority applies?**

Conversations is only a cross-link list. Every row shows the external conversation, Paperclip task, current state, **Open provider**, and **Open task**. There are no binding actions, detach control, detached section, or task-boundary explainer.

| Platform        | External install object                                                 | Default conversation boundary                              | Default activation                            | Output shape                                                             |
| --------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------ |
| Slack           | Slack app installed to workspace/Grid org                               | Root message's Slack thread; stable DM conversation        | Root `@bot`; replies continue in bound thread | Native stream or post/edit, Block Kit, files, actions, modals, ephemeral |
| GitHub          | GitHub App installation on selected repositories                        | Existing issue, PR conversation, or inline review thread   | `@bot` comment in allowed object              | GFM comment/reaction/edit; links for files and governed actions          |
| Microsoft Teams | Entra/bot registration plus customer-owned Teams app installed to scope | Channel post/replies; stable DM or group-chat conversation | Direct mention by default                     | Post/edit output; Adaptive Cards/task modules; authenticated file links  |
| Discord         | Discord application bot installed in one server                         | Created public thread; stable DM conversation              | Root `@bot`; replies continue in bound thread | Post/edit, embeds, buttons, reactions, native files                      |
| Telegram        | BotFather bot token plus chat membership                                | Active DM/group binding or forum topic                     | DM message; group `@bot` or reply to bot      | Throttled post/edit, optional DM drafts, inline buttons, media           |

## 2. Slack

The [pinned Chat SDK Slack adapter](https://github.com/vercel/chat/blob/51322dde8f4aafd8a7fc7a20cbfd7ae45cafaa5c/packages/adapter-slack/README.md) supports single-workspace tokens, multi-workspace OAuth, Enterprise Grid, webhook and Socket Mode ingress, Block Kit interactions, files, DMs, ephemeral replies, and native streaming. Slack independently requires signed-request validation and prompt acknowledgement of [Events API](https://docs.slack.dev/apis/events-api/) and [interactive](https://docs.slack.dev/interactivity/handling-user-interaction/) payloads.

### Setup and external handoff — screen 13

The required customer-owned-App path has two Paperclip screens:

1. **Connect Slack app:** open Slack's app-from-manifest flow, create and install the prepared customer-owned App, then enter its Bot User OAuth Token and Signing Secret write-only in Paperclip.
2. **Try Maya:** open a channel, invite Maya if Slack asks, post a root `@Maya` test message, and reply once in Maya's new thread.

The prepared-App flow contains only required work:

1. Open Slack's app-from-manifest URL, choose the workspace, create the prepared App, then install it from **OAuth & Permissions**.
2. Copy **Bot User OAuth Token** and **Signing Secret** from the documented Slack settings locations and paste those two values into Paperclip.
3. Converge on the same channel mention/thread-reply test.

A managed **Add to Slack** authorization flow is an optional future convenience. It is not shipped, cannot replace the customer-owned-App path, and cannot gate release.

Direct callback versus relay is selected automatically from instance reachability. Socket Mode is removed from endpoint onboarding and exists only as an instance-admin escape hatch when neither a callback nor relay is available. See the minimum-setup specification for the exact effect behind every button.

### Post-connect settings — screen 14

- **Channels:** list channels where the installed bot is already a member and let a Paperclip admin enable or disable each one. The workspace cannot change and appears only as context in channel labels. A later Slack invitation makes a channel available but leaves it disabled until enabled here.
- **Add Maya to another Slack channel:** opens the provider instructions; it changes Slack membership, not Paperclip enablement.
- **Allow direct messages:** one on/off toggle.
- **Fixed behavior:** a root mention creates a Slack thread and one Paperclip task. Replies in that thread continue the task without another mention. The first mention in an existing unbound thread binds that thread without importing earlier history. Fresh unmentioned roots are ignored.
- **Activity repairs:** invalid tokens, missing membership, revoked OAuth, or scope drift appear with a contextual reconnect, invite, or reinstall action only when the condition exists.

Delivery transport, credential rotation, installation drift, task boundaries, receipts, progress, streaming/post-edit output, Block Kit, actions, modals, commands, files, and ephemeral fallbacks do not appear in Settings.

### Runtime interaction model (not a product screen)

1. Ari writes `@maya investigate the refund timeout` as a channel root message.
2. Paperclip verifies the Slack signature, creates the durable delivery, deduplicates the event ID, resolves Ari, checks channel reach/authority, and acknowledges within Slack's deadline.
3. Maya reacts or posts a short receipt under the root. The root's `thread_ts` becomes the external key and binds exactly one issue assigned to Maya.
4. Ari's later thread replies, files, buttons, or modal submissions become turns on that issue. Reactions are deduplicated observational activity only and never create a comment, wake an agent, or convey authority. A modal-opening callback uses a fast acknowledgement path before durable follow-up because Slack trigger IDs expire quickly.
5. Safe output streams or edits inside the thread. Stop/actions resolve through Paperclip permissions. The final publication records its provider message ID; failures become a retryable Paperclip publication, never leaked internal traces.

## 3. GitHub

The [pinned Chat SDK GitHub adapter](https://github.com/vercel/chat/blob/51322dde8f4aafd8a7fc7a20cbfd7ae45cafaa5c/packages/adapter-github/README.md) treats issues and PRs as threads and supports issue/PR/review-comment webhooks. GitHub recommends selecting the [minimum GitHub App permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app) and lets installers restrict an app to selected repositories.

### Setup and external handoff — screen 16

The required customer-owned-App path has three screens:

1. **Create or connect GitHub App:** copy Paperclip's webhook URL and one-time generated webhook secret into a customer-owned GitHub App, grant the exact required permissions/events, then enter the App ID and private-key PEM write-only in Paperclip.
2. **Choose repositories:** use GitHub's installation UI to choose the account/organization and all or selected repositories, then install the customer-owned App.
3. **Try Maya:** mention the App in an installed issue or pull request and add another comment to continue the same Paperclip task.

New and existing GitHub Apps use the same manual credential path. Paperclip generates and stores the webhook secret, shows it once for copying to GitHub, and never returns it from normal endpoint reads. The operator supplies only App ID and the PEM file after configuring GitHub. A GitHub App Manifest create-and-return exchange is an optional future convenience and cannot gate release. A PAT is absent from the product setup flow. The chat-purpose App never requests Contents, Actions, Administration, or other code/tool permissions.

### Post-connect settings — screen 17

- **Repositories:** list repositories available to the GitHub App installation and let a Paperclip admin enable or disable each one. A repository added to the installation appears disabled until enabled here.
- **Manage GitHub installation:** opens GitHub's repository-selection UI; it changes provider availability, not Paperclip enablement.
- **Fixed behavior:** direct mention binds an issue, PR conversation, or inline review thread. Those three provider objects use distinct external keys. Label activation and trusted-author automation are omitted from the first release.
- **Activity repairs:** suspended installations, invalid private keys, webhook failures, or permission drift expose contextual repair actions only when detected.

GitHub host, App identity, private keys, surfaces, activation policy, delivery, reactions, GFM output, edits, attachments, and Paperclip-link fallbacks do not appear in Settings. GitHub Discussions remain outside the launch promise until implemented and tested.

The current GitHub chat adapter is text-only for inbound content. A URL written in an issue, pull-request, or review comment remains ordinary comment text; Paperclip does not fetch it, ingest it as a file, or treat it as an attachment. Outbound work products use authenticated Paperclip links because GitHub chat has no native file-upload surface.

### Runtime interaction model (not a product screen)

1. Ari mentions `@maya` in an allowed issue comment, PR conversation comment, or inline review thread.
2. Paperclip validates `X-Hub-Signature-256`, claims the delivery ID, resolves the GitHub principal and installation/repository, applies reach and permission checks, and ignores the app's own comments.
3. The existing GitHub object/thread binds once to a Paperclip issue. The PR conversation and an inline review-comment thread can therefore map to separate Paperclip issues even inside the same PR.
4. Maya adds a receipt reaction and posts one GFM progress comment. Updates edit that comment at a coarse cadence; the final response replaces or completes it.
5. Supported questions and confirmations become explanatory GFM plus a Paperclip URL because GitHub has no native governed-action surface. Richer governance interactions remain Paperclip-only. A request to inspect or modify code runs only if the separately granted GitHub tool connection permits it.

## 4. Microsoft Teams

The [pinned Chat SDK Teams adapter](https://github.com/vercel/chat/blob/51322dde8f4aafd8a7fc7a20cbfd7ae45cafaa5c/packages/adapter-teams/README.md) supports personal, team, and group-chat conversations, Adaptive Cards, targeted messages, and request-scoped DM streaming. Paperclip's production webhook path defers work into its durable queue, so that request-scoped streamer is no longer available when output publishes: the shipped endpoint therefore advertises `nativeStreaming: false` and uses bounded post/edit behavior on every Teams surface. The pinned transport has no production-safe deferred binary-upload contract, so outbound files use authenticated Paperclip task links on every Teams surface; inbound Teams file references are not ingested without a separate Microsoft Graph connection. Microsoft's [Teams app registration quickstart](https://learn.microsoft.com/en-us/microsoftteams/platform/teams-sdk/get-started/quickstart-register) covers the customer-owned app/bot infrastructure, public endpoint, Teams app configuration, and tenant installation policy.

### Setup and external handoff — screen 19

The required path is customer-owned and has two Paperclip screens around provider-owned registration:

1. **Connect Teams app:** copy Paperclip's messaging endpoint; create the single-tenant Entra App, client secret, Azure Bot, and customer-owned Teams app in Microsoft's portals; apply the displayed bot scopes and resource-specific consent entries; then enter Application/Client ID, Directory/Tenant ID, and client secret in Paperclip.
2. **Try Maya:** publish or upload the customer-owned Teams app according to tenant policy, install it in the intended scope, start a new channel post, mention Maya, and reply once beneath the post.

Paperclip does not generate a Teams package or claim to create an install link. It provides an exact Entra, Azure Bot, Teams Developer Portal, and Teams upload field map plus a copyable block of the Paperclip-specific manifest fields. Teams Developer Portal or equivalent Microsoft tooling still owns the complete app metadata, icons, package, publication, approval, and installation. No provisioning helper is shipped or required.

The basic setup does not request organization-wide Graph directory or chat history access. Public versus sovereign cloud and advanced identity are deployment/tenant concerns surfaced only when a real incompatibility occurs. Installation policy and Microsoft admin consent stay inside Microsoft's install experience.

### Post-connect settings — screen 20

- **Channels:** list channels in teams where Maya is installed and let a Paperclip admin enable or disable each one. Tenant and bot identity cannot change; the tenant appears only as channel context. A later Teams installation appears disabled until enabled here.
- **Add Maya to another team:** opens provider instructions; it changes Teams availability, not Paperclip enablement. Channels in the newly installed team then appear disabled in Paperclip.
- **Allow direct messages:** one on/off toggle.
- **Allow group chats:** a separate on/off toggle, off by default.
- **Fixed behavior:** a root channel mention and the replies beneath that post map to one Paperclip task. A personal or group chat has one open task at a time. The next message after completion starts a new task; **New task** starts another explicitly.
- **Activity repairs:** app removal, consent revocation, invalid identity, or endpoint failures expose contextual repair actions only when detected.

RSC, Graph history/directory access, task boundaries, delivery, identity strategy, consent summaries, Adaptive Cards, buttons, task modules, files, reactions, typing, streaming, and buffered/edit behavior do not appear in Settings. Paperclip requests only the minimal provider permission required for the fixed addressed-thread behavior; if Microsoft cannot deliver an unmentioned reply, the conversation asks the person to mention Maya again rather than exposing a policy setting.

### Runtime interaction model (not a product screen)

1. **Channel:** Ari mentions Maya in a new channel post. That root post and its replies are the native thread and bind one Paperclip issue.
2. **DM/group chat:** the stable Teams conversation has one open Paperclip task. After it completes, the next message starts another; **New task** starts another explicitly without pretending there is a channel-style thread.
3. Paperclip verifies the bot activity, tenant, resource, and member; resolves the external principal; checks current permission; then durably appends/wakes the issue.
4. DM, channel, and group output use bounded post/edit behavior and may use Adaptive Cards and task modules. File references require a separate Microsoft Graph connection for ingestion; outbound files otherwise use a safe authenticated Paperclip-link fallback on every Teams surface.
5. Without RSC, unmentioned ambient channel/chat messages are ignored or not delivered. A denied action uses a targeted response when available, otherwise DM or text plus a Paperclip link.

The exact delivery of unmentioned replies in a bound Teams channel thread must be proven against the implementation SDK/manifest. If the bot cannot receive them without RSC, the UI must say **Mention Maya on each reply** or request resource-specific consent; it must not imply a subscription it does not have.

## 5. Discord

Discord uses the pinned Chat SDK Discord adapter through a long-lived Gateway client. It does not receive a public webhook and does not require an interactions public key because the current product has no Discord slash-command or modal surface.

### Setup and external handoff

The complete first-release path is a customer-owned bot:

1. **Connect Discord bot:** create a dedicated application in Discord Developer Portal, copy its Application ID, enable Message Content Intent, enter the authorized Server ID, and paste the bot token write-only into Paperclip.
2. **Install in Discord:** inspect and open Paperclip's server-pinned OAuth URL. It requests only the `bot` scope and permission integer `309237763136`; Administrator, Manage Server, and `applications.commands` are absent.
3. **Try Maya:** enable one discovered text channel, post a root `@Maya` message, and reply once inside the public Discord thread Paperclip creates.

Paperclip verifies that the token belongs to the declared Application ID, the privileged intent is enabled, the bot is installed in the declared server, and usable text channels have the required effective permissions. Application ID is globally unique across active endpoints, including endpoints that name different servers, because one native bot identity cannot represent multiple immutable Paperclip agents.

### Post-connect settings

- **Channels:** list text channels visible to the installed bot and let a Paperclip administrator enable a narrower subset. Newly visible channels remain disabled.
- **Allow direct messages:** one on/off toggle, off by default. Guild threads and DM task generations never share a binding.
- **Fixed behavior:** a root mention creates one public Discord thread and one Paperclip task; eligible replies continue inside it without another mention. A fresh unmentioned root is ignored.
- **Activity repairs:** token rotation, lost server membership, missing Message Content Intent, missing effective channel permissions, Gateway retries, and rate-limit failures appear as contextual diagnostics rather than settings.

There are no endpoint toggles for reactions, post/edit behavior, embeds, buttons, files, lifecycle edits/deletes, reconnect, or retry timing.

### Runtime interaction model and current caveat

Discord messages, reactions, interactions, edits, deletes, and partial reaction hydration enter through the Gateway and the same durable delivery/outbox boundary as webhook providers. Safe output uses bounded post/edit behavior; embeds and supported buttons are automatic; file downloads are bounded to reviewed Discord CDN hosts; numeric user IDs are the identity key; callbacks reauthorize against current Paperclip state. Gateway reconnect and provider `retry_after` timing are automatic.

The pinned SDK currently creates a provider thread before Paperclip's resource/principal admission completes. A denied user or disabled channel can therefore leave an inert empty Discord thread even though Paperclip creates no task, acknowledgement, reply, or run. This remains a production-quality qualification gap and must be resolved or explicitly accepted with provider-visible evidence before Discord can be called stable. Multipart upload calls and unused Discord interaction REST helpers also sit outside the common REST deadline/status wrapper; they require live/fault-injection evidence before being relied on.

## 6. Telegram

The [pinned Chat SDK Telegram adapter](https://github.com/vercel/chat/blob/51322dde8f4aafd8a7fc7a20cbfd7ae45cafaa5c/packages/adapter-telegram/README.md) supports verified webhooks or polling, files/media, inline buttons, reactions, DMs, throttled post/edit streaming, and opt-in private-chat draft previews. Telegram documents the mutually exclusive [`setWebhook` and `getUpdates`](https://core.telegram.org/bots/api) delivery modes and how [privacy mode](https://core.telegram.org/bots/faq) limits group updates.

### Setup and external handoff — screen 22

The normal path has two screens:

1. **Create Maya:** open BotFather, send `/newbot`, enter Maya's name, choose an available username ending in `bot`, and paste the returned token into Paperclip.
2. **Try Maya:** open the new bot's private chat, tap **Start**, and send one test message.

Telegram has no bot-installation OAuth callback, so the token is the single irreducible credential field. Private chat is the shortest working proof. Group and forum installation moves to post-connect configuration instead of lengthening first setup.

Public/relay production uses a verified webhook chosen by the deployment; local development may use polling. These mutually exclusive modes are instance behavior, not endpoint setup. A leaked token is rotated at BotFather and the Paperclip secret reference is replaced.

### Post-connect settings — screen 23

- **Chats and topics:** list discovered destinations where the bot is present and let a Paperclip admin enable or disable each one. A later Telegram chat/topic discovery appears disabled until enabled here.
- **Add Maya to another Telegram chat:** opens provider instructions; it changes Telegram membership, not Paperclip enablement.
- **Allow direct messages:** one on/off toggle.
- **Fixed behavior:** a DM or ordinary group has one open task at a time; after completion, the next addressed message starts another. `/new` or **New task** starts another explicitly. A forum `message_thread_id` maps one topic to one task. Privacy-on unrelated group traffic is ignored.
- **Activity repairs:** invalid token, lost membership, webhook failures, or flood-control problems expose contextual repair actions only when detected.

Allowed-user lists belong to Access. Task boundaries, BotFather privacy, delivery, relay/polling, token rotation, typing/reactions, post-edit output, private-chat drafts, inline buttons, Markdown, files/media, and safe fallbacks do not appear in Settings.

### Runtime interaction model (not a product screen)

1. **DM:** Ari's first message creates the active issue. An inline **New task** button or `/new` intentionally starts a different issue; ordinary replies continue the active one.
2. **Ordinary group:** `@maya` creates the active binding. Ari must reply to Maya or mention her for later turns. Privacy-on unrelated traffic is not delivered/processed.
3. **Forum group:** the topic's `message_thread_id` is the stable external boundary and can bind one issue. Topic creation is only attempted if configured and authorized.
4. Paperclip validates the secret header or polling claim, deduplicates `update_id`, checks chat/user scope and authority, persists the turn, then sends typing/reaction and throttled progress.
5. Inline callbacks contain a short opaque lookup key, not authority. Paperclip reauthorizes the principal; unsupported or governed actions receive normal text or DM plus an authenticated Paperclip link.

## 7. Wireframe annotations

The numbered red dashed marks are review annotations only, not proposed UI. The current viewer contains 14 minimum setup phases plus four provider management tabs; it contains no interaction-walkthrough pages. Every annotation and button consequence has an exact matching explanation beside the desktop/mobile pair in `index.html` and in `2026-09-04-chat-adapters-ui-surfaces-v8.md`; setup source data lives in `setup-wireframe-data-v6.mjs` and current management source data in `management-wireframe-data-v8.mjs`.

## 8. Implementation acceptance points exposed by the wires

- Provider setup has a persistent step rail and can be paused when external admin action is required, then resumed without creating a second endpoint.
- The selected agent cannot change. Connecting another agent always creates another endpoint.
- Setup page bodies contain only required operator actions and inputs. The completed agent step, automatic Paperclip work, capability lists, and successful checks are not repeated as content.
- Authenticated provider handoffs keep credentials invisible. Manual/customer-owned paths expose only irreducible secrets and store them write-only through Paperclip secret references.
- Delivery transport is selected by deployment and reported as health; direct/relay/Socket/polling are not connector-wizard choices.
- A real provider message completes setup and enables that explicitly exercised destination. Detailed identity, delivery, permission, and capability health appears only when a setup error needs remediation or later in Activity.
- There is no read-only Overview tab. Activity reports health and degradation; Settings contains only provider-available destination enablement and direct/group-chat reach toggles.
- Access contains only the unlinked-participation decision and explicit identity links. The internal sponsoring principal and fixed authority calculation are not normal settings.
- Conversations is a read-only list with provider/task links and row state. It has no manual detach or boundary-management controls.
- Basic operation uses the smallest viable provider permission set. RSC, Graph directory/history, Slack Agent Sessions, Telegram topic administration, and GitHub code access are separate upgrades.
- Every native conversation representation maps to a clear Paperclip issue boundary and gives the user an explicit way to start a new issue on linear-chat platforms.
- Self-message suppression, provider redelivery deduplication, uninstall/revocation, permission drift, rate limits, and provider health appear in Activity even when absent from the happy-path setup.
- Desktop/mobile wires preserve 48px mobile targets and the established Paperclip connector shell.
