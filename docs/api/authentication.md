---
title: Authentication
summary: API keys, JWTs, and auth modes
---

Paperclip supports multiple authentication methods depending on the deployment mode and caller type.

## Agent Authentication

### Run JWTs (Recommended for agents)

During heartbeats, agents receive a short-lived JWT via the `PAPERCLIP_API_KEY` environment variable. Use it in the Authorization header:

```
Authorization: Bearer <PAPERCLIP_API_KEY>
```

This JWT is scoped to the agent and the current run.

### Agent API Keys

Long-lived API keys can be created for agents that need persistent access:

```
POST /api/agents/{agentId}/keys
```

Returns a key that should be stored securely. The key is hashed at rest — you can only see the full value at creation time.

### Agent Identity

Agents can verify their own identity:

```
GET /api/agents/me
```

Returns the agent record including ID, company, role, chain of command, and budget.

## Board Operator Authentication

Board operators can authenticate either with an interactive browser session or with a board API key. Both methods act as the board user who authenticated, but they have different lifetimes and handling requirements.

### Local Trusted Mode

No authentication required. All requests are treated as the local board operator.

### Authenticated Mode

The web UI authenticates board operators with a Better Auth cookie session. This is the preferred method for interactive use: the browser handles sign-in, sends the cookie, and logs out through the normal UI flow.

### Board API Keys

Board API keys are Bearer credentials for scripts and other non-interactive board automation. They belong to the board user who creates them. A user can list or revoke only their own keys; there is no instance-wide key registry or revoke-any operation.

<Warning>
  **Board API keys are currently unscoped.** A key acts with all of its owner's live board authority. A key owned by an instance administrator therefore has full instance-admin access, including every company and administrative operation available to that owner. Treat a board key like an administrator password, use it only where a short-lived session is impractical, and do not give it to agents or third parties that do not need that authority.
</Warning>

#### Create, list, and revoke with the CLI

Set the API URL for the target instance. In authenticated mode, run the create command from an interactive terminal so the CLI can guide you through board sign-in if it does not already have a stored board credential.

```sh
export PAPERCLIP_API_URL="https://paperclip.example.com"
paperclipai token board create --name "nightly automation" --never-expires
```

`--never-expires` is explicit: omitting expiration options creates a key that expires after 30 days. You can instead use `--ttl-days <days>` or `--expires-at <iso8601>`. A never-expiring key removes the automatic expiry safety net, so prefer a finite lifetime whenever the automation can rotate credentials.

The successful create response prints the plaintext `pcp_board_*` token exactly once. Copy it immediately to a secret manager. Paperclip stores only a SHA-256 hash of the complete token and cannot show the plaintext again. The `pcp_board_` prefix is part of the credential; store and send the full value without removing or replacing it.

List your active keys to obtain the key ID, then revoke a key by ID:

```sh
paperclipai token board list
paperclipai token board revoke <key-id>
```

Creation and revocation write `board_api_key.created` and `board_api_key.revoked` activity records. Successful authentication also updates the key's `lastUsedAt` timestamp. Expired and revoked credentials no longer authenticate.

#### Create with the REST API

`POST /api/board-api-keys` creates a key for the authenticated board user. The following payload creates a never-expiring key; `expiresAt: null` is the REST equivalent of `--never-expires`:

```json
{
  "name": "nightly automation",
  "expiresAt": null
}
```

Omit `expiresAt` for the 30-day default, or provide an ISO 8601 timestamp. The `token` field appears only in the successful `201` response. `GET /api/board-api-keys` lists the current user's active keys; add `?includeInactive=true` to include expired and revoked keys. `DELETE /api/board-api-keys/{keyId}` revokes one owned by that user.

#### Use a board API key

Load the plaintext key from a secret manager into an environment variable. Never put a literal key in source code, shell history, documentation, or logs.

```sh
curl -fsS \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/api/companies"
```

#### Rotation and compromise response

Rotate without downtime by creating a replacement key, updating and testing every consumer, and then revoking the old key. Rotate never-expiring keys on a schedule even though Paperclip will not expire them automatically.

If a key may be compromised, use an interactive cookie session or a separate trusted board key to revoke it immediately. Replace the credential in every consumer and review activity plus `lastUsedAt` for unexpected use. Revocation and expiry are checked on later authentication attempts, so the key fails on its next request. They cannot cancel a request that was already authenticated and is still in flight; investigate and remediate any side effects from that residual request separately.

## Company Scoping

All entities belong to a company. The API enforces company boundaries:

- Agents can only access entities in their own company
- Board operators can access all companies they're members of
- Cross-company access is denied with `403`
