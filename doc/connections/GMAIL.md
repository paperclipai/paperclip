# Gmail connection

Paperclip connects to Google's hosted Gmail MCP server at
`https://gmailmcp.googleapis.com/mcp/v1`. Gmail authorization is separate from
Google sign-in:

- Google sign-in identifies a Paperclip ID user and requests only
  `openid email profile`.
- Gmail authorization lets that user's agents search and read mail and create
  drafts. It requests only `gmail.readonly` and `gmail.compose`.

Do not add Gmail scopes to the Google sign-in client. Paperclip ID hosts the
public Gmail OAuth callback, while the originating Paperclip instance remains
the durable owner of the encrypted access and refresh tokens.

> Google Workspace MCP is a Developer Preview. Enroll the required Workspace
> organization and test accounts in Google's Developer Preview Program before
> relying on the service.

## Deployment layout

Use a separate Google Cloud project and OAuth web client for each environment:

| Environment | Suggested project id | OAuth client name | Authorized redirect URI |
| --- | --- | --- | --- |
| Development | `paperclip-gmail-dev` | `Paperclip Gmail Connection Dev` | `http://localhost:3000/api/connect/oauth/google/callback` |
| Staging | `paperclip-gmail-staging` | `Paperclip Gmail Connection Staging` | `https://id-staging.paperclip.app/api/connect/oauth/google/callback` |
| Production | `paperclip-gmail-prod` | `Paperclip Gmail Connection Production` | `https://id.paperclip.app/api/connect/oauth/google/callback` |

Replace the development port if the local Paperclip ID service uses another
port. Do not register Tailscale, customer, or other self-hosted Paperclip
instance URLs with Google. The browser always returns to Paperclip ID first;
Paperclip ID then sends an opaque, one-time claim identifier to the exact
originating instance URL that was enrolled before the flow began.

Keeping projects separate is a Paperclip release policy. It prevents a
development credential or consent-screen change from affecting production and
keeps restricted-scope Gmail verification independent of Google sign-in.

## Google Cloud setup

Repeat this procedure in development, staging, and production. Complete and
test development first, then staging. Do not enable production authorization
until Google verification and Paperclip Security review are complete.

### 1. Create the project

1. Open [Google Cloud project creation](https://console.cloud.google.com/projectcreate).
2. Select the Paperclip Cloud organization and billing account.
3. Create the environment-specific project from the table above.
4. Limit Owner and Editor access to the smallest operator group.
5. Add a monitored engineering or security contact.
6. Record the project id in the private environment runbook. Do not put a
   client secret in the runbook or repository.

### 2. Enable Gmail and Gmail MCP

In **APIs & Services → Library**, enable:

- Gmail API: `gmail.googleapis.com`
- Gmail MCP API: `gmailmcp.googleapis.com`

The equivalent command is:

```sh
gcloud services enable \
  gmail.googleapis.com \
  gmailmcp.googleapis.com \
  --project=PROJECT_ID
```

Do not enable Drive, Docs, Sheets, Calendar, Chat, or People for the Gmail-only
release.

### 3. Configure branding

Open **Google Auth Platform → Branding**. Set:

- App name: `Paperclip`
- User support email: a monitored support address
- Logo: the approved Paperclip logo
- Homepage: the public Paperclip product page
- Privacy policy: the public policy that describes Gmail data handling
- Terms of service: the public Paperclip terms
- Authorized domain: `paperclip.app`
- Developer contact: a monitored security or engineering group

The homepage, privacy policy, and terms must be live on the verified domain
before production verification. The privacy policy must explain that the
originating Paperclip instance stores Gmail credentials and that Paperclip ID
performs bounded OAuth exchange, refresh, and revocation without durable
plaintext token storage.

### 4. Configure the audience

Open **Google Auth Platform → Audience**.

- Development: select **External**, keep the app in **Testing**, and add only
  developer test accounts.
- Staging: select **External**, keep the app in **Testing**, and add only QA,
  security-review, and verification accounts.
- Production: select **External** and move to **In production** only after the
  required restricted-scope verification and security work is complete.

Google limits an external testing app to 100 test users. For non-basic scopes,
testing grants and their offline refresh tokens can expire after seven days.
Treat that expiry as expected test behavior.

### 5. Add the exact scopes

Open **Google Auth Platform → Data Access → Add or remove scopes → Manually add
scopes** and add only:

```text
https://www.googleapis.com/auth/gmail.readonly
https://www.googleapis.com/auth/gmail.compose
```

Do not add `mail.google.com`, `gmail.modify`, `gmail.send`, Drive, Calendar, or
profile/sign-in scopes. Gmail read and compose are restricted scopes. Public
production use therefore requires Google's restricted-scope verification and
may require an independent security assessment for server-side handling.

### 6. Create the OAuth client

Open **Google Auth Platform → Clients → Create Client**:

1. Select **Web application**.
2. Enter the environment-specific client name from the table above.
3. Add exactly the matching authorized redirect URI.
4. Leave **Authorized JavaScript origins** empty. This is a server-side flow.
5. Create the client.
6. Copy the client id and newly displayed secret directly into the matching
   deployment secret manager.

Never paste either credential into an issue, document, chat, screenshot,
committed `.env`, build log, or browser-visible configuration. Step 7 lists the
deployment variables that receive them.

### 7. Configure the Paperclip ID broker deployment

Set these on the Paperclip ID service that owns the redirect URI above. This is
the broker half of the configuration; the originating Paperclip instance is
configured separately under [Configure each originating Paperclip
instance](#configure-each-originating-paperclip-instance).

| Variable | Development | Staging | Production |
| --- | --- | --- | --- |
| `GOOGLE_GMAIL_CLIENT_ID` | Dev client id | Staging client id | Production client id |
| `GOOGLE_GMAIL_CLIENT_SECRET` | Dev client secret | Staging client secret | Production client secret |
| `GOOGLE_GMAIL_REDIRECT_URI` | `http://localhost:3000/api/connect/oauth/google/callback` | `https://id-staging.paperclip.app/api/connect/oauth/google/callback` | `https://id.paperclip.app/api/connect/oauth/google/callback` |
| `GOOGLE_GMAIL_CONNECTOR_ENABLED` | `true` once dev testing starts | `true` after dev sign-off | `true` only after Google verification and Security review |
| `CONNECTOR_ENVIRONMENT` | `development` | `staging` | `production` |

The three credential variables must be set together. Setting some but not all
of them fails validation at boot, and enabling the connector without all three
fails as well.

`GOOGLE_GMAIL_REDIRECT_URI` is also checked at boot: its path must equal
`/api/connect/oauth/google/callback` exactly, or the service refuses to start.
A redirect URI that points at a path this service does not serve is accepted by
Google and then fails on Google's own error page at the moment a user consents,
where no Paperclip log can see it.

`GOOGLE_GMAIL_CONNECTOR_ENABLED` is the kill switch, and it is off unless it is
set to `true`, `1`, `yes`, or `on` (case-insensitive). While it is off, every
`/api/connect` route answers `503 CONNECTOR_DISABLED` without touching the
database or Google.

Set `CONNECTOR_ENVIRONMENT` explicitly in every environment. Every signed
connector request declares its own environment, and the broker accepts the
request only when that value matches both this deployment's environment and the
environment recorded on the enrolled instance. That three-way match is what
makes a leaked staging instance key inert against production, so it must equal
the instance's `PAPERCLIP_ID_CONNECTOR_ENVIRONMENT`.

Do not rely on the fallback. When `CONNECTOR_ENVIRONMENT` is unset, the broker
derives the value from the `BASE_URL` host (`id` to production, `id-staging` to
staging, anything else to development). A staging or production deployment on
any other hostname therefore brokers as `development`, and every signed request
from a correctly configured instance fails the environment check. The value is
never derived from `NODE_ENV`, which is `production` on staging too.

## Connector request requirements

The Gmail authorization request must use:

- the Gmail connector client, not the Google sign-in client;
- `/api/connect/oauth/google/callback` on Paperclip ID;
- `response_type=code`;
- the two exact Gmail scopes above;
- `access_type=offline`;
- `prompt=consent` for every connect and explicit reconnect;
- a random, short-lived, single-use state value; and
- PKCE S256.

Do not send `include_granted_scopes`. After token exchange, compare the granted
scope set with the two required scopes. If either is missing, leave that
personal connection grant inactive and let the user retry deliberately.

No access token, refresh token, Google authorization code, client secret, or
token fragment may appear in a browser URL. The browser return from Paperclip
ID to the originating instance contains only an opaque one-time claim id.

## Token custody and instance enrollment

The expected flow is:

```mermaid
sequenceDiagram
    actor U as User browser
    participant P as Originating Paperclip instance
    participant I as Paperclip ID connector
    participant G as Google OAuth
    participant V as Instance encrypted vault

    U->>P: Apps → Gmail → Connect
    P->>I: Signed, environment-bound authorization session
    I-->>U: Google authorization URL with state and PKCE
    U->>G: Grant Gmail read and draft access
    G-->>I: Authorization code
    I->>G: Exchange with the Gmail client secret
    I-->>U: Opaque one-time claim for the enrolled instance
    U->>P: Return to exact enrolled instance URL
    P->>I: Signed one-time claim
    I-->>P: Instance-encrypted token response
    P->>V: Encrypt tokens and bind them to the user's grant
```

Before an instance can create a session:

1. The instance generates an Ed25519 signing key and a separate X25519 seal
   key. Both private keys stay local; Ed25519 authenticates requests and
   X25519 lets Paperclip ID encrypt token responses that only the instance can
   open.
2. An operator signs in to Paperclip ID and enrolls the instance.
3. Paperclip ID binds the account, opaque instance id, both public keys,
   deployment environment, and exact allowed browser return origins.
4. Tailscale HTTPS origins are allowed only when explicitly enrolled. Loopback
   HTTP is development-only. Other plaintext origins are rejected.
5. Create, claim, refresh, and revoke requests are signed, audience-bound,
   timestamped, and protected by a one-time `jti` replay cache.

Paperclip ID may retain instance-encrypted initial-token ciphertext for at most
five minutes. It deletes the ciphertext on claim or expiry and excludes it from
long-term backups. Refresh and revoke handle plaintext only in memory for one
bounded request.

### Configure each originating Paperclip instance

Generate the two long-lived instance keys once. PEM-encoded PKCS#8 keys work
directly with Paperclip:

```sh
openssl genpkey -algorithm ED25519 -out paperclip-id-signing.pem
openssl genpkey -algorithm X25519 -out paperclip-id-sealing.pem
openssl pkey -in paperclip-id-signing.pem -pubout -out paperclip-id-signing.pub.pem
openssl pkey -in paperclip-id-sealing.pem -pubout -out paperclip-id-sealing.pub.pem
```

Keep both private files in the instance secret manager. Enroll only the public
files with Paperclip ID, together with the instance id, the matching environment,
and every exact browser return origin. Then configure the originating Paperclip
deployment:

| Variable | Development | Staging | Production |
| --- | --- | --- | --- |
| `PAPERCLIP_ID_CONNECTOR_BASE_URL` | Local Paperclip ID URL | `https://id-staging.paperclip.app` | `https://id.paperclip.app` |
| `PAPERCLIP_ID_CONNECTOR_ENVIRONMENT` | `development` | `staging` | `production` |
| `PAPERCLIP_ID_CONNECTOR_INSTANCE_ID` | Enrolled development instance id | Enrolled staging instance id | Enrolled production instance id |
| `PAPERCLIP_ID_CONNECTOR_SIGN_PRIVATE_KEY` | Development Ed25519 private key | Staging Ed25519 private key | Production Ed25519 private key |
| `PAPERCLIP_ID_CONNECTOR_SEAL_PRIVATE_KEY` | Development X25519 private key | Staging X25519 private key | Production X25519 private key |

Use separate keypairs and instance enrollments across environments. The
connector is unavailable unless all four identity/key variables are present.
HTTP is accepted only for a loopback Paperclip ID URL; staging and production
must use HTTPS.

## Paperclip access defaults

The first Gmail release is personal-only:

- **Just me** is the only credential ownership choice.
- The disclosure states that Gmail access can search/read mail and create
  drafts. Sending mail is not enabled.
- A user grant does not automatically authorize an agent. The user must also
  install the connection for that agent, select an access profile, and grant
  standing delegation before autonomous use.
- Read, search, get, and list tools may be enabled after explicit profile
  review.
- Draft creation and label changes require **Ask first**.
- Trash, spam, destructive label changes, newly discovered tools, nested
  execution, and any future send tool remain blocked until separately reviewed.

## Verification checklist

### Development

1. Enable the connector only in development.
2. Confirm the broker's `CONNECTOR_ENVIRONMENT` and the instance's
   `PAPERCLIP_ID_CONNECTOR_ENVIRONMENT` both read `development`. A mismatch
   fails every signed request with an environment error before Google is ever
   contacted, which looks nothing like a Google misconfiguration.
3. Use an isolated Gmail test mailbox.
4. Connect from localhost and one explicitly enrolled Tailscale HTTPS origin.
5. From the board Test panel, run `list_labels` and a bounded
   `search_threads` query.
6. Install the reviewed profile on one test agent and repeat one read-only call
   in a fresh agent run.
7. Create a draft through an Ask-first approval and verify no send action is
   exposed.
8. Force access-token expiry and verify refresh changes only the originating
   instance's encrypted secret version.
9. Revoke the grant and verify the next call fails closed.
10. Confirm sanitized logs, activity, API payloads, agent context, and browser
    history contain no credential or authorization code.

### Staging

Repeat development verification, then add negative tests for replayed state,
wrong origin, wrong instance, wrong company, wrong user, wrong environment,
expired claim, missing scope, inactive membership, connector outage, and the
seven-day testing-token expiry.

### Production

1. Complete Developer Preview enrollment, restricted-scope verification, any
   required security assessment, and Paperclip Security review.
2. Configure only the production project credentials in production secrets.
3. Start with an internal allowlist and read tools.
4. Enable Ask-first draft and label tools only after production telemetry is
   clean.
5. Keep destructive and send-email capabilities blocked.
6. Keep the environment-specific connector kill switch available. When it is
   off, new authorization and refresh fail with an actionable error and never
   fall back to Google sign-in or another user's grant.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `redirect_uri_mismatch` | The client contains the exact environment callback, including scheme, host, port, path, and no extra slash. |
| Test user cannot consent | The account is listed under the environment project's Audience test users and is enrolled in Workspace Developer Preview. |
| Refresh fails after seven days | The external app is still in Testing. Reauthorize the test user; do not treat this as token-rotation failure. |
| One required capability is missing | Inspect the returned granted scope set. Keep the grant inactive if either exact required scope is absent. |
| Local or Tailscale return is rejected | Enroll the exact origin on Paperclip ID. Only loopback HTTP is allowed; Tailscale must use HTTPS. |
| Every signed request fails on environment | The broker's `CONNECTOR_ENVIRONMENT`, the enrolled instance record, and the instance's `PAPERCLIP_ID_CONNECTOR_ENVIRONMENT` must all agree. An unset broker value is derived from the `BASE_URL` host and silently becomes `development`. |
| Every `/api/connect` route returns 503 | `GOOGLE_GMAIL_CONNECTOR_ENABLED` is not one of `true`, `1`, `yes`, or `on`. The response is `CONNECTOR_DISABLED`; no database or Google call is attempted. |
| Login starts asking for Gmail | Stop the rollout. The login and Gmail clients or route namespaces have been mixed. |
| Connector is unavailable | Keep the grant in `needs_reauthorization` or an actionable unavailable state. Never use a login token or another environment's client. |

## References

- [Configure Google Workspace MCP servers](https://developers.google.com/workspace/guides/configure-mcp-servers)
- [OAuth 2.0 for web server applications](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Google OAuth 2.0 policies](https://developers.google.com/identity/protocols/oauth2/policies)
- [Choose Gmail API scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [Google Workspace API user data and developer policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy)
