# Slack app ownership and setup

Slack has one chat runtime and two provisioning paths. A saved connection's
`slackSetupMethod` selects provisioning; it does not change tools, scopes,
conversation routing, people permissions, or channel access.

| Method | App creation and installation | Default |
| --- | --- | --- |
| `managed` | A personal Slack manager grant creates a child app; managed installation supplies its bot token. Slack consent/admin approval remains a fallback. | New drafts on qualified Cloud deployments only |
| `automatic` | A temporary app configuration access token creates a customer-owned app; the user approves its OAuth installation. | New self-hosted drafts and Cloud without managed availability |
| `manual` | User creates an app from the canonical manifest and enters credentials. | Legacy drafts with no saved method |
| `existing` | User supplies credentials for an existing app. | Explicit selection |

Existing drafts and active bots retain their method. Enabling managed setup never
adopts existing apps. Choose agent offers **Use your own app** under **Advanced**, below Slash command,
when the instance supports managed setup and creation has not started. The own-app flow retains **Create manually** and **Use an existing
app** under Advanced. After creation dispatch, a managed draft cannot switch paths.

Managed setup has two visible stops: Choose agent and Connect. **Continue** starts
manager authorization or installation in the saved workspace automatically. Multiple
workspaces still require a selection. Recovery actions remain explicit; opening
a failed or uncertain registration never retries creation automatically.
Creation, installation, message waiting, and success use the same production
components and server evidence as the own-app flow. A click or OAuth return does
not constitute successful configuration.

## Per-agent permission opt-ins

Each agent's Slack app requests the standard bot scopes by default, including
`im:write`. These scopes cover reading channels and DMs, replying, reactions,
pins, bookmarks, canvases, lists, topics, and looking up workspace members
(`users:read`, plus `users:read.email` so `slack_find_user` can match by email).
Outbound DMs are therefore standard for every agent; there is no separate
**Proactive DMs** checkbox. Workspace approval policy still determines whether
Slack asks for administrator review.

Two additional capabilities remain optional. They are grouped so an operator can see what
an agent gains:

| Group | Bot scopes | What it adds |
| --- | --- | --- |
| Channel management | `channels:manage`, `groups:write` | Create channels and invite people. |
| File upload | `files:write` | Upload task attachments into Slack. |

An agent starts with every optional group **off**. Choose agent and the connection's
**Settings → Slack permissions** section list each group with its description and
exact scopes. Turning a group on adds its scopes to that agent's manifest only.

### Admin approval and reauthorization

Adding an optional scope may require workspace-admin approval under Slack's
approval policy. A denial leaves the connection exactly as it was.

Enabling a group for an app that is already installed does not change what the
bot can do until Slack grants the new scopes. Until then the connection keeps its
previous permissions and the affected tools stay unavailable. The UI shows each
group as:

- **Off** — neither requested nor installed.
- **Requested — applied at install** — before the first install, the group is
  part of the request Slack will grant.
- **Requested — reinstall to activate** — you asked for it after an install, and
  the running installation does not hold it yet.
- **Enabled** — requested and granted by the current install.
- **Enabled — stays on until you reinstall** — you removed it, but the running
  installation still holds it.

The same applies to the default `im:write` scope. A legacy or existing
installation that does not have it keeps its current grant; existing bot tokens
do not acquire it automatically. Refresh the manifest and reconnect/reinstall
the app before outbound DM tools become available.

### After a change

A saved change differs from the live grant, so Paperclip shows a reinstall
action. The path depends on the setup method:

- **Managed** — select **Reinstall in Slack** on the connection page (or
  **Continue in Slack** in the setup wizard). Paperclip writes the new manifest,
  then reinstalls the same app. A workspace admin approves the new scopes.
- **Own app** — select **Update app and reinstall**, then supply the app
  configuration access token again so Paperclip pushes the updated manifest, then
  reinstall the app in Slack.

The saved change is stored immediately, so leaving the page does not lose it. It
applies only after the manifest update and reinstall succeed. Restoring the
installed group set clears the pending marker only if the changed manifest has
not yet been pushed to Slack. After a push, the restored manifest must be applied
again before reconnecting. Paperclip keeps the configuration action visible until
that update finishes, even when requested and installed groups match. Group
badges still describe the live grant, not the pending manifest.

### Legacy installations

An installation that predates per-agent opt-ins carries no saved request. It
keeps the full grant it was installed with, so Settings shows both optional
groups enabled and shows no reinstall prompt. Nothing is pending until an
operator changes a group. The first change then becomes an ordinary pending
change. Its grant may still lack the now-default `im:write`; refresh the
manifest and reconnect/reinstall to add that scope.

New drafts always store an explicit (possibly empty) request, so a new agent never
inherits the legacy full grant.

The shared model and helpers live in
[`packages/shared/src/slack-scopes.ts`](../../packages/shared/src/slack-scopes.ts).
The UI controls are
[`ui/src/pages/apps/chat/SlackScopeOptIns.tsx`](../../ui/src/pages/apps/chat/SlackScopeOptIns.tsx)
with state derivation in
[`slack-opt-in-state.ts`](../../ui/src/pages/apps/chat/slack-opt-in-state.ts).

## Cloud deployment prerequisites

Managed setup is disabled by default. Qualification requires all of:

- The instance chat-connector rollout gate and connection-management permission.
- Verified Cloud runtime identity, connector broker signing/sealing configuration,
  and valid independently configured public board and webhook HTTPS origins.
- `PAPERCLIP_SLACK_MANAGED_SETUP_ENABLED=true` on the approved tenant deployment.
- The companion Cloud broker deployment with the explicitly enabled `slack.manager`
  profile, approved Slack manager app, token rotation, and its client secret in
  the broker's secret store. No manager client secret belongs in the tenant.

The broker must advertise its manager app identity as well as the enabled profile.
Previously saved grants from a different manager app are not reused. A broker
without this capability leaves managed setup unavailable. Do not enable the tenant
gate until real Slack qualification has passed; fixture coverage does not prove
Marketplace eligibility or a workspace's approval policy.

Self-hosted instances do not need a Paperclip account, broker enrollment, manager
credentials, or hosted-service calls. They continue using the own-app flow.

## Personal workspace authorization

Manager grants belong to a company **and one Paperclip user**, and bind a verified
Slack user, workspace, and manager app. Another company member must authorize their
own account, even for the same workspace. Access and rotating refresh tokens are
user-scoped vault entries. Refreshes serialize across connections, persist the new
refresh token, and require fresh authorization after an ambiguous exchange.

Revoking a grant requests provider revocation, removes its local credentials, invalidates pending manager
authorization, and prevents future provisioning with it. The local activity records whether provider revocation succeeded. Provider errors never restore local access. It does not uninstall
apps or disable already-installed bots. Removing a bot deletes endpoint-specific
secrets and pending setup attempts; a reusable personal manager grant survives.
Provider-side app removal remains explicit through the saved Slack management URL.

## Recovery

- A dispatched creation with an unknown result is **uncertain**. Never automatically
  create again. The user must inspect Slack and explicitly confirm that no app was
  created before a new request identity is accepted.
- Denied or pending installation retains the app. Resume with the same grant or
  complete the child app's state-bound OAuth approval; the installer must match the
  grant's Slack identity before personal linking.
- Returned bot credentials are vaulted before inventory or runtime configuration.
  Retry connecting reuses those credentials after network or inventory failures.
  Rejected or under-scoped bot credentials instead reinstall the saved app; they
  never trigger another app creation.
- Manifest updates finish before managed installation. Changes requiring updated
  permissions therefore pass through installation again before activation.
- Expired or revoked manager grants require reconnection. Losing managed
  availability pauses setup; it never changes the saved ownership method.
- Slack rate limits are grouped by manager/workspace/method. Provider `Retry-After`
  is persisted across matching grants in the company, survives restarts, and blocks
  early retries. Other tenant instances must observe Slack's limits independently;
  no background loop retries app creation.

All OAuth attempts bind company, actor/session, endpoint, registration revision,
and configured origins, expire after ten minutes, and are claimed once before
exchange. HTTP diagnostics redact manager tokens, refresh tokens, codes, and sealed
handoffs. Local activity records contain only IDs and safe outcome codes. This adds
no first-party telemetry.

## Code and verification

Server provisioning lives in `server/src/services/connectors/slack/setup/`;
`chat-slack-registration.ts` remains the compatibility facade. Shared completion
owns credential binding, personal linking, welcome messages, and verification.
Removal cleanup stays independently callable. Slack wizard components and stage
selection live in `ui/src/pages/apps/chat/slack/`.

Inbound workspace checks and authenticated setup evidence resolve only the current
signing secret. They do not read bot or app tokens for signature checks. Runtime
setup still resolves its full credential set. Each check uses the saved company
and connection, current secret version, and normal secret access audit path.

Production Storybook journeys: **Connections / Slack / Managed setup** and
**Connections / Slack / Automatic setup** (the persisted own-app automatic path).
Server integration cases cover personal grants, duplicate requests, uncertain
creation, approval fallback, refresh, revocation, removal, saved-credential recovery,
rate limits, and secret canaries. Browser cases are in
`tests/e2e/chat-adapters-ui-providers.spec.ts`; companion broker tests cover manager
user OAuth and the authenticated tenant handoff.

Before enabling a deployment, create two test agents in the authorized workspace.
The second must reuse the personal grant without another configuration token or
manager authorization. Verify avatars, identity linking, signed inbound events,
and same-thread replies. Record real approval behavior separately from fixtures.

### Managed setup during broker outages

Cloud deployments configured for managed Slack keep the managed default when the broker profile is temporarily unavailable. New drafts remain on **Connect** and offer **Retry**. **Use your own app** remains available under **Advanced** on Choose agent before creation. Discovery loading or failure never selects the configuration-token page. Self-hosted instances without managed configuration still use their independent own-app flow; saved draft methods do not change automatically. Provisioning continues to require current broker availability.

### Local managed-bot qualification

Maintainers with an approved Slack manager app can exercise the real managed
journey from an authenticated local test drive exposed through HTTPS (including
TryCloudflare). This development transport talks directly to Slack and reuses
the production manager-grant vault, state claims, provisioning, completion, and
runtime. It does not exercise the Cloud broker's sealed handoff; qualify that
separately on staging afterward.

Set `NODE_ENV=development`, `PAPERCLIP_SLACK_MANAGED_SETUP_ENABLED=true`, and
`PAPERCLIP_SLACK_MANAGER_DEVELOPMENT_CONFIG` to an absolute path outside the
checkout containing a mode-0600 JSON file with `appId`, `clientId`, and
`clientSecret`. Use only an authorized qualification manager app. No credentials
are shipped with Paperclip. Production ignores this development configuration,
and Cloud runtime identity continues to select the Cloud broker.

Configure the local instance for authenticated public access, with its public
URL and chat webhook URL pointing to the HTTPS tunnel. Add the exact public URL
plus `/api/chat-slack/managed/oauth/callback` to the manager app's OAuth redirect
URLs, preserving any existing redirects. Start a **new** Slack setup: saved
own-app drafts retain their selected method. Authorize the manager app normally;
do not copy user grants from another instance. The second bot should reuse the
same local user's vaulted grant. A changed tunnel requires updating public
origins and the manager redirect before starting fresh authorization.

Remove the temporary redirect when retiring the test drive and securely remove
its development credential file. Removing a bot does not revoke a manager grant
used by other bots.

### Test messages from Settings

**Send me a test message** sends a DM to the signed-in connection manager,
using their linked identity in this workspace. If this bot is not linked yet,
Paperclip can reuse that user's verified manager grant or another bot's linked
identity in the same company and workspace. Otherwise, the user selects their
Slack account and receives a private connection invitation in Slack. They must
open that invitation, sign in, and confirm before Paperclip links the account and
sends the test DM. The account picker loads further workspace pages on request. Existing revoked or conflicting identity links are not overwritten.
Direct messages must be enabled, and the user must be an active company operator.

The action records a durable request before sending. Repeating the same request
returns its saved result; an uncertain delivery is never automatically resent.
**Open Slack configuration** opens the saved app's OAuth & Permissions page.
Legacy connections without an app ID open Slack's app list instead.

An explicit managed reconnect reinstalls the saved app and verifies the replacement
bot credentials. Its request ID is saved before dispatch, so a duplicate completed
request does not reinstall again. Credential-configuration recovery still resumes
the saved token after a downstream failure. No reconnect creates another Slack app.
