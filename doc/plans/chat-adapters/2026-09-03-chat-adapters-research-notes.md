# Chat Adapters Research Notes

**Date:** 2026-09-03
**Paperclip implementation base:** `d593463ab6394cd356bf27448ea28bad8cccf4ec`
**Earlier planning references:** `origin/master` was initially observed at `b872cd3d1b404bdaff70af493a2973ceb7e5d6ec`, then refreshed through `112ef5beecf518ce9e0cbbead3eac297c09fc775`, `b84964e5a2fa8b1e6498a1ccb471f6adba97d470`, and `7b094724e65c04949706df638d497afb02c84b62`; this revision fast-forwarded to the implementation base above.
**Vercel Chat SDK snapshot:** `51322dde8f4aafd8a7fc7a20cbfd7ae45cafaa5c`, package `chat@4.39.0`
**OpenTag snapshot:** `6a770d862349f8e996c23c145aef6d6275914a23`

## Research question

How should Paperclip place its existing agents inside Slack and other external communication systems while preserving Paperclip tasks, runs, permissions, and governance as the source of truth?

## Paperclip baseline

Paperclip is already task/comment-centric rather than a generic chatbot. It has:

- company-scoped agents with independent runtime adapters;
- single-assignee tasks, atomic checkout, wakeups, active-run handling, and liveness recovery;
- users, agent keys, responsible-user attribution, permission grants, review policies, approvals, and budgets;
- issue comments, typed interactions, documents, attachments, work products, and activity history;
- Apps v2 connection, secret, identity, permission, review, test, and activity surfaces;
- first-party Apps, route, job, settings, and UI infrastructure suitable for a native chat-adapters subsystem.

That means a channel integration should not create another agent runtime or conversational database. Its job is to translate external events into governed Paperclip task operations and translate safe Paperclip output back into the provider.

## Vercel Chat SDK

Sources: [repository](https://github.com/vercel/chat), [adapter catalog](https://chat-sdk.dev/adapters), [documentation](https://chat-sdk.dev/docs), [agent-readable index](https://chat-sdk.dev/llms.txt).

### What it contributes

- One TypeScript abstraction over mentions, subscribed messages, reactions, actions, slash commands, modals, messages, threads, cards, files, DMs, and ephemeral replies.
- AI streaming that can select native Slack streaming, Telegram private-chat draft previews, or post/edit fallbacks.
- Explicit overlapping-message policies: burst, queue, debounce, drop, or concurrent processing.
- A static `chat/adapters` catalog containing package names, factory exports, peer dependencies, credential modes, required/optional environment variables, and secret annotations.
- Pluggable state adapters for memory, Redis/ioredis, PostgreSQL, and vendor runtimes.

### Catalog snapshot

The pinned catalog includes official packages for Slack, Teams, Google Chat, Discord, GitHub, Linear, Notion, Telegram, WhatsApp Business Cloud, Twilio, X/XChat, Messenger, Instagram, and Web. It also lists vendor-official or community integrations for Liveblocks, Resend email, Sendblue/iMessage, Zernio, Matrix, Webex, WhatsApp bridges, Lark, Velt, Kapso, Novu, Linq, Photon, Dial, Weixin, LINE, and others.

The catalog should seed Paperclip setup metadata, but it is not a compatibility guarantee. Paperclip must maintain its own reviewed registry with pinned package/version, maturity, deployment compatibility, and feature-test results.

### What Paperclip must not delegate

Chat SDK's subscription, queue, lock, and history abstractions are bot-building conveniences. Paperclip needs stronger durable delivery, task binding, actor authorization, audit, and outbox semantics. A Paperclip state adapter should implement the SDK contract on Paperclip-owned records while leaving Paperclip's delivery ledger authoritative.

### Thread topology and GitHub

Chat SDK normalizes provider threads, but Paperclip must choose what a thread means. The selected model is Hermes-style for channel products: a root `@bot` mention on Slack, Discord, or a compatible Teams channel creates/opens a native provider thread; that thread owns exactly one Paperclip issue for the endpoint; all later conversation stays inside it without repeated mentions. This keeps the channel timeline readable and gives Paperclip a stable task boundary.

GitHub joins the first supported group through its official Chat SDK adapter. Its issue, pull-request, or discussion already is the native conversation thread, so an addressed comment binds that existing thread to one Paperclip issue instead of creating a second GitHub thread. Telegram uses a stable chat/topic boundary where nested threads are unavailable. These differences belong in adapter capabilities, not provider-name conditionals in orchestration code.

## OpenTag

Source: [CopilotKit/OpenTag](https://github.com/CopilotKit/OpenTag).

OpenTag is a complete Channels SDK starter rather than a general control plane. Its useful patterns are:

- a clear managed-versus-self-hosted channel runner boundary;
- platform ingress separated from the long-running agent runtime by an outbound authenticated connection;
- mention activates a thread, follow-ups in that subscribed thread continue, and unmentioned messages in a fresh conversation remain silent;
- sender-aware context, file-aware prompts, rich native output, and resumable confirmation cards;
- diagnostics that distinguish declared channel, platform setup, environment, runtime connectivity, and live delivery;
- explicit warnings about competing runtimes claiming the same delivery identity.

OpenTag binds one visible persona (`AGENT_DISPLAY_NAME`) to one AG-UI agent URL. It does not solve Paperclip's company, multi-agent, task, permissions, budget, or audit model. Its managed Intelligence service owns provider credentials, delivery, state, and concurrency; Paperclip must own those controls itself or through an optional relay that does not become the business authority.

## Claude Tag

Source: [Introducing Claude Tag](https://www.anthropic.com/news/introducing-claude-tag).

Claude Tag presents one shared `@Claude` identity inside a selected Slack channel. People tag it with tasks; it breaks work into stages, uses connected tools/data/codebases, and replies in a Slack thread. Anthropic describes that channel identity as multiplayer: one Claude shares the channel context and conversation with everyone.

That is appropriate for a single product persona. It does not match Paperclip's core identity model, where a company has many independently configured agents with separate roles, runtimes, permissions, managers, and budgets. Paperclip should therefore expose each selected agent as its own provider bot identity. The shared unit is the channel, not a merged Paperclip agent.

## Slack Add to Slack

Source: [Slack's Add to Slack announcement](https://slack.com/blog/news/add-to-slack).

Slack describes Add to Slack as a standardized authorization and deployment bridge from agent builders into a workspace, with platform-handled multi-tenant permission scoping and centralized Slack governance. The examples emphasize individual agents with their own identities, permissions, and audit trails living beside teammates.

This validates a future managed provisioning path, but Paperclip cannot depend on it initially:

- it is Slack-specific while the architecture must cover many providers;
- it simplifies installation, not Paperclip task/run/permission semantics;
- provider workspace permission inheritance does not replace Paperclip authorization;
- self-hosted Paperclip still needs BYO credentials and private-network relay options.

## One bot per agent versus shared bot

| Model                                    | Strength                                                                              | Failure in Paperclip                                                                             | Decision                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| One shared bot dispatches to many agents | One installation and credential set                                                   | Hidden addressing grammar, ambiguous identity, mixed permissions/audit, unclear output ownership | Do not use for v1                                   |
| One bot identity per Paperclip agent     | Native addressing, visible role, clean task ownership, separate permissions and audit | More provider installations and credential lifecycle                                             | Adopt                                               |
| One fixed product persona                | Simple, Claude Tag/OpenTag-like experience                                            | Does not expose the Paperclip company roster                                                     | Allow only as one ordinary Paperclip agent endpoint |

Within a shared Slack channel, `@Researcher` and `@Engineer` are separate apps. A root mention creates the native thread and one issue owned by the addressed endpoint; human replies in that thread continue it without another mention. If a second Paperclip bot participates through an explicit route, Paperclip records a separate related single-assignee issue and guarded route provenance rather than stealing or sharing the first issue.

## Provider shape taxonomy

The UI should not clone a wizard for every adapter or expose these patterns as onboarding steps. `/apps` renders one conditional purpose choice, the existing single-agent picker, and one provider handoff. The following taxonomy drives that final handoff and post-connect detail fields:

1. **Workspace app:** Slack, Teams, Google Chat, Discord, Lark. App registration, tenant/workspace selection, webhook/event subscriptions, scopes, and bot identity.
2. **Comment system:** GitHub, Linear, Notion, Liveblocks, Velt. App/token plus repository/page/room scope; comments and mentions form threads.
3. **Bot token:** Telegram and similar systems. Token, webhook secret/mode, group/channel allowlist, username.
4. **Meta messaging:** WhatsApp, Messenger, Instagram, Kapso. Business/page/account identifiers, access/app/verify secrets, webhook registration, messaging windows/templates.
5. **Phone/RCS/iMessage:** Twilio, Sendblue, Linq, Photon, AgentPhone. Sender number/identity, API credential, webhook, media/delivery restrictions.
6. **Public social:** X/XChat. Bot account/OAuth, public mention and DM modes, media and rate-limit constraints.
7. **Email:** Resend. From identity/domain, API/webhook secrets, threading headers, HTML/text and attachment behavior.
8. **Web/embedded comments:** Web adapter and collaboration vendors. Host-supplied user authentication and conversation identity.

## Minimum-setup findings

- **Slack:** Add to Slack is the only one-action path and is appropriate when Paperclip participates in Slack's agent-deployment program. A customer-owned App still requires the operator to create it from a prepared manifest, install it to the workspace, then copy the Bot User OAuth Token and Signing Secret. Slack documents [shareable app-manifest URLs](https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests/) and the [install/token/signing-secret sequence](https://api.slack.com/tutorials/tracks/app-home-and-modals).
- **GitHub:** the App Manifest handoff lets GitHub collect owner/name, redirect with a one-time code, and let Paperclip exchange that code for credentials. Repository selection remains GitHub's installation step, so Paperclip needs no normal-path credential or repository form. See [GitHub App Manifest registration](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest).
- **Microsoft Teams:** Microsoft's Teams Developer CLI can register app/bot infrastructure for an existing public endpoint and returns an install link. The minimum Paperclip product therefore needs a one-time helper around that CLI that returns identity into the setup draft; manual Entra/Azure Bot registration remains the fallback. See the [Teams registration quickstart](https://learn.microsoft.com/en-us/microsoftteams/platform/teams-sdk/get-started/quickstart-register).
- **Telegram:** BotFather's `/newbot` flow and returned token cannot be removed. Telegram bots also cannot initiate a conversation, so the smallest proof is: paste the token, open the bot, tap Start, and send one private message. See the [BotFather tutorial](https://core.telegram.org/bots/tutorial) and [Telegram bot introduction](https://core.telegram.org/bots).

These findings produce a strict UI rule: if an operator cannot act on information during the current setup phase, omit it. Automatic credential storage, transport selection, capabilities, and successful checks belong outside onboarding.

## Feature-to-Paperclip mapping

| Chat SDK feature           | Paperclip source/target               | Required guard                                       |
| -------------------------- | ------------------------------------- | ---------------------------------------------------- |
| Mention/subscribed message | Task create/comment/wakeup            | Endpoint/resource activation policy                  |
| Reaction                   | Receipt or explicit reaction event    | Self/loop suppression and capability check           |
| Streaming                  | Safe public run projection            | No raw traces; rate/edit limits                      |
| Card                       | Artifact, status, interaction, or URL | Safe renderer and text fallback                      |
| Button/dropdown/modal      | Typed interaction resolution          | Current identity, resolver audience, exact once      |
| Slash command              | Explicit channel command              | Command allowlist and normal authorization           |
| File                       | Issue attachment/work product         | Bounded download, type/hash/sanitize                 |
| DM                         | Conversation-bound task               | DM policy and stable provider identity               |
| Ephemeral reply            | Denial/link/receipt                   | DM or safe normal-message fallback                   |
| Overlapping messages       | Comment queue or steer/new run        | Paperclip task/run concurrency remains authoritative |

## Resulting recommendation

Adopt Chat SDK below a native Paperclip channel control plane. Reuse the current `/apps` catalog, connection wizard shell, single-agent selector, and connector-detail navigation. Onboarding asks only for purpose when ambiguous, the agent, and the provider invite/handoff; reviewed defaults create the endpoint, while Channels, Access, Behavior, Conversations, and Activity remain editable afterward. Implement chat adapters directly in Paperclip with a Paperclip-backed Chat SDK state adapter, durable ingress/outbox, provider-thread provisioning, explicit identity linking, sponsored restricted guests, and endpoint-bound issues. Begin with Slack, Teams, Discord, Telegram, and GitHub, but generate setup and capability UI from a reviewed adapter registry so every later adapter is an enablement exercise rather than an architectural fork.
