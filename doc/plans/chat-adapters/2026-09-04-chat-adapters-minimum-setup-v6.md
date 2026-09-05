# Paperclip Chat Adapters — Minimum Setup v6

Date: 2026-09-04
Paperclip base: `8430bd897f01dd4b91e0970efffb71b97e5a2685`
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

### Required path: customer-owned Slack App

1. **Create and install:** Paperclip opens Slack's official app-from-manifest URL. In Slack, choose the workspace, review the manifest, create the App, and install it.
2. **Connect:** copy **Bot User OAuth Token** from **OAuth & Permissions** and **Signing Secret** from **Basic Information → App Credentials**; paste those two values into Paperclip.
3. **Try Maya:** open a channel, use `/invite @Maya` if required, post `@Maya help me test this` as a new channel message, and reply once in Maya's thread.

The tested Slack channel is enabled when the test succeeds. Inviting Maya to another channel later only makes it available; Paperclip remains silent there until an administrator enables that channel in Settings.

The prepared manifest contains Maya's app identity, callback URLs, least-privilege bot scopes, event subscriptions, interactivity, commands, and file behavior. The operator does not configure those individually. Slack documents [shared manifest URLs](https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests/) and the [install/token/signing-secret locations](https://api.slack.com/tutorials/tracks/app-home-and-modals).

### Optional managed install

An **Add to Slack** flow may be added when Paperclip participates in Slack's managed agent-deployment program. It is an optional convenience and cannot gate the first release or replace the customer-owned App path.

## GitHub

### Required customer-owned GitHub App path

1. **Create GitHub App:** copy Paperclip's webhook URL, click **Generate webhook secret**, then create a GitHub App with those values, **Issues: write**, **Pull requests: write**, **Metadata: read**, and the selectable issue/review-comment events. GitHub supplies installation lifecycle events automatically.
2. **Choose repositories:** click **Install in GitHub**, choose the account or organization, choose all or selected repositories, review permissions, and install.
3. **Try Maya:** open an issue or pull request in an installed repository, comment `@paperclip-maya help me test this`, then add another comment to continue the same Paperclip task.

The tested repository is enabled when the test succeeds. Any other repository in the App installation remains disabled in Paperclip until enabled in Settings.

Paperclip returns the webhook secret only once and never exposes it from normal endpoint reads. After GitHub creates the App, the operator enters the App ID and private-key PEM; Paperclip verifies the App permissions and subscribed events before retaining the credentials.

### Existing GitHub App

1. Copy Paperclip's generated webhook URL and one-time secret into the existing GitHub App and make the webhook active. Regenerating rotates the stored secret and requires updating GitHub before further deliveries can verify.
2. Grant **Issues: write**, **Pull requests: write**, and **Metadata: read**; subscribe to **Issue comment** and **Pull request review comment**.
3. Generate a private key in the App settings.
4. Paste the App ID and upload the PEM file to Paperclip, then connect and verify.
5. Continue through GitHub's ordinary repository-installation and test steps.

The webhook secret is generated and already stored by Paperclip; it is copied outward rather than requested back from GitHub.

## Microsoft Teams

### Required customer-owned bot path

1. Copy Paperclip's messaging endpoint.
2. Create a single-tenant Entra App registration and client secret, then create an Azure Bot using the Application ID, enable its Microsoft Teams channel, and set Paperclip's messaging endpoint.
3. In Teams Developer Portal, create the customer-owned Teams app, add the same bot Application ID for Personal, Team, and Group chat scopes, apply the required resource-specific consent entries, and publish or download/upload that app according to tenant policy.
4. Paste the Application ID, Directory/Tenant ID, and client-secret value into Paperclip, then install the customer-owned app in the intended scope.
5. **Try Maya:** open an installed channel, start a new post, send `@Maya help me test this`, and reply once beneath the post.

The tested Teams channel is enabled when the test succeeds. Installing Maya into another team or channel later makes that destination available but does not enable Paperclip work there.

A future helper around Microsoft's Teams Developer CLI may automate these provider-owned steps, but it is optional and cannot gate release. See the [Teams registration quickstart](https://learn.microsoft.com/en-us/microsoftteams/platform/teams-sdk/get-started/quickstart-register).

If tenant policy requires administrator approval, Microsoft owns that state inside the same install step. Paperclip preserves the draft; it does not add another configuration page.

Those three identity values are the minimum portable credentials for the manual customer-owned registration. Paperclip does not show authentication-strategy, cloud, webhook, relay, package, scope, or capability choices on the normal path. For tenants that require package submission rather than direct sideloading, Microsoft's publication or installation flow may return an administrator-approval state; Microsoft documents the [custom-app upload and approval paths](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/deploy-and-publish/apps-upload).

## Telegram

1. **Create bot:** open BotFather, send `/newbot`, enter Maya's display name, choose an available username ending in `bot`, and paste the returned token into Paperclip.
2. **Try Maya:** open the new bot's private chat, tap **Start**, and send `Help me test this`.

The successful private-chat test enables direct messages when setup completes. Groups and forum topics discovered later remain disabled until enabled in Settings.

Telegram has no bot-installation OAuth callback, so the BotFather token is the single unavoidable input. Telegram bots also cannot initiate a conversation; the person must start the bot or add it to a group. See Telegram's [BotFather tutorial](https://core.telegram.org/bots/tutorial) and [bot introduction](https://core.telegram.org/bots).

Group and forum installation is deliberately post-connect configuration. The minimum setup proves a working bot through a private message; an operator can later add the bot to a group and enable the discovered chat in connector Settings. Access remains reserved for external-identity linking and the unlinked-participation policy.

## Resulting screen inventory

| Provider        |                                                                        Normal setup screens | Advanced fallback                          |
| --------------- | ------------------------------------------------------------------------------------------: | ------------------------------------------ |
| Slack           |                                       Create/install custom App; copy two secrets; Try Maya | Optional managed install                   |
| GitHub          |           Generate secret; configure App; App ID/private key; choose repositories; Try Maya | Existing App uses the same credential path |
| Microsoft Teams | Manual Entra/Azure Bot and Teams app registration; three identity values; install; Try Maya | Optional future CLI helper                 |
| Telegram        |                                                                   BotFather token; Try Maya | None in first release                      |

The current viewer contains 14 setup phases and every provider-specific Settings, Access, Conversations, and Activity tab. The read-only Overview and non-product interaction-walkthrough pages are absent in v8.
