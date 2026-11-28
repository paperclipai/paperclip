# Machine sign-in (MCP OAuth client credentials)

Machine sign-in connects an **organization-owned** remote MCP server where no
person signs in: service accounts, CI-style integrations, internal automation.
Paperclip signs in as a client the provider registered for it, using the
[MCP OAuth Client Credentials extension](https://modelcontextprotocol.io/extensions/auth/oauth-client-credentials)
(`io.modelcontextprotocol/oauth-client-credentials`, revision 2026-07-28),
which builds on [RFC 6749 §4.4](https://datatracker.ietf.org/doc/html/rfc6749#section-4.4)
and [RFC 7523](https://datatracker.ietf.org/doc/html/rfc7523).

It works the same on Paperclip Cloud and self-hosted instances.

## Setting it up

**Apps → Connect an app → Connect your own MCP server**, paste the address,
press **Change** beside the sign-in line and choose **Machine sign-in**. The option
appears only when the connection is shared with the organization; personal
connections sign in as the person.

1. **Sign-in service.** Leave it blank and Paperclip asks the server where it
   signs in (its protected-resource metadata, then that service's metadata).
   Otherwise enter the sign-in service's address, or its token URL when the
   provider publishes no metadata.
2. **How Paperclip proves who it is.**
   - **Paperclip key (recommended).** Press **Create key**. Paperclip creates a
     signing key, keeps the private half in the company vault, and shows the
     public key as PEM and as JSON. Register it with the provider for the
     Paperclip client. The public key isn't secret.
   - **Client secret.** For providers that only issue secrets. The secret goes
     straight into the vault and is never shown again.
3. **Client ID and scopes.** Enter the client ID the provider shows for the
   Paperclip client, and any scopes its docs list (space separated).
4. **Test connection.** Paperclip asks the sign-in service for a token, then
   lists the server's tools with it. Success turns the connection on and goes to
   the normal review step. A failed test keeps the draft and its key, so you
   can fix the provider side and test again.

Errors say what to change: an unaccepted key or secret, refused scopes, a
provider that doesn't accept keys (choose Client secret) or secrets (choose
Paperclip key), or a sign-in service Paperclip couldn't find.

## How tokens are requested

- `grant_type=client_credentials`, with `scope` and the RFC 8707 `resource`
  (the MCP server address) on every request.
- **Paperclip key:** `private_key_jwt`. Each request carries a fresh assertion
  signed with RS256 (or ES256 when the service accepts only that):
  `iss` = `sub` = client ID, `aud` = the token endpoint, `exp` 60 seconds after
  `iat`, a unique `jti`, and `kid` = the key's RFC 7638 thumbprint. Per the
  extension, no `client_id` or secret is sent alongside it.
- **Client secret:** `client_secret_basic`, or `client_secret_post` when that
  is all the service advertises.
- Requests that carry a 2026-07-28 client capability object declare
  `io.modelcontextprotocol/oauth-client-credentials` for these connections only.

Tokens live in the vault on the connection's organization grant, like any
other OAuth token, and are reused until a minute before they expire. There is
no refresh token: Paperclip asks for a new access token. The existing grant
refresh lease and in-process single flight mean concurrent agents, across
server processes, share one token request. A `401` from the server requests a
new token once; a second `401` reports the problem without touching the
pinned settings. Agent boot and time to first token do not change: a live
token is read the same way as for browser sign-in connections.

## The sign-in service is pinned

The connection records the sign-in service's issuer and token endpoint at
setup. Credentials and assertions go only to that token endpoint, never to a
deployment-wide OAuth client and never to a different service the server later
advertises:

- Test and rotation check the server's protected-resource metadata; if it now
  lists other sign-in services and not the pinned one, Paperclip refuses and
  asks you to set up machine sign-in again.
- A rejected token at runtime never re-runs discovery or rewrites the
  connection's endpoints.

When you enter a token URL directly there is no issuer to compare; the token
URL itself is the pin.

## Rotation without downtime

- **New client secret:** enter it; Paperclip tests it against the sign-in
  service first and only then replaces the stored secret (a new version of the
  same vault entry). A wrong secret changes nothing.
- **New key:** start a key rotation; Paperclip creates a replacement key and
  shows its public key while the current key keeps working. Register the new
  public key with the provider, then complete the rotation: Paperclip tests the
  new key and only then switches to it and deletes the old one.

API: `POST /api/tool-connections/{id}/machine-sign-in/rotate` with
`{ "method": "client_secret", "clientSecret": "…" }` or
`{ "method": "paperclip_key" }`, then
`POST /api/tool-connections/{id}/machine-sign-in/rotate/complete` for a key.

## Security

- Private keys and client secrets exist only in the company vault
  (`oauth.client_private_key`, `oauth.client_private_key_next`,
  `oauth.client_secret`). Config, API responses, activity and logs carry only
  the public key, key ID, issuer, method and scope count.
- Company scoped. Only connection managers can set it up, and only for
  organization connections; the service refuses personal connections.
- Activity: `tool_connection.machine_sign_in_created`, `…_verified`,
  `…_rotation_started`, `…_rotated`, and removal as `tool_connection.archived`
  with `machineSignIn: true`. Removal destroys the vault entries the connection
  owned.

## API

| Route | Use |
| --- | --- |
| `POST /api/companies/{companyId}/tools/machine-sign-in` | Create the draft (finds and pins the sign-in service, creates the key or stores the secret). |
| `GET /api/tool-connections/{id}/machine-sign-in` | Settings and public keys. |
| `POST /api/tool-connections/{id}/machine-sign-in/test` | Test with an optional client ID, scopes or secret; turns the connection on. |
| `POST /api/tool-connections/{id}/machine-sign-in/rotate` | Rotate the secret, or stage a new key. |
| `POST /api/tool-connections/{id}/machine-sign-in/rotate/complete` | Switch to the staged key. |

Code: `server/src/services/tool-access/oauth/client-credentials.ts` (keys and
assertions), `client-credentials-service.ts` (setup, pinning, token requests),
the machine sign-in branch in `grant-refresh.ts`, and
`ui/src/features/connections/MachineSignInSetup.tsx`. Tests:
`server/src/__tests__/tool-access-client-credentials.test.ts`.

## Not yet covered

- A settings-page control for rotation (rotation is API-only today).
- Enterprise single sign-on and enterprise-managed authorization (ID-JAG) are
  later phases.
