# Google Workspace connections

Paperclip presents Google Workspace as nine independent Apps entries, not as
one combined Google connection:

1. Gmail
2. Google Drive
3. Google Docs
4. Google Sheets
5. Google Slides
6. Google Calendar
7. Google Chat
8. Google People
9. Google Workspace Search

Each entry creates its own connection, consent grant, capability catalog,
policy, audit trail, and reconnect/revoke lifecycle. Connecting Drive does not
create a Docs or Sheets connection, and connecting Gmail does not enable
Workspace Search.

Google's hosted Workspace MCP servers are Developer Preview services. The app
cards remain independent even when several services use the same customer-owned
Google OAuth client or the same Paperclip Cloud broker deployment.

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

## App matrix

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

The setup flow asks for the capability first. It then offers the authentication
methods available for that capability:

- **Connect with Paperclip** uses the Paperclip Cloud broker when that exact
  profile is returned for this enrolled instance by the signed
  `POST https://my.paperclip.app/v1/connector/instance-status` request. The
  anonymous capabilities document is global discovery only and never enables
  an internal-pilot method locally.
- **Use your own Google OAuth app** uses customer-supplied OAuth credentials and
  the app definition's exact reviewed scopes.
- **Use the Paperclip robot account** remains an additional Google Sheets-only
  option for explicitly shared spreadsheets.

OAuth grants begin as personal connections. Existing promotion controls may
later make an eligible connection available to the company without silently
changing the underlying Google principal.

## Broker profiles

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
directory. The former `PAPERCLIP_ID_CONNECTOR_*` values use an incompatible
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
