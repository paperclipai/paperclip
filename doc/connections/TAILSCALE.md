# Tailscale

This connection holds a Tailscale OAuth client for one tailnet. Paperclip uses
it server-side to list tailnet devices and to mint short-lived, single-use,
tagged auth keys. Later features build on it: tailnet machines as `ssh`
environments and sandboxes that join the tailnet for one run. In this version
the connection only verifies the OAuth client. Agents get no tool and no
tailnet access from it; machine and sandbox access are separate, later
features.

Neither Paperclip ID nor Paperclip Connect participates. Cloud and self-hosted
instances use the same server-side path. The instance needs outbound HTTPS to
`api.tailscale.com`.

## Connect and configure

Choose **Tailscale** (`tailscale`) in Apps and paste the client ID and client
secret of an OAuth client. Both values go into the Paperclip vault as company
secrets. The grant is organization-wide. The OAuth client, the API tokens
minted from it, and any auth key never reach an agent runtime, the board UI,
a log line, or the credential export path.

Fields:

| Field | Default | Meaning |
| --- | --- | --- |
| OAuth client ID, OAuth client secret | required | Created once in the Tailscale admin console. The secret is shown only at creation. |
| Tailnet | `-` | `-` means the tailnet that owns the OAuth client. Enter the tailnet name, such as `example.com` or `tail1234.ts.net`, only when the client belongs to a different tailnet. |
| Agent tag (Advanced) | `tag:paperclip-agent` | The tag that machines and sandboxes carry when they join the tailnet for agents. The OAuth client must be allowed to assign it. |

## Administrator setup

1. Add the tags and grants below to the tailnet policy file in
   [Access controls](https://login.tailscale.com/admin/acls/file). Adjust the
   `tag:dev-box` and `tag:internal-api` examples to the machines and services
   that the later environment features will expose to agents.

   ```json
   {
     "tagOwners": {
       "tag:paperclip-control": ["autogroup:admin"],
       "tag:paperclip-agent": ["autogroup:admin", "tag:paperclip-control"],
       "tag:dev-box": ["autogroup:admin"]
     },
     "grants": [
       { "src": ["tag:paperclip-control"], "dst": ["tag:dev-box"], "ip": ["tcp:22"] },
       { "src": ["tag:paperclip-agent"], "dst": ["tag:internal-api"], "ip": ["tcp:443"] }
     ],
     "ssh": [
       { "action": "accept", "src": ["tag:paperclip-control"], "dst": ["tag:dev-box"], "users": ["agent"] }
     ]
   }
   ```

2. Create one OAuth client in
   [Trust credentials](https://login.tailscale.com/admin/settings/oauth) with
   the scope `auth_keys` (tags `tag:paperclip-agent` and
   `tag:paperclip-control`) and the scope `devices:core`. Copy the client ID and
   the secret.
3. Paste both into Apps > Tailscale > Connect and finish setup. The connection
   check below runs during setup and again on every health check.
4. Enable network flow logs in the Tailscale admin console if the tailnet policy
   requires an audit trail of agent traffic.

Scopes and tags are fixed when the OAuth client is created. Paperclip cannot
widen an existing client. When the check reports a missing scope or a tag the
client cannot assign, create a new client and reconnect.

## Connection check

```mermaid
sequenceDiagram
  participant Board as Board UI
  participant Server as Paperclip server
  participant Vault
  participant TS as api.tailscale.com
  Board->>Server: Connect (client ID, client secret, tailnet, agent tag)
  Server->>Vault: store credentials.oauthClientId and credentials.oauthClientSecret
  Server->>TS: POST /api/v2/oauth/token (client_credentials)
  TS-->>Server: access token and granted scopes
  Server->>TS: GET /api/v2/tailnet/{tailnet}/devices?fields=all
  TS-->>Server: device list
  Server->>TS: POST /api/v2/tailnet/{tailnet}/keys (ephemeral, single use, preauthorized, agent tag, 300 s)
  TS-->>Server: key id
  Server->>TS: DELETE /api/v2/tailnet/{tailnet}/keys/{id}
  Server-->>Board: health ok with tailnet, scopes, tags, device count
```

The check proves three things in order: the client is valid, it can read
devices (`devices:core`), and it can mint keys with the agent tag (`auth_keys`
plus tag ownership). The test key is reusable `false`, ephemeral `true`,
preauthorized `true`, expiry 300 seconds, and it is deleted immediately. It is
deleted even when a later validation step fails, and also when the create
response carries a usable key id but otherwise fails validation. A failed
deletion is reported as the primary error with its own code, because the
undeleted key is the operator's next concern; the validation failure it
superseded is kept in `details.secondary` and appended to the message. The key
still expires on its own within five minutes. A response stream that fails
mid-body is normalized to `tailscale_request_failed` like any other unusable
response.

The redacted result is stored on the connection as `config.tailscale`
(`tailnet`, `scopes`, `tags`, `deviceCount`, `checkedAt`, `probeFingerprint`)
and shown as the health message, for example:

```text
Tailscale OAuth client is connected to the client's tailnet. Scopes: auth_keys, devices:core. Tags: tag:paperclip-agent. Devices visible: 12.
```

The summary is written as a JSON merge of the `tailscale` key only, fenced on
the connection's `methodConfig` and credential secret refs being the ones the
probe used. A settings save or credential change that lands during the probe
wins: the stale evidence is dropped and the check reports
`tailscale_connection_changed` so the operator runs it again on the new values.

Setup runs the health check and catalog discovery back to back. Discovery
reuses the stored summary instead of minting a second test key only when the
summary is less than a minute old, the connection's latest health check
succeeded (`healthStatus` is `ok` and `healthCheckedAt` is not older than the
summary), and `probeFingerprint` still matches the current tailnet, agent tag,
and secret versions. A failed check, a new setting, or a rotated credential
forces a fresh probe.

Failures map to fixed codes. The message names the scope, tag, or tailnet to
fix. Provider response bodies are discarded unread, because they can name
tailnets, tags, and key identifiers.

| Code | HTTP | Cause and fix |
| --- | --- | --- |
| `tailscale_client_invalid` | 422 | The token endpoint rejected the client ID or secret. Create a new OAuth client and reconnect. |
| `tailscale_scope_devices_missing` | 422 | The token lacks `devices:core`, or the device list returned 403. Create a client with that scope. |
| `tailscale_scope_auth_keys_missing` | 422 | The token lacks `auth_keys`, or key creation was refused for a client without it. |
| `tailscale_tag_not_owned` | 422 | Key creation was refused or the issued key does not carry the agent tag. Add the tag to the client's `auth_keys` scope and to `tagOwners`. |
| `tailscale_tailnet_not_found` | 422 | The tailnet name is wrong for this client. Use `-` or the exact name. |
| `tailscale_rate_limited` | 502 | Tailscale returned 429. Retry in a minute. |
| `tailscale_unreachable` | 502 | The instance could not reach `api.tailscale.com`. |
| `tailscale_test_key_cleanup_failed` | 502 | The test key was minted but not deleted. It expires within five minutes. Any validation failure it superseded is in `details.secondary`. |
| `tailscale_request_failed` | 502 | Another provider status, an unexpected response shape, or a response stream that failed mid-body. |
| `tailscale_connection_changed` | 409 | The tailnet, agent tag, or credentials changed while the check ran. The saved values are kept; run the check again. |

## Boundaries

- The catalog entry is `transport: rest_api` and `auth: api_key`, matched by
  `config.sourceTemplateKey === "tailscale"`. It never enters the MCP gateway
  and discovery returns no tools.
- `keyPlacement` is a body placement, not a header. The client is sent only in
  the body of the token request, so setup writes vault secret refs and no header
  projection.
- The credential export path and the agent token mint refuse this connection.
- Provider error bodies are never read. Response bodies are bounded to 16 MiB.
- Deleting devices is implemented in the API client for later lifecycle work and
  is not used by the connection check.

## Validation and live proof

Deterministic tests:

- `server/src/__tests__/tailscale-api.test.ts`: the REST boundary against a
  fake Tailscale API. Token exchange shape, device listing, key mint and delete,
  every failure code, cached tokens, deletion of the test key after a later
  failure or a malformed create response, cleanup failure reported first with
  the superseded error as secondary, failed response streams, and redaction of
  the client secret, token, key secret, and provider body.
- `server/src/__tests__/tailscale-connection.test.ts`: the connection lifecycle
  through the real vault and setup path on embedded Postgres. Setup runs the
  check, stores the redacted summary, keeps secrets out of config and health
  fields, maps a provider refusal to an actionable 422, re-probes on refresh
  after a failed check or a changed setting, keeps a settings save that lands
  during a probe, and refuses credential export.
- `packages/shared/src/app-definitions.test.ts`: catalog shape, fields,
  defaults, placement, and URL match.

Live proof is not run yet. The connection was built from the official
[OAuth client documentation](https://tailscale.com/kb/1215/oauth-clients) and
the official Go client (`tailscale-client-go-v2`). To record it:

1. Create the OAuth client described above in a test tailnet.
2. Paste it into Apps > Tailscale > Connect and finish setup.
3. Copy the health message and the `tool_connection.health_check` audit row
   into this section, with the tailnet name and device count redacted.
4. Confirm in the Tailscale admin console under Settings > Keys that no
   `Paperclip connection check` key remains.

Record the result as a dated **Verification record** section here and set
`liveProof` for `tailscale/oauth-client` in
`doc/connections/tool-method-permission-reviews.json`.

## Provider research

Reviewed on 2026-10-09:

- [OAuth clients](https://tailscale.com/kb/1215/oauth-clients): client
  credentials grant at `POST https://api.tailscale.com/api/v2/oauth/token`,
  scopes fixed at creation, tags attached to `auth_keys`.
- [Tailscale API](https://tailscale.com/api): device list with `fields=all`,
  key creation body (`capabilities.devices.create` with `reusable`,
  `ephemeral`, `preauthorized`, `tags`, plus `expirySeconds` and
  `description`), key deletion, device deletion. The key secret is returned
  only by the create response.
- [Go client](https://github.com/tailscale/tailscale-client-go-v2): confirms
  the request and response shapes above and that `-` names the tailnet that
  owns the client.
- Official artwork: the mark from `https://tailscale.com/favicon.svg`,
  re-authored as a sanitized local SVG with a dark variant; provenance is in
  the app brand manifest.
