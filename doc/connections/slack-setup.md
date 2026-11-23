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

Reopening a completed Slack setup retains its Slack handoff. **Done** opens the
saved connection settings without repeating activation or reactivating a paused
bot. Unfinished setups still complete their normal server verification first.

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
Managed provisioning resolves the submitted grant from the Slack manager-grant
registry. Both provisioning and revocation check its company and current user;
these IDs are separate from tool-connection grants.

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
  A saved draft that needs workspace reauthorization shows **Reconnect Slack
  workspace** on Connect, even before its app has been created. This button
  opens Slack authorization and returns to the same saved agent setup.
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
**Open Slack** remains available after automatic setup completion and on the
saved connection page. It opens the current user's bot DM when its workspace
and channel are known and its linked owner matches the signed-in user. Another
manager or an unknown identity uses the saved provider link or Slack instead.

An explicit managed reconnect reinstalls the saved app and verifies the replacement
bot credentials. Its request ID is saved before dispatch, so a duplicate completed
request does not reinstall again. Credential-configuration recovery still resumes
the saved token after a downstream failure. No reconnect creates another Slack app.

## Durable Cloud Events API delivery

A broker that advertises `slackEvents.version=1` can accept a signed Events API
registration after ordinary configuration settles. The producer uses the saved
child app ID, current workspace, signing key, endpoint/connection and runtime
generation. It retains the existing public callback URL. Missing verified app
identity or broker support leaves the existing setup in place; it does not guess
an identity or substitute the Slack manager's signing key.

Cloud stores the child signing key through its existing encrypted stack vault.
Registration metadata and receipts contain no plaintext credentials. An unchanged
credential/endpoint identity reuses its immutable vault ref across generations;
rotation and current registration authority remain separately fenced. Removal
retires exact queue membership and prevents an old generation from reenrolling.
The local configuration transaction first saves nonsecret enrollment or
retirement intent and signals the existing connection-events owner. Broker work
runs through that owner after commit; configuration APIs do not await an optional
Cloud request. Configure, pause and removal can complete locally while Cloud is unavailable. The owner
retries only retained due intent and reconstructs it after restart, including
removal for archived endpoints after credential cleanup. Confirmation replaces
only the same current intent and generation; a completed remote call with a
lost response remains pending. Current authorization errors retain visible
attention debt instead of claiming registration succeeded. Event draining and
acknowledgments run before enrollment reconciliation. The owner then admits one
due enrollment operation and schedules the earliest retained responsibility.
A busy credential lease or enrollment failure retains a bounded retry without
aborting that event drain. Rollback leaves no committed intent to run.

Retirement sends the original responsible subject and the exact instance,
company, endpoint, public ID, connection and monotonic generation. Cloud can
publish a nonreceiving generation floor without a signing key, live descriptor
or previously returned binding ID. This fences delayed enrollment after local
removal. Normal current broker authority still applies; the subject alone does
not authorize an operation. An instance that never enrolled with Cloud creates
no new intent or background retry when Cloud is absent. Previously configured
retirement responsibility retains its original instance identity as visible
attention if that identity becomes unavailable. Unsupported capability or disabled
new enrollment retains bounded retry responsibility; a closed generation or
identity conflict requires attention. Current authorized confirmation is required
before clearing the exact pending intent.

Ordinary redeploys retain the same stack identity. To move enrollment to another
stack, first confirm retirement under the old stack's authority, with no pending
old intent. Then explicitly reconfigure under the new authorized stack at a newer
runtime generation. The old stored identity remains until the new broker receipt
matches the current intent and generation. An environment change cannot transfer
live responsibility. Unavailable old authority remains visible attention.

A missing or disabled signing credential also requires attention. Enrollment does
not retry it as a broker outage. Incoming receipts retain typed attention before
SDK admission; uncertain authentication does not acknowledge the receipt.

Only authenticated `event_callback` messages use this durable lane. The sealed
queue retains original bytes, signature, timestamp and acceptance time. The app
checks current endpoint/generation authority before SDK handling. It verifies
original freshness at Cloud acceptance; ordinary external requests still use
current time. The credential snapshot lease releases before normal lifecycle
callbacks reacquire their own leases.

Private replay provenance prevents internal replay URLs from replacing saved
external callback verification evidence. The normal transactional chat delivery
ledger remains the message admission authority. An ambiguous callback or ACK
failure retains its receipt; malformed receipts rejected before useful admission
can be explicitly ignored with bounded diagnostics. Credential-authentication
uncertainty requires attention and is not silently acknowledged. The broker's
existing retention horizon remains the disclosed recovery boundary.

This does not qualify a complete Slack endpoint for sleep. Slash commands,
interactive actions, modal validation and challenges still need their full
synchronous response semantics. The endpoint blocker remains. Qualification
must cover normal signed enrollment, durable retry after removal, sealed drain,
the actual event worker and SDK, lost-ACK redelivery and one domain effect,
generation changes, and callback evidence. Synthetic protocol coverage does not
prove live Slack, complete configuration UI or a deployed stop/restart/wake journey.

### Reproduce the paired Cloud acceptance

Use the repository's supported Node version and installed dependencies. Compile
the companion Cloud checkout first. Set `PAPERCLIP_SLACK_TEST_DATABASE_URL` and
`SLACK_EVENT_TEST_DATABASE_URL` to two distinct, owned loopback PostgreSQL
`*_test` databases. Set `SLACK_TEST_CLOUD_DIST` to its absolute compiled `dist`
directory. This test applies actual migrations and uses only those two databases.
It does not create a PostgreSQL cluster or use a live Slack provider.

From the app repository root, run:

```sh
node server/scripts/test-slack-cloud-postgres.mjs
```

The launcher uses the current Node executable and one Vitest worker. It loads the
checked-in prewire guard in that actual worker before client construction. The
controlled process child explicitly loads the same guard before its script.
The guard rejects off-host and unowned socket targets before transport. Caught
unexpected attempts still fail the fixture. No private preload path or manual
`SLACK_GATE_GUARD_PID` setting is needed. The fixture remains opt-in during the
normal test suite; its default owner and guard regressions run without databases.
