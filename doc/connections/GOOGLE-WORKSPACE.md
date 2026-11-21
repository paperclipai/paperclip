# Google Workspace connections

New Google Workspace setup uses one `google-workspace` connection and the
`workspace.all` OAuth profile. Paperclip first offers Gmail, Drive (including
Docs, Sheets, and Slides), and Calendar. All three start enabled with read and
write access. Users can disable a group or choose read-only access. New setup
does not offer Chat, Contacts/directory, or cross-service Search.

The built-in connector is behind the default-off `enableGoogleWorkspaceConnector`
experimental setting while Paperclip's Google app verification is pending. When
the setting is off, the Apps page hides the built-in connector, and the server
blocks its setup, discovery, and execution. Google apps from MCP aggregators
(for example Composio Gmail, Google Calendar, and Google Drive) then appear in
the catalog instead. Saved per-service Google connections stay visible and usable.
Turn the setting on in **Settings → Experimental** to test the built-in connector.

The combined connection has one credential grant, capability catalog, policy
profile, audit trail and reconnect lifecycle. It requests only the selected
groups' scopes (ten scopes for the default selection), not the legacy full
union. Google's consent screen also lets users decline
permissions; discovery skips services without grants and excludes unsupported
actions. The gateway checks actual grant scopes again before each call, including
after refresh. Requested scopes alone never authorize an action.

Before managed or customer-owned OAuth opens, Paperclip saves the validated
service choice as non-secret setup intent on the draft. It is bound to the
company, connection, initiating actor, grant kind, and credential subject.
Declined or expired authorization and a cold **Finish setup** return restore
that choice, not the new-account write defaults. Historical drafts without a
matching saved intent require an explicit choice. Reconnecting an established
account without a new choice keeps its exact grant request.

Overlapping customer-owned starts preserve the latest saved draft choice through
client binding and authorization metadata updates. Each OAuth state and consent
URL keeps that attempt's own requested scopes. These updates preserve unrelated
current settings and other users' pending proposals in both configuration records.

An agent can hand setup to its responsible human without choosing services or
creating provider OAuth state. If the agent proposes services, the human can
review and change them in the picker. Saving the human's choice consumes only
that person's pending proposal, so an old proposal cannot replace their choice
after a declined sign-in. Neither draft intent nor a proposal is consent.

Discovery isolates service outages. Healthy services remain usable while the
connection's health message identifies unavailable services and recommends a
catalog refresh. Failed services' cached actions are disabled until rediscovered;
an outage affecting every requested service still fails the refresh. Loss of the
shared OAuth grant never degrades into a successful partial discovery. Because
the catalog is shared, actions skipped because of narrower consent are preserved
when another active grant supports them. Failed services and tools removed from a
successful discovery are still disabled. Each caller's listing and dispatch use only their
selected grant, without combining permissions from different identities.
Individual call failures are reported and audited without marking unrelated
Google services unhealthy; they do not trigger automatic write retries.

Existing individual product connections and their direct setup routes remain
supported. They are not automatically merged, upgraded or reauthorized. The Sheets
robot-account method remains separate because it uses explicitly shared files,
not the user's Google OAuth identity.

Google's hosted Workspace MCP servers are Developer Preview services. The app
endpoints remain separate. Paperclip namespaces actions by service and routes them
to a closed endpoint registry using the combined grant. It does not create child
connections or send provider tokens through Paperclip ID.

Each service has a tool transport, set in `GOOGLE_WORKSPACE_TOOL_TRANSPORT`
(`packages/shared/src/google-workspace-connectors.ts`). `google_mcp` sends calls
to Google's hosted MCP server for that service. `paperclip_rest` runs Paperclip's
own tools over Google's REST APIs, in the server process
(`server/src/google-workspace-rest-tools/`), with the same tool names, inputs
and results. Every service is on `google_mcp` today. A service can move to
`paperclip_rest` only when Paperclip implements every tool on its allowlist; a
test enforces that. On either transport, the same grant scope checks, approvals,
audit, token refresh and reconnection, prompt-injection screening, cancellation
and experimental-feature gate apply. On `paperclip_rest`, discovery and health
checks prove the token with one cheap REST read per service that the granted
scopes allow (for example, Gmail reads the account profile) instead of Google's
`tools/list`. A grant that allows no such read is listed without one, and a
failed check makes only that service unavailable. See the
folder's `README.md` for how to switch a service and how to remove the REST
tools.

Google results are untrusted content. The prompt-injection guard checks them
before an agent receives them; see
[Google Workspace content](../prompt-injection-prevention.md#google-workspace-content)
for what it covers and what it does not.

The catalog reuses the existing reviewed Google mark (`google-people.svg`),
registered under its own `google-workspace` brand identity. No new artwork is
downloaded or substituted for a product logo.

## Combined profile deployment and verification

Deploy the companion Cloud broker registry before enabling `workspace.all` in
`CLOUD_HARNESS_CONNECTOR_GOOGLE_ENABLED_PROFILES`. It uses the existing WORKSPACE
client pair; that client's Cloud project must have every applicable MCP API and
preview enrollment. Do not remove legacy enabled profiles while their grants are
in use. This code change does not enable the broker profile or deploy any stack.

The signed request and envelope authentication bind the exact selected request.
Refresh binds the 14 scopes submitted for Google verification
(`GOOGLE_WORKSPACE_SUBMITTED_SCOPES`), which the broker accepts as a subset of
its registry. The encrypted credential payload preserves Google's actual
nonempty subset. An authorization request with any scope outside the 14 is
rejected. Callback and refresh use one contract on both managed and
customer-owned OAuth: Paperclip caps Google's reported scopes to the 14 and to
the saved request, and continues. A scope outside the 14 (for example a former
Chat, Contacts, Directory, profile or `calendar.readonly` grant) is ignored and
never enables an action. Only missing scope evidence or an empty result needs
reconnecting, and reconnecting with a new service choice always works.
Individual legacy profiles retain exact matching.

Paperclip's own Google client never starts consent for a profile outside the
14: `gmail.archive` (`gmail.modify`), `chat.read`, `chat.write`, `people.read`
and `workspace-search.read`. Their Apps methods are no longer offered for new
setup even when the broker advertises them, and reconnecting a saved connection
on one of them is refused. Saved connections keep resolving their method,
refreshing and running. Customer-owned OAuth methods for those services are
unchanged.
For the new `google/workspace.all` profile only, HKDF info is SHA-256(AAD) to
remain below Node's 1024-byte limit. AES-GCM still authenticates the complete AAD;
legacy envelope key derivation is unchanged.

Managed OAuth: browser → Cloud `/v1/connector/sessions` → Google
`https://accounts.google.com/o/oauth2/v2/auth` → Cloud
`/v1/connector/oauth/google/callback` → instance
`/api/tools/oauth/cloud-connector/callback`. Cloud exchanges codes and refreshes at
`https://oauth2.googleapis.com/token`; provider tool calls go directly from the
instance to the fixed endpoints below. Customer OAuth uses the instance's existing
`/api/tools/oauth/callback` instead. Register that exact HTTPS or loopback callback
on the customer-owned client.

Removing a managed connection or grant asks Paperclip Cloud to revoke it (see
"Removing a managed Google connection" below). Before rollout, verify full and partial consent with an enrolled
test account, allowed reads/writes, reconnect, refresh and removal. Deterministic
tests are not real-provider proof. Combining profiles simplifies onboarding, not
Google's per-scope demonstration, justification or security-assessment obligations.

Sources: [granular consent](https://developers.google.com/identity/protocols/oauth2/resources/granular-permissions),
[Workspace MCP setup](https://developers.google.com/workspace/guides/configure-mcp-servers).

## Connections catalog and rollout

The Connections page offers one Google Workspace card for new accounts. Saved
individual-service accounts stay visible and retain their management routes.
This replaces the earlier display-only Google visibility hold. Showing the card
does not enable managed OAuth: signed instance-specific broker availability
still controls it. A customer-owned OAuth app remains a separate setup method.

Do not upgrade or unpin existing verification instances as an implementation
step. Qualify the selected-scope flow on an isolated reviewer staging app first.
See [service consent](GOOGLE-WORKSPACE-SERVICE-CONSENT.md) for the app/broker
deployment order and live verification gates.

## Developer Preview enrollment

Google grants preview access to the specific Workspace email addresses and
Google Cloud project numbers registered with the program. Submitting the form
is not the approval signal:

1. Google first sends a Google Group membership notification after verifying
   the Workspace account.
2. Google then sends a final confirmation after registering the Cloud project,
   usually within a couple of days. This final email is the signal that MCP
   testing can begin.
3. If no final confirmation arrives within a week, check spam and contact the
   Developer Preview program team from the
   [program page](https://developers.google.com/workspace/preview).

Enrollment does not authorize every user of an OAuth client. Additional tester
emails and Cloud projects must be added through Google's member request forms.
Google's preview terms also prohibit making a pre-GA integration available to
end users outside the enrolled company or domain unless Google grants explicit
permission. Consequently, Paperclip-managed Google OAuth is limited to
registered internal testers during preview. Other companies must enroll their
own Workspace testers and Cloud project and use a customer-owned OAuth app until
Google makes Workspace MCP generally available.

## Service endpoints and legacy capability choices

| App card | MCP endpoint | Capability choices |
| --- | --- | --- |
| Gmail | `https://gmailmcp.googleapis.com/mcp/v1` | Read only; read and create drafts |
| Google Drive | `https://drivemcp.googleapis.com/mcp/v1` | Read only; read and create files |
| Google Docs | `https://docsmcp.googleapis.com/mcp/v1` | Read only; read and edit |
| Google Sheets | `https://sheetsmcp.googleapis.com/mcp/v1` | Read only; read and edit; share selected sheets with the robot account |
| Google Slides | `https://slidesmcp.googleapis.com/mcp/v1` | Read only; read and edit |
| Google Calendar | `https://calendarmcp.googleapis.com/mcp/v1` | Read only; read and manage events |
| Google Chat | `https://chatmcp.googleapis.com/mcp/v1` | Read only; read and send messages |
| Google People | `https://people.googleapis.com/mcp/v1` | Read contacts |
| Google Workspace Search | `https://workspacemcp.googleapis.com/mcp/v1` | Search Workspace |

Legacy product setup exposes capability choices under Change. The combined
Workspace setup has one capability and asks for service groups before Google
consent. The endpoint table also documents legacy connections; it is not the
new-account service list.
When the managed method is
available, it uses Paperclip by default. A small **Use your own Google OAuth app**
link reveals the custom client fields; **Use Paperclip instead** returns to the
managed method. The available authentication methods are:

- **Connect with Paperclip** uses the Paperclip Cloud broker when that exact
  profile is returned for this enrolled instance by the signed
  `POST https://my.paperclip.app/v1/connector/instance-status` request. The
  anonymous capabilities document is global discovery only and never enables
  an internal-pilot method locally.
- **Use your own Google OAuth app** uses customer-supplied OAuth credentials and
  the app definition's exact reviewed scopes.
- **Use the Paperclip robot account** remains an additional Google Sheets-only
  option for explicitly shared spreadsheets.

Before Google consent, the setup flow shows the credential's human and agent
access and lets the user change it. A personal choice stores
the tokens only on that user's grant. A company choice stores them on the
default organization grant, while still recording which signed-in Google
principal completed consent so refresh and reconnect stay bound to that
principal.

Catalog discovery and connection creation use the same signed, instance-specific
profile availability. Local enrollment files and Cloud-delivered environment
identities follow this same path; neither enables managed methods globally in
the static app definitions. Saved connections remain recognizable for OAuth
callback, refresh, and revoke, while the broker enforces current profile access.
Switching capability or authentication methods preserves the selected credential
owner when the new method supports that owner.

## Legacy product-specific broker profiles

The Paperclip-managed method signs every broker request with one explicit
profile. The broker binds that profile into sessions, one-time claims, sealed
token envelopes, and refresh.

### Removing a managed Google connection

Removing a Paperclip-managed Google connection, or one of its per-user,
organization or per-agent grants, sends each removed grant's refresh token to
Paperclip Cloud's signed `POST /v1/connector/revoke`. Revoke signs with the
subject that consented to the grant (`providerTenant.externalId`, saved by the
managed callback), which is the subject of the broker's ledger row from the
claim. Grants saved without it fall back to the subject refresh uses. Refresh
keeps its own existing subject rule.

The broker removes its record for that token. It revokes at Google only when it
knows of no other live binding that could share the grant, because Google's
revoke ends the user's whole grant to the managed client. A repeated call for a
token it already removed returns the outcome it recorded. Its `outcome` is one
of `revoked`, `other_connections_remain`, `provider_revocation_failed`,
`binding_not_known`, `provider_revocation_disabled` or
`revocation_in_progress`. The app adds `revocation_not_available` (an older
broker's 409), `broker_unavailable` (timeout, network failure or no usable
Cloud client), `broker_error`, `credential_unavailable` and
`unexpected_error`.

Order for removing a whole connection: read the refresh tokens; run the whole
local teardown (grants, installs, the app-managed profile, gateway tokens and
sessions, runtime slots, catalog status, OAuth state, archive the connection);
then call the broker, one token at a time under one 5-second deadline; then
delete the refresh-token secrets that were sent, whatever the outcome; then
delete the remaining secrets. The broker step never throws, is never retried,
and never changes the local outcome. A failure anywhere in the teardown makes
no broker call and leaves the token in place.

Order for removing one grant: read the token, commit the grant revocation,
call the broker, then delete the grant's refresh-token secret.

Deletion is compare-and-delete. Whether the connection owns the secret is
checked first. Then `secrets.remove(secretId, { expectedVersion })` claims the
row in one statement only if it is not deleted and its `latestVersion` still
equals the version that was read, and only then runs the usual provider-side
deletion and row removal. No caller transaction or row lock is held, and the
broker call never runs inside a transaction. A managed Google sign-in that finishes
during the call always writes a new version of the refresh token, so the new
sign-in's token is never deleted, and a later removal sends that new token. A
sign-in that returns no refresh token is refused before anything is written
(`oauth_refresh_missing`), so it cannot reactivate the grant with the old
token. During a whole-
connection removal a sign-in cannot complete after the teardown: the teardown
deletes the connection's OAuth states, and the callback must consume its state
in its own transaction. An organization
grant shares its secrets with the connection's own credential (the shared
sign-in writes the same refs to both), so revoking it alone neither calls the
broker nor deletes the secret; removing the connection does both. The same
holds for any refresh-token secret still used by another live grant or
connection.

A revoked managed Google grant whose refresh-token secret still exists, and is
used by nothing live, is a revocation still owed (for example, the process
stopped after the teardown and before the call). Every later removal of that
grant or connection sends it, then deletes the secret. Once the secret is
gone, nothing is sent again. The token outlives the removal only in that crash
window.

`providerAccess: { provider, result, outcomes }` is returned with the removal
and recorded in its activity entry, codes only. Once the broker call settles,
the connection's audit history also gets a `connection.google_access_removal`
event with `reasonCode` set to the result and `providerAccess` (plus `grantId`
for a single grant) in its details. This includes owed revocations sent on a
retry. If that write fails, the removal still succeeds and the failure is
logged. The result is judged over the
distinct tokens sent:

| Outcomes | `result` | Message |
| --- | --- | --- |
| Every token `revoked` | `ended` | Access was ended at Google |
| Any other code (failure, not known, unavailable, error) | `not_ended` | Could not end access; link to https://myaccount.google.com/connections |
| Only `other_connections_remain` | `other_connections_remain` | Other connections keep access |
| At least one `revoked`, the rest `other_connections_remain` | `ended_unconfirmed` | Access was ended; check Google if more than one account was connected; link to the same page |

The last row is the sequence the broker returns for two tokens of one Google
grant sent one at a time, but two different Google accounts can return it too.
Grants record no Google account identity (none of the 14 scopes returns one),
so the app cannot report `ended` for it.

Connections on a customer-owned Google OAuth client are removed locally only.

| App | Read profile | Write profile |
| --- | --- | --- |
| Gmail | `gmail.read` | `gmail.draft` |
| Drive | `drive.read` | `drive.write` |
| Docs | `docs.read` | `docs.write` |
| Sheets | `sheets.read` | `sheets.write` |
| Slides | `slides.read` | `slides.write` |
| Calendar | `calendar.read` | `calendar.write` |
| Chat | `chat.read` | `chat.write` |
| People | `people.read` | — |
| Workspace Search | `workspace-search.read` | — |

Every new signed request includes a profile. The Cloud broker rejects a request
whose provider, profile, or exact scope set does not match its closed registry.

## Instance configuration

All Paperclip-managed Google methods use the existing enrolled-instance keys:

```dotenv
PAPERCLIP_CLOUD_CONNECTOR_BASE_URL=https://my.paperclip.app
PAPERCLIP_CLOUD_CONNECTOR_ENVIRONMENT=production
PAPERCLIP_CLOUD_CONNECTOR_INSTANCE_ID=inst_example
PAPERCLIP_CLOUD_CONNECTOR_SIGN_PRIVATE_KEY=...
PAPERCLIP_CLOUD_CONNECTOR_SEAL_PRIVATE_KEY=...
```

No per-app client secret is stored on the Paperclip instance for the managed
path. For customer-owned OAuth, the setup flow collects that customer's Google
OAuth client ID and secret and stores them through the normal instance-vault
path.

Cloud-hosted stacks receive these values through the existing per-stack secret
delivery path. A self-hosted instance creates its keys during enrollment and
stores them with owner-only permissions in the instance's ignored secret
directory. The setup page supplies its authenticated same-origin HTTPS address
to enrollment, so a normal Tailscale-hosted self-hoster does not need to edit
`config.json` or set `PAPERCLIP_PUBLIC_URL`; the enrolled origin becomes the
durable callback binding. The former `PAPERCLIP_ID_CONNECTOR_*` values use an incompatible
Paperclip ID protocol and are not read aliases. Enroll with Paperclip Cloud and
reconnect legacy grants before their old access tokens expire.

The gallery requests the broker capability document with a short cache. A
Paperclip-managed method is omitted unless its exact profile is enabled at the
broker; the independent app card and customer-owned OAuth method remain
available. This supports profile-by-profile rollout and rollback without
collapsing the nine cards into one app.

See [Gmail connection](./GMAIL.md) for the detailed enrollment, signing,
encryption, environment-isolation, and security review runbook inherited by all
profiles.

## Safety boundary

Every Google profile has an explicit MCP tool allowlist. Unknown Developer
Preview tools default to disabled. Read profiles expose only reviewed read
operations. Write profiles add only the reviewed write operations for their app;
destructive or unreviewed tools do not become available merely because Google
adds them upstream.

### Service-specific minimum scopes (2026-09-30)

Docs, Sheets, and Slides request only their service's read-only scope in the
read profile and its read/write scope in the write profile. They do not also
request `drive.readonly` or `drive.file`: those are authorization alternatives,
not additional requirements. Drive and Workspace Search retain their separate
Drive permissions. The per-service Calendar write profile requests
`calendar.calendarlist.readonly` and `calendar.events`; Google's MCP
`suggest_time` accepts `calendar.events`. Calendar read retains
`calendar.events.freebusy` alongside list/event read-only access. The combined
connection's read & write Calendar selection also requests
`calendar.events.freebusy` (2026-11-17), because Google's REST
[`freeBusy.query`](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query)
does not accept `calendar.events`. The per-service profile keeps its exact
scope set for the Cloud broker.

References: Google's [Docs read](https://developers.google.com/workspace/docs/api/reference/mcp/tools_list/read_doc)
and [update](https://developers.google.com/workspace/docs/api/reference/mcp/tools_list/update_doc),
[Sheets read](https://developers.google.com/workspace/sheets/api/reference/mcp/tools_list/get_spreadsheet)
and [update](https://developers.google.com/workspace/sheets/api/reference/mcp/tools_list/update_values),
[Slides read](https://developers.google.com/workspace/slides/api/reference/mcp/tools_list/read_presentation)
and [update](https://developers.google.com/workspace/slides/api/reference/mcp/tools_list/update_presentation),
and [Calendar suggest_time](https://developers.google.com/workspace/calendar/api/v3/reference/mcp/tools_list/suggest_time).

The write scopes support editing existing accessible files by ID. `drive.file`
is a valid narrower alternative for app-authorized files, but would require a
different per-file authorization workflow. Read-only profiles remain separate;
the project-wide union is not the scope set requested by every connection.

Deploy with the matching Cloud broker registry and test fresh grants in staging
before production. Signed authorization and refresh requests use exact scope
sets, so mixed versions fail closed. The broker rejects old broader grants and
refresh responses without explicit scope evidence for these reduced profiles.
Reconnect affected connections; do not relabel or globally revoke existing
tokens. Customer-owned methods request the same reduced sets on new consent;
previously issued grants are not retroactively narrowed. The 21-scope integration
union is unchanged by these profile-level reductions. Console must still keep
Drive/free-busy entries required by other profiles and separately used identity
scopes. Fresh provider proof is a release requirement, not implied by unit tests.

### Google Chat scope reduction (2026-09-22)

`chat.read` requests only `chat.spaces.readonly` and `chat.messages.readonly`.
`chat.write` adds `chat.messages.create`. The same sets apply to both managed
and customer-owned OAuth methods. Neither requests `chat.memberships.readonly`
nor `chat.users.readstate.readonly`.

Conversation lookup, message history, ordinary message search, and the write
profile's message sending remain supported. Membership listing and marking
messages read/unread remain outside the tool allowlist. `search_messages`
cannot filter by read state: the app hides `isUnread` from its agent and Test
schemas and rejects any explicit `isUnread`/`is_unread` argument, including
`false` or `null`, before dispatch. It never silently drops the filter. The
guard also applies to cached catalogs and existing broader grants.

References: Google's [Chat MCP setup](https://developers.google.com/workspace/chat/api/guides/configure-mcp-server)
and [message-search parameters](https://developers.google.com/workspace/chat/api/reference/mcp/tools_list/search_messages).

Roll out the app and Cloud broker scope registries together in staging and
production: their signed requests and sealed credentials use exact scope sets.
During a mixed-version rollout, Chat authorization/refresh can fail closed.
Existing Google tokens are not retroactively narrowed or revoked by this code
change. A refresh response still containing removed scopes, or omitting the
scope set needed to verify the grant, is rejected by the broker; reconnect
affected Chat grants for new consent. Do not revoke the
shared Google client to migrate one profile, because that can break other
Workspace connections. After deployment, verify fresh reduced-scope consent,
ordinary Chat search/history and sending, then reconcile Google Console and
the verification evidence with the deployed scope set.
