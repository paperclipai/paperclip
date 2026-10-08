# Automatic Slack app setup

New Slack bot drafts default to automatic setup. Existing drafts without a
`slackSetupMethod` remain manual. Paperclip uses Slack's Manifest API and OAuth
v2 directly; neither the operator nor the assisting agent needs the Slack CLI.

## Operator setup

1. Enable Chat connectors in Experimental settings and select an agent in
   Connectors → Slack → Chat with an agent.
   Once an agent is selected, Advanced reveals the generated app name, bot name,
   and slash command. Defaults use the agent name without random suffixes.
2. On App configuration access token, select **Get your App configuration access token**. In
   [Slack app settings](https://api.slack.com/apps), open **Your App Configuration
   Tokens → Generate Token**, select the workspace, and paste the temporary
   **Access Token** directly into Paperclip's password field. Do not supply
   its refresh token. Select **Create Slack app**.
3. After creation and configuration succeed, Paperclip advances to **Install Slack app**
   and opens Slack installation in a new window. Approve installation in the intended
   workspace. If the window is blocked or closed, select **Install in Slack**.
   If workspace policy requires administrator approval, return to this saved
   draft when approval is available. The existing app is reused. Paperclip links
   the Slack account returned by OAuth to the signed-in Paperclip account that
   started installation and sends one welcome DM: “Hi, I’m <agent name>. Your Slack
   account is connected to Paperclip.” Use your own Slack account.
4. On **Send a message to your agent**, select **Open Slack** and send a message.
   Paperclip checks incoming events automatically. A signed message event from the
   saved app/workspace or Slack's signed challenge completes the check. The same
   fourth screen then shows **Success** with a checkmark and **Done**; there is no
   separate Try it screen. The welcome-message event can complete this check before
   you send a message. Slack may still display an unverified URL.
   If the wizard keeps waiting, expand **Didn’t work?** for Event Subscriptions,
   Request URL, and Retry instructions. Opening a settings link is not proof.
   A failed welcome DM does not block setup; open Slack and message the bot directly.

Avatar provisioning is automatic and has no wizard step. Failed or interrupted
uploads do not block onboarding; manual upload remains available in the saved
connection’s **Settings → Agent avatar** section.

Automatic creation now omits event subscriptions from the initial manifest,
saves the returned signing secret, then applies the full canonical manifest with
`apps.manifest.update`. This removes the creation-time signing-secret race.
The 2026-10-07 live experiment did not receive a URL challenge after this update;
Slack nevertheless delivered an event, and the operator confirmed receiving an
agent response without clicking Retry. A manifest update alone never advances verification.
Manual creation continues to use the full canonical manifest.

Slack's settings-page Request URL verification remains distinct from Paperclip's
connection check. Automatic setup accepts an authenticated message/app-mention
event only after the runtime accepts the request, with the current signing secret,
expected app/workspace/bot binding, current callback URL, and active connection.
Manual setup retains the signed-challenge requirement. Paperclip
can answer a signed challenge as soon as creation has saved the signing secret,
even before OAuth installation finishes. This path performs no Slack API calls
and does not initialize the bot runtime or wait for the creation operation's lease.
Pre-install verification survives configuration only for the same signing secret
and webhook URL. It does not authorize installation or activate the connection.
The verification DM is queued separately from the HTTP acknowledgement, with
durable pending/sending/sent state. Repeated challenges do not send another DM; failed or ambiguous sends do
not block setup or replay automatically. Background recovery processes pending
messages and quarantines sends interrupted by a restart.

Paperclip captures the signing secret and client secret from creation and obtains
the bot token during installation. Durable secrets are stored in the company
vault and are not returned by setup APIs or added to the agent prompt. The
temporary configuration token is used for app creation, `apps.manifest.update`, and `apps.icon.set`, then
discarded after the request. Save & exit keeps
the draft and all saved non-secret progress.

**Create manually** and **Use an existing app** are under Advanced on the token step.
**Create manually** uses the same generated manifest. **Use an existing app**
keeps the existing credential-entry workflow. These paths retain explicit
personal account linking through the displayed `/command connect` command.
To connect a different account after setup, use the connection’s Access page.
Both options remain available for
recovery on the same draft. The selected automatic, manual, or existing-app method
is saved, so an existing-app draft reopens at credential entry. Agent instructions require the user to enter the temporary token and handle login/admin approval.

**Invite people** copies instructions for the saved app’s `connect` command.
Each recipient gets their own expiring confirmation link in Slack and confirms
their identity while signed in to Paperclip. New organization members require
membership approval. Existing members can self-link; disconnecting an identity
does not permanently block that member from reconnecting. Guest access remains
a separate, explicit setting for restricted work.

**Allowed Channels** updates every five seconds while Slack Settings is open.
Inviting the bot to a new channel enables replies and writes there automatically;
no additional Paperclip configuration is required. An explicit off switch stays
off across repeated invitations, reconnects, and inventory refreshes.

A bare @mention starts a normal agent conversation. Paperclip creates the task,
subscribes to the Slack thread, and starts the agent; later replies in that thread
continue the same task without another mention. Normal account and channel access
rules still apply, and repeated Slack deliveries do not create duplicate tasks.

Agents can ask interactive questions in Slack through Paperclip's saved
`ask_user_questions` interactions. Native runners use `request_human_input`;
legacy adapters use the issue-interactions API documented in the injected
Paperclip skill. Slack shows native answer buttons or an **Answer questions**
button and form, depending on the question and connection capabilities.
Submitting an answer wakes the assigned agent on the same task.
This works even when the adapter's built-in question tool is unavailable.

The app icon upload and Settings download use the agent’s 512×512 PNG on
Paperclip’s dark-mode background (`#171717`). Slack flattens transparent app icons
onto white, so this export has an opaque background before upload. Normal
Paperclip avatars retain transparency. Existing Slack apps need an icon re-upload
to adopt the new background; changing Paperclip does not replace their saved icon.


## Deployment

Automatic setup requires a canonical public HTTPS board origin and a public HTTPS
webhook ingress. The server derives URLs and permissions from its configuration;
the browser cannot supply a manifest, scopes, or callback destination.

- The OAuth redirect is `<canonical board origin>/api/chat-slack/oauth/callback`.
  It uses the existing authenticated board callback path and Cloud bootstrap
  checks. Keep board authentication enabled.
- Webhook URLs use `PAPERCLIP_CHAT_WEBHOOK_PUBLIC_URL` when configured, otherwise
  the canonical board origin. They end in `/api/chat-webhooks/<publicId>/slack`.
  A separate webhook ingress must route signed webhook requests to the instance.
- Avatar upload renders the assigned agent's preset PNG on the server and sends
  its bytes through `apps.icon.set` as multipart form data. Slack does not need to
  fetch an image from the tenant's authenticated board origin. The image is
  512 × 512 with the Paperclip dark background. The temporary configuration
  token stays in the Authorization header and is discarded after setup.
- Cloud resolves its current canonical origin from its claimed runtime identity.
  Self-hosted deployments use the configured authentication public base URL
  (`PAPERCLIP_AUTH_PUBLIC_BASE_URL` or `PAPERCLIP_PUBLIC_URL`).
  Both URLs must have valid certificates and be reachable by their intended
  callers. A private Tailscale Serve address is insufficient for Slack webhooks.
- Origin changes invalidate outstanding authorization attempts. Restore the saved
  origins or reconcile the existing Slack app and use manual recovery. Never
  loosen authentication or signature verification to bypass a failed callback.

## Recovery and invariants

| Saved state | Operator action |
| --- | --- |
| Invalid/expired configuration token | Generate a new configuration token and retry. Draft details are preserved. |
| Creation uncertain after timeout/restart | Inspect Slack app settings. Recover an existing app manually on this draft. Start another creation only after explicitly confirming that no app exists. |
| App saved; event configuration pending after failure/restart | Enter an app configuration access token and select Retry app configuration. The same saved app and canonical manifest are reused; installation is blocked until this update succeeds. |
| App created; installation declined/pending | Install the saved app again. No configuration token is needed. |
| Revoked bot token or uninstalled app | Start fresh installation authorization for the same saved app. Existing workspace, bot, and account bindings are preserved; consent started before revocation cannot restore the connection. |
| Authorization expired or code exchange uncertain | Start fresh installation authorization. Used codes are never replayed. |
| Credentials saved; connection check failed | Use Retry connecting. Paperclip reuses vaulted credentials. If Slack access changed or the token was revoked, use Authorize in Slack again for the same app. |
| Wrong app/workspace/bot or missing scopes | Correct the installation of this app. Activation remains blocked. |
| Avatar upload failed or interrupted | Continue setup with the saved app. Optionally upload the avatar from Settings later. The configuration token is not retained for retries. |
| Existing or revoked personal account link conflicts | Manage account links in Access settings. Installation never overwrites someone else’s link or restores a revoked link. |
| Welcome DM failed or interrupted | Continue setup and open Slack directly. A saved dispatch is never replayed after refresh, restart, or reauthorization. |
| Removed connection | Pending state and app-registration secrets are invalidated. Remove the customer's app separately through its Slack management link if desired. |

App details are immutable after creation dispatch, including when the outcome is
uncertain. The endpoint's existing credential lease serializes creation,
configuration, recovery, and removal across server processes. Generic connection
removal uses the same lock. The unique-bot constraint still applies.

Registration secrets are separate from runtime credentials. The received bot token
is vaulted before `auth.test`, inventory, and configuration. Staged bot/signing
secret copies are deleted only after runtime binding commits. Client credentials
remain in the registration vault for subsequent authorization. OAuth’s
`authed_user.id` identifies the installer; the bot token confirms that person’s
workspace through `users.info`. Company membership and existing identity-link
constraints are checked before linking. Reauthorization preserves the original
linked account. Welcome-DM dispatch is saved before calling `chat.postMessage`;
an interrupted dispatch becomes uncertain instead of sending a duplicate.
The welcome contains no confirmation token and starts no agent work. Local activity
records contain safe IDs and outcome codes. This feature adds no telemetry.

## Verification

Focused checks:

```sh
pnpm exec vitest run packages/shared/src/slack-app-manifest.test.ts ui/src/pages/apps/chat/SlackAutomaticSetup.test.tsx
pnpm exec vitest run server/src/__tests__/chat-channels.integration.test.ts -t 'automatic Slack registration'
pnpm exec playwright test --config tests/e2e/playwright.config.ts tests/e2e/chat-adapters-ui-providers.spec.ts
pnpm check:token-gates
```

The Storybook stories under **Connections / Slack / Automatic setup** render the
production wizard with simulated provider responses. They cover the automatic
journey, manual setup, pending/declined installation, uncertain creation, saved
credential recovery, avatar failure without an extra wizard step, verification
waiting, welcome-DM failure, and mobile layouts. These are fixture checks.

Partial live qualification on 2026-10-07 used an isolated authenticated instance
behind TryCloudflare and the operator's authorized Slack installation. The
operator created and installed the app through the wizard. Safe activity recorded
successful avatar upload, installer linking, and welcome delivery. A signed
Request URL challenge was recorded after Retry; the later verification
confirmation was sent to the already-linked DM using that saved receipt, without
creating another app. No credentials or OAuth codes are included in this evidence.
The new pre-install challenge path, notification concurrency/restart recovery,
revocation, removal, and provider failure cases passed deterministic fixtures.
In a subsequent two-phase creation run, Slack accepted the manifest update but
sent no URL challenge. An Events API callback returned HTTP 200, and the operator
confirmed a real agent reply without clicking Retry. The new automatic advancement
based on that kind of event is covered by fixtures; the operator subsequently confirmed live automatic advancement after another message.
Same-thread follow-up, reauthorization, and removal qualification remain outstanding.

For live acceptance, use an isolated HTTPS Paperclip instance, a dedicated test
app, and an explicitly authorized Slack workspace and destination. Have the user
enter the configuration token directly. Verify app creation, consent return,
signed URL verification, avatar status, automatic installer linking, welcome DM,
a real message and same-thread follow-up, the assigned agent run, and Slack delivery. Resume an
interrupted setup, reauthorize the same app, and remove the Paperclip connection
with an outstanding attempt. Record sanitized IDs/links and outcomes, without
secret fields, OAuth codes, or provider payloads. Record live results separately
from deterministic fixtures.

Provider references: [Manifest creation API](https://docs.slack.dev/reference/methods/apps.manifest.create/),
[OAuth installation](https://docs.slack.dev/authentication/installing-with-oauth/),
[Manifest reference](https://docs.slack.dev/reference/app-manifest/),
[App icon API](https://docs.slack.dev/reference/methods/apps.icon.set/),
[Sending a DM](https://docs.slack.dev/reference/methods/chat.postMessage/).

## Agent behavior checks

Slack per-turn guidance covers saved interactive questions, automatic final
replies, current-chat file handoff, explicit actions, delivery uncertainty, and
action policies. Tool-description changes refresh the stored catalog without
re-enabling removed tools or changing their review ownership.

The [connector probe catalog](../../server/src/services/connectors/slack/evals/README.md)
keeps eleven manual acceptance probes next to that guidance, with related
deterministic checks selectable through `pnpm test:slack-connector`. No automated
model campaign is registered by that command. An attended legacy Codex test on
2026-10-07 delivered real Slack choices, accepted an answer, resumed the same
task, and returned a correct reply; other probes and runtimes remain unqualified
until their own provider evidence is recorded.
