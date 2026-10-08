# Google Workspace connections

New Google Workspace setup uses one `google-workspace` connection and the
`workspace.all` OAuth profile for these nine services:

1. Gmail
2. Google Drive
3. Google Docs
4. Google Sheets
5. Google Slides
6. Google Calendar
7. Google Chat
8. Google People
9. Google Workspace Search

The combined connection has one credential grant, capability catalog, policy
profile, audit trail and reconnect lifecycle. It requests the existing 21-scope
union, not additional permissions. Google's consent screen lets users decline
permissions; discovery skips services without grants and excludes unsupported
actions. The gateway checks actual grant scopes again before each call, including
after refresh. Requested scopes alone never authorize an action.

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

The catalog reuses the existing reviewed Google mark (`google-people.svg`),
registered under its own `google-workspace` brand identity. No new artwork is
downloaded or substituted for a product logo.

## Combined profile deployment and verification

Deploy the companion Cloud broker registry before enabling `workspace.all` in
`CLOUD_HARNESS_CONNECTOR_GOOGLE_ENABLED_PROFILES`. It uses the existing WORKSPACE
client pair; that client's Cloud project must have every applicable MCP API and
preview enrollment. Do not remove legacy enabled profiles while their grants are
in use. This code change does not enable the broker profile or deploy any stack.

The signed request and envelope authentication bind the exact 21-scope requested
profile; the encrypted credential payload preserves Google's actual nonempty
subset. Missing scope evidence and scopes outside that reviewed union fail closed
on authorization and refresh. Individual legacy profiles retain exact matching.
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

Removal is local for managed grants: Google's project-wide revocation can break
other connections. Before rollout, verify full and partial consent with an enrolled
test account, allowed reads/writes, reconnect, refresh and removal. Deterministic
tests are not real-provider proof. Combining profiles simplifies onboarding, not
Google's per-scope demonstration, justification or security-assessment obligations.

Sources: [granular consent](https://developers.google.com/identity/protocols/oauth2/resources/granular-permissions),
[Workspace MCP setup](https://developers.google.com/workspace/guides/configure-mcp-servers).

## Temporary Connections page visibility hold

While Google OAuth verification is pending, the Connections landing page
(`ui/src/pages/apps/Browse.tsx`) hides Google Workspace and the nine legacy entries,
including their saved accounts. This is a display-only filter. App definitions,
direct setup and management routes, OAuth profiles, saved credentials, and
runtime tools remain unchanged. This is not an access-control restriction.

Keep verification instances pinned to their pre-hold app release so reviewers
can still find and test the integrations. After approval, remove the page's
`GOOGLE_CONNECTOR_SLUGS` filter and update its visibility tests before upgrading
those instances. Do not disable the shared definitions or broker profiles to
control this page's visibility.

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
Workspace setup has one capability and defers permission selection to Google.
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
token envelopes, and refresh. Per-profile removal is local-only for managed
Google grants. Google's revocation endpoint can invalidate all grants for the
same user and managed client, so Paperclip does not call it while removing one
Workspace profile.

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
Drive permissions. Calendar write requests `calendar.calendarlist.readonly`
and `calendar.events`; the latter also authorizes `suggest_time`. Calendar read
retains `calendar.events.freebusy` alongside list/event read-only access.

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
