# Paperclip Chat Adapters — Setup Audit v5

Status: historical snapshot; current setup specification is [`2026-09-04-chat-adapters-minimum-setup-v6.md`](./2026-09-04-chat-adapters-minimum-setup-v6.md)
Date: 2026-09-04
Paperclip base: `7b094724e65c04949706df638d497afb02c84b62`
Review viewer: [`index.html`](./index.html)
Setup wireframes: [`wireframes-v5/`](./wireframes-v5/)

## Decision

Connector setup asks only for decisions or values that Paperclip cannot safely infer, provision, receive from a provider callback, or inherit from the instance deployment.

- The selected agent is displayed as **Locked** throughout setup. A bot identity represents one agent for the lifetime of the connection. Connecting another agent creates another connection.
- Every provider uses a persistent step rail with completed, current, and remaining phases. A provider redirect may leave Paperclip, but the draft and current phase remain resumable.
- Provider-owned approval, organization/workspace choice, repository selection, tenant policy, app installation, and native bot naming remain in the provider's UI.
- Paperclip fixes required events, permissions, callback URLs, command declarations, and maximum safe interaction capabilities. They are not setup options.
- Paperclip selects delivery from instance reachability. Direct callback, relay, Socket Mode, and polling do not appear as endpoint preferences.
- Credentials obtained by an authenticated provider handoff go directly to Paperclip's secret store. They are not displayed or copied through the UI.
- A final live mention or message is encouraged because it proves the real installation, delivery, identity, and conversation boundary. It may be skipped so setup does not block on another person or provider administrator.

## Shared row-by-row disposition

| Previous row or choice                                                                            | v5 disposition                                             | Reason                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Change agent                                                                                      | Remove; show the assigned agent and **Locked**             | Changing it would make an established provider bot identity and historical task bindings ambiguous. Create a new connection for another agent.                       |
| Bot name/avatar configuration                                                                     | Show a read-only preview or provider-owned result          | Provider naming and uniqueness rules belong in the provider handoff. Paperclip may propose the agent name and avatar.                                                |
| Direct webhook                                                                                    | Remove as a choice                                         | It is the automatic path when the instance has a verified public callback.                                                                                           |
| Private Paperclip / relay                                                                         | Remove as a choice                                         | A private instance uses its configured outbound relay automatically. Relay enrollment and keys belong to instance administration, not to each endpoint.              |
| Slack Socket Mode                                                                                 | Remove from endpoint setup                                 | It requires an app-level token and persistent outbound listener and has distribution constraints. It is an instance-admin development/on-premises escape hatch only. |
| Telegram polling                                                                                  | Remove from endpoint setup                                 | Polling and webhook delivery are mutually exclusive. Paperclip may use polling for a local developer instance, never as a normal endpoint preference.                |
| Feature switches for reactions, streaming, cards, actions, modals, commands, files, edits, or DMs | Remove                                                     | Paperclip always uses the maximum safe feature supported by the adapter, installation, conversation, and current Paperclip authorization.                            |
| Event/scopes checklist                                                                            | Generate and verify; do not expose toggles                 | Chat connectors need a known least-privilege contract. Missing permissions become a repair state, not an optional configuration.                                     |
| Credentials returned by OAuth or manifest callback                                                | Hide completely                                            | Paperclip can store them directly without asking the operator to handle a secret.                                                                                    |
| Customer-owned credentials with no callback                                                       | Keep only the irreducible values; submit write-only        | Paperclip cannot authenticate without them. The connector shows secret references and rotation state after setup, never the stored values.                           |
| Provider resource choice                                                                          | Keep in the provider handoff                               | Workspace, organization, repository, tenant, team, channel, group, or chat membership is governed by provider policy. Paperclip may narrow the returned scope later. |
| Send test                                                                                         | Replace synthetic tests with a real native mention/message | A real event proves signature/authentication, installation scope, native identity, routing, and task binding together.                                               |

## Delivery model

| Deployment condition                                         | What Paperclip does                                                                                                                            | What the endpoint wizard shows                                                                          |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Paperclip Cloud or publicly reachable self-hosted instance   | Registers the endpoint's unguessable verified HTTPS callback directly with the provider.                                                       | **Automatic** during setup; read-only delivery health after setup.                                      |
| Private self-hosted instance with Paperclip relay configured | The instance maintains an authenticated outbound relay connection; the relay accepts the provider callback and forwards the verified envelope. | **Automatic** during setup; relay health at instance administration and read-only endpoint diagnostics. |
| Local/developer instance without a public callback or relay  | May run a provider-specific escape hatch such as Slack Socket Mode or Telegram polling.                                                        | Nothing in normal endpoint setup. The developer enables it once at instance level.                      |

The direct callback is preferred because it has the fewest moving parts. A private instance cannot receive that callback from Slack, GitHub, Teams, or Telegram; that is the reason a relay exists. Slack Socket Mode establishes an outbound WebSocket using an app-level token, so it avoids a public Request URL but requires a continuously running listener. It is not a competing UX choice. Telegram polling is the analogous local-development fallback and cannot run while a webhook is registered.

## Credentials retained after simplification

| Provider path                        | Values typed or uploaded by the operator                                       | Why they remain                                                                                                                                                                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slack — customer-owned app           | Bot token and signing secret                                                   | Slack's app-from-manifest handoff preconfigures the App but does not return these two customer-owned values to Paperclip. No webhook URL, app token, or delivery choice is requested.                                                       |
| GitHub — customer-owned App          | App ID and private-key PEM; GitHub Enterprise Server host only when applicable | Paperclip generates, stores, and reveals the webhook secret once for copying to GitHub. It then authenticates and verifies the App callback, events, and permissions without asking the operator to paste the secret back.                  |
| Microsoft Teams — customer-owned bot | Application/client ID, tenant ID, client secret                                | These values come from the customer's Entra App and Azure Bot registration. A future CLI helper may automate provisioning, but it is optional and cannot gate release. Managed identity remains an instance-level advanced deployment path. |
| Telegram — BotFather bot             | Bot token                                                                      | Telegram has no OAuth or app-manifest installation callback. BotFather gives the operator the bot password once.                                                                                                                            |

All secrets are write-only inputs to Paperclip's existing secret store. Setup and connector detail retain only secret references, redacted suffixes, health, and rotation actions.

## Slack setup inventory

### Required customer-owned App path

| Screen | Phase            | Retained action                | What happens                                                                                                                                        |
| ------ | ---------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 13     | Create Slack app | **Open prefilled Slack setup** | Opens Slack's app-from-manifest URL with identity, callback URLs, scopes, events, interactivity, commands, and files prepared.                      |
| 13     | Connect app      | **Save and verify**            | Stores the bot token and signing secret write-only, calls Slack identity APIs, and verifies required scopes.                                        |
| 41     | Try Maya         | **Open Slack**                 | Opens the installed workspace while Paperclip waits for a signed root mention. A valid mention creates the Slack thread and its one Paperclip task. |
| 41     | Try Maya         | **Finish without testing**     | Activates the endpoint after installation checks and leaves first-event verification visible on Overview.                                           |

Normal Slack setup has only the unavoidable bot-token and signing-secret inputs. Callback, relay, Socket Mode, app-token, event, scope, and feature choices remain absent.

### Optional managed install

An Add to Slack flow can be introduced when Paperclip participates in Slack's managed agent-deployment program. It is a convenience only and is not a first-release dependency.

Slack's OAuth installation redirects through Slack, and its app manifest can create a preconfigured customer-owned app. Socket Mode remains an instance-level exception because Slack documents it as an outbound WebSocket connection using an app-level token and notes distribution limitations. See [Slack OAuth installation](https://docs.slack.dev/authentication/installing-with-oauth/), [Slack App Manifests](https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests/), [Slack Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/), and [Add to Slack](https://slack.com/intl/en-ie/blog/news/add-to-slack).

## GitHub setup inventory

### Required customer-owned App path

| Screen | Phase               | Retained action             | What happens                                                                                                                          |
| ------ | ------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 16     | Create GitHub App   | **Generate webhook secret** | Paperclip generates and stores a 32-byte secret and reveals it once for copying into the GitHub App.                                  |
| 16     | Connect GitHub App  | **Connect and verify**      | Accepts the App ID and private-key PEM, authenticates as the App, and verifies the callback, events, and least-privilege permissions. |
| 45     | Choose repositories | **Install in GitHub**       | GitHub owns account/organization approval and all-vs-selected repository choice, then returns the installation ID.                    |
| 46     | Try Maya            | **Open GitHub**             | Opens an installed repository while Paperclip waits for a signed mention in an issue, PR conversation, or inline review thread.       |
| 46     | Try Maya            | **Finish without testing**  | Activates after App and installation verification; first-delivery status remains on Overview.                                         |

The required path asks only for the App ID and private-key PEM after Paperclip has generated the webhook secret. Contents, Actions, and Administration permissions are absent because this is a chat connection; a GitHub tool connection is separate.

### Existing App

| Screen                                                                                                                                                                                                  | Phase | Retained action | What happens |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | --------------- | ------------ |
| An existing App uses the same generated-secret, App ID, and private-key path. Regenerating the webhook secret is an explicit rotation and requires updating GitHub before signed deliveries can resume. |

GitHub's App Manifest exchange remains a possible managed convenience, not a release dependency. GitHub still owns repository installation and scope selection. See [registering a GitHub App from a manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest) and [installing a GitHub App from a third party](https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-a-third-party).

## Microsoft Teams setup inventory

Microsoft currently requires more customer-owned infrastructure than the other default paths. v5 does not present multiple authentication or delivery strategies. It chooses a single-tenant client-secret flow for the portable first release and moves managed identity/federation to instance-level advanced deployment.

| Screen | Phase              | Retained action             | What happens                                                                                                                          |
| ------ | ------------------ | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 19     | Register Teams bot | **Open Microsoft setup**    | Guides the operator through a customer-owned single-tenant Entra App and Azure Bot registration using Paperclip's messaging endpoint. |
| 19     | Register Teams bot | **Copy messaging endpoint** | Copies the exact public callback to enter in the Azure Bot configuration.                                                             |
| 48     | Connect identity   | **Save and verify**         | Stores the client secret write-only, requests a Microsoft bot token, and verifies tenant, application, and messaging endpoint.        |
| 49     | Install app        | **Download Teams package**  | Downloads a validated ZIP containing public manifest metadata and icons; it contains no secret.                                       |
| 49     | Install app        | **Open Teams**              | Opens Teams app management for upload/install. Tenant policy decides self-service vs administrator approval.                          |
| 50     | Try Maya           | **Open Microsoft Teams**    | Opens Teams while Paperclip waits for the first authenticated activity from an installed scope.                                       |
| 50     | Try Maya           | **Finish without testing**  | Activates after identity and package checks; installation delivery remains pending on Overview until a real activity arrives.         |

Paperclip generates the endpoint, manifest values, and package. Microsoft owns tenant sign-in, Azure/Entra resource creation, app approval, and installation scope. See [Teams SDK registration quickstart](https://learn.microsoft.com/en-us/microsoftteams/platform/teams-sdk/get-started/quickstart-register), [Teams app authentication](https://learn.microsoft.com/en-us/microsoftteams/platform/teams-sdk/essentials/app-authentication/overview), [Azure configuration](https://learn.microsoft.com/en-us/microsoftteams/platform/teams-sdk/teams/azure-configuration), and [publishing/installing Teams apps](https://learn.microsoft.com/en-us/microsoftteams/platform/toolkit/publish).

A future Teams Developer CLI helper may automate the provider-owned registration steps, but it is optional and cannot gate the first release.

## Telegram setup inventory

| Screen | Phase               | Retained action            | What happens                                                                                                                                                    |
| ------ | ------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 22     | Create Telegram bot | **Connect bot**            | Stores the BotFather token write-only, calls `getMe`, fixes the immutable native bot identity, registers commands, and configures deployment-selected delivery. |
| 22     | Create Telegram bot | **Open BotFather**         | Opens the provider flow where the operator runs `/newbot`, chooses an available username, and receives the token.                                               |
| 51     | Add to chats        | **Open Maya in Telegram**  | Opens the bot profile so the operator can start a DM or add it to a group/forum under Telegram membership policy.                                               |
| 52     | Try Maya            | **Open Telegram**          | Opens Telegram while Paperclip waits for a real update from the intended DM, group, or forum topic.                                                             |
| 52     | Try Maya            | **Finish without testing** | Activates after bot identity checks and leaves chat-membership delivery pending on Overview.                                                                    |

Paperclip does not ask for chat IDs up front. It learns stable chat, forum-topic, and participant identifiers from authenticated updates and lets an operator approve them afterward. BotFather's token is unavoidable because Telegram has no OAuth-style bot installation callback. Webhook or local polling selection is automatic. See [Telegram's BotFather tutorial](https://core.telegram.org/bots/tutorial) and [Telegram Bot API webhook/polling contract](https://core.telegram.org/bots/api).

## Purpose choice for dual-surface connectors

Screen 02 is registry-driven, not GitHub-specific. Any connector declaring both `chat` and `tool` methods asks one question:

- **Chat with an agent** enters the chat wizard, selects one immutable agent, and creates a native conversation endpoint.
- **Use this connection as an agent tool** enters Paperclip's existing connection credential and human/agent-access flow.

Connectors declaring only one method skip the choice entirely.

## Setup state and recovery

Each phase persists a draft with the immutable agent, provider handoff nonce, completed checks, expiration, and safe remediation state. Provider returns are idempotent. Refreshing or returning after administrator approval resumes the current phase. Revoked, expired, wrong-company, permission-denied, and provider-error returns explain the corrective action without revealing credentials. Abandoning setup deletes only the unactivated draft; it does not delete a provider resource without a separate explicit action.

## What remains configurable after activation

- Resource reach within the provider installation: channels, repositories, teams/channels, Telegram chats/topics.
- Identity links, endpoint sponsor, and restricted external-person access.
- Conversation activation and task-boundary behavior where the provider genuinely offers alternatives.
- Explicit trusted automation or broader-consent grants, default off.
- Secret rotation only for customer-owned credential paths.
- Pause, reconnect/repair, test, and remove lifecycle actions.

Delivery transport and response capabilities remain status, not preferences.
