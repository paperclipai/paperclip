# Paperclip Chat Adapters — Minimum Setup v6

Date: 2026-09-04
Paperclip base: `d593463ab6394cd356bf27448ea28bad8cccf4ec`
Viewer: [`index.html`](./index.html)
Wireframes: [`wireframes-v6/`](./wireframes-v6/)

## Relevance rule

A setup screen may show only something the operator must do during that step:

- click a Paperclip or provider action;
- choose something in the provider's UI;
- copy, paste, or upload a required value;
- run a required command;
- send the message that verifies the connection.

Do not show the selected agent again after selection. Do not show automatic credential storage, delivery selection, capability lists, successful checks, resource inventories, or explanatory status rows. Those belong in implementation, Activity diagnostics, or contextual repair states. Show errors and missing prerequisites only when they occur.

The persistent step rail is sufficient context. **Save & exit** preserves the draft. Completing the real provider test activates the connection and treats the explicitly tested destination as its first enabled resource. Any channel, chat, topic, or repository discovered later starts disabled until a Paperclip administrator enables it in Settings.

## Slack

### Normal path: Add to Slack

1. **Add Maya to Slack:** one page with one sentence, **Add Maya to Slack**, and the customer-owned-App fallback.
2. Slack asks the operator to choose a workspace and approve the installation.
3. **Try Maya:** open a channel, use `/invite @Maya` if required, post `@Maya help me test this` as a new channel message, and reply once in Maya's thread.

The tested Slack channel is enabled when the test succeeds. Inviting Maya to another channel later only makes it available; Paperclip remains silent there until an administrator enables that channel in Settings.

No credential, scope, event, callback, delivery, capability, installation-summary, or verification-report rows appear. Slack describes Add to Slack as a few-click agent deployment path where the platform handles authentication and permission scoping. See [Slack's Add to Slack announcement](https://slack.com/blog/news/add-to-slack).

### Customer-owned Slack App fallback

This branch is required for self-hosted deployments, organizations that require their own App, or environments where Paperclip cannot use Add to Slack.

1. **Create and install:** Paperclip opens Slack's official app-from-manifest URL. In Slack, choose the workspace, click **Next**, review the manifest, click **Create**, open **OAuth & Permissions**, click **Install to Workspace**, then **Allow**.
2. **Connect:** copy **Bot User OAuth Token** from **OAuth & Permissions** and **Signing Secret** from **Basic Information → App Credentials**; paste those two values into Paperclip.
3. **Try Maya:** use the same channel mention and thread-reply test as the normal path.

The prepared manifest contains Maya's app identity, callback URLs, least-privilege bot scopes, event subscriptions, interactivity, commands, and file behavior. The operator does not configure those individually. Slack documents both [shared manifest URLs](https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests/) and the [install/token/signing-secret locations](https://api.slack.com/tutorials/tracks/app-home-and-modals).

## GitHub

### Normal App Manifest path

1. **Create GitHub App:** click **Create in GitHub**, choose the owning account or organization, keep or resolve the unique App name, and click **Create GitHub App**.
2. **Choose repositories:** click **Install in GitHub**, choose the account or organization, choose all or selected repositories, review permissions, and install.
3. **Try Maya:** open an issue or pull request in an installed repository, comment `@paperclip-maya help me test this`, then add another comment to continue the same Paperclip task.

The tested repository is enabled when the test succeeds. Any other repository in the App installation remains disabled in Paperclip until enabled in Settings.

The App Manifest fixes the webhook, Issue/PR permissions, and comment/review events. GitHub returns a one-time code that Paperclip exchanges for the App credentials, so the normal path has no credential form. See [GitHub App Manifest registration](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest).

### Existing GitHub App fallback

1. Copy Paperclip's generated webhook URL and secret into the existing GitHub App and make the webhook active.
2. Grant **Issues: write**, **Pull requests: write**, and **Metadata: read**; subscribe to **Issue comment** and **Pull request review comment**.
3. Generate a private key in the App settings.
4. Paste the App ID and upload the PEM file to Paperclip, then connect and verify.
5. Continue through GitHub's ordinary repository-installation and test steps.

The webhook secret is generated and already stored by Paperclip; it is copied outward rather than requested back from GitHub.

## Microsoft Teams

### Normal guided path

1. **Create Teams app:** copy and run the one-time `npx @paperclipai/teams-connect --setup …` command. The planned Paperclip helper invokes Microsoft's Teams Developer CLI, opens Microsoft 365 sign-in, creates the app/bot registration against Paperclip's endpoint, and returns the resulting identity to the setup draft.
2. **Install Maya:** click the Microsoft install link returned by the command, then click **Add** and choose a team/channel if Microsoft asks.
3. **Try Maya:** open an installed channel, start a new post, send `@Maya help me test this`, and reply once beneath the post.

The tested Teams channel is enabled when the test succeeds. Installing Maya into another team or channel later makes that destination available but does not enable Paperclip work there.

This helper is a required implementation deliverable; the literal command does not exist yet. Microsoft's current CLI can create bot infrastructure for an existing endpoint and returns an install link. See the [Teams registration quickstart](https://learn.microsoft.com/en-us/microsoftteams/platform/teams-sdk/get-started/quickstart-register).

If tenant policy requires administrator approval, Microsoft owns that state inside the same install step. Paperclip preserves the draft; it does not add another configuration page.

### Manual Microsoft fallback

1. Copy Paperclip's messaging endpoint.
2. Create a single-tenant Entra App registration and client secret.
3. Create an Azure Bot using the Application ID, enable its Microsoft Teams channel, and set Paperclip's messaging endpoint.
4. Paste the Application ID, Directory/Tenant ID, and client-secret value into Paperclip.
5. Click **Connect and create Teams app**, then continue through the normal install-link and test steps.

Those three identity values are the minimum portable credentials for the manual customer-owned registration. Paperclip does not show authentication-strategy, cloud, webhook, relay, package, scope, or capability choices on the normal path. For tenants that require package submission rather than direct sideloading, the install step may return a Microsoft admin-approval state; Microsoft documents the [custom-app upload and approval paths](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/deploy-and-publish/apps-upload).

## Telegram

1. **Create bot:** open BotFather, send `/newbot`, enter Maya's display name, choose an available username ending in `bot`, and paste the returned token into Paperclip.
2. **Try Maya:** open the new bot's private chat, tap **Start**, and send `Help me test this`.

The successful private-chat test enables direct messages when setup completes. Groups and forum topics discovered later remain disabled until enabled in Settings.

Telegram has no bot-installation OAuth callback, so the BotFather token is the single unavoidable input. Telegram bots also cannot initiate a conversation; the person must start the bot or add it to a group. See Telegram's [BotFather tutorial](https://core.telegram.org/bots/tutorial) and [bot introduction](https://core.telegram.org/bots).

Group and forum installation is deliberately post-connect configuration. The minimum setup proves a working bot through a private message; an operator can later add the bot to a group and enable the discovered chat in connector Settings. Access remains reserved for external-identity linking and the unlinked-participation policy.

## Resulting screen inventory

| Provider        |                      Normal setup screens | Advanced fallback                                          |
| --------------- | ----------------------------------------: | ---------------------------------------------------------- |
| Slack           |                    Add to Slack; Try Maya | Create/install custom App; copy two secrets                |
| GitHub          | Create App; choose repositories; Try Maya | Configure existing App; App ID and private key             |
| Microsoft Teams |       Run command; install link; Try Maya | Manual Entra/Azure Bot registration; three identity values |
| Telegram        |                 BotFather token; Try Maya | None in first release                                      |

The current viewer contains 14 setup phases and every provider-specific Settings, Access, Conversations, and Activity tab. The read-only Overview and non-product interaction-walkthrough pages are absent in v8.
