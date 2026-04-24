# Board API Keys

Board API keys let you call the Paperclip REST API from external services without a browser session. Each key is tied to a user account and inherits that user's permissions and company access.

## Enabling the Feature

**Board API keys are disabled by default as a safety measure.** To turn them on:

1. Navigate to **Instance Settings > General**.
2. Toggle **Board API keys** on.

When disabled:
- New keys cannot be created (POST `/api/board-api-keys` returns 403).
- Existing keys stop authenticating immediately — bearer tokens using them will fail auth.
- The API Keys settings page shows a banner explaining the feature is off.
- Existing keys remain visible in the API Keys page so you can revoke them for cleanup.

Turn the toggle off to instantly kill all board API key access instance-wide without touching individual keys.

## How It Works

When you create a board API key through the Settings UI, Paperclip generates a `pcp_board_...` token. The plaintext token is shown once at creation time — after that, only a SHA-256 hash is stored. Every API request with the token in an `Authorization: Bearer` header is resolved to the creating user's identity, company memberships, and instance-admin status.

Board API keys reuse the same authentication path as CLI-issued board keys. The middleware in `server/src/middleware/auth.ts` hashes the incoming bearer token and looks it up in the `board_api_keys` table. If the hash matches an active (non-revoked, non-expired) row, the request proceeds as the associated user.

### Security Model

- **Off by default.** Feature must be explicitly enabled in Instance Settings > General. Flipping it off instantly invalidates every existing key.
- **Token shown once.** Only the SHA-256 hash is persisted. If you lose the token, revoke and recreate.
- **Privilege laundering blocked.** A request authenticated via a board API key cannot create or list other board API keys. Only session-authenticated users (browser login or `local_implicit` mode) can manage keys. This prevents a leaked key from minting new keys.
- **User lifecycle.** Keys are tied to `authUsers.id` with `ON DELETE CASCADE`. If the user is removed, all their keys are deleted.
- **Activity logging.** Every key creation and revocation is recorded in the activity log for all of the user's companies.

## Creating a Key

### From the Board UI

1. Navigate to **Instance Settings > API Keys** (sidebar icon: key).
2. Click **Create key**.
3. Enter a name (e.g., "CI pipeline", "monitoring service").
4. Choose an expiration: Never, 30 days, 90 days, or 1 year.
5. Click **Create**.
6. Copy the token from the dialog. **You will not see it again.**

### Using the Key

Pass the token as a Bearer header:

```bash
curl -H "Authorization: Bearer pcp_board_<your_token>" \
  http://localhost:3100/api/companies
```

The key has the same access as the user who created it — all their companies, all board-level endpoints. If the user is an instance admin, the key has instance-admin access.

### Revoking a Key

1. Go to **Instance Settings > API Keys**.
2. Click the trash icon next to the key.
3. Confirm revocation.

The key stops working immediately. Revoked keys are soft-deleted (`revoked_at` is set) and remain in the database for audit purposes.

## REST API

All endpoints require session authentication (cookie or `local_implicit` mode). Board API key bearers are explicitly rejected to prevent privilege escalation.

### List Keys

```
GET /api/board-api-keys
```

Returns an array of the caller's active keys:

```json
[
  {
    "id": "uuid",
    "name": "CI pipeline",
    "lastUsedAt": "2026-04-16T10:00:00.000Z",
    "expiresAt": null,
    "revokedAt": null,
    "createdAt": "2026-04-15T09:00:00.000Z"
  }
]
```

Pass `?includeRevoked=true` to include revoked keys.

### Create Key

```
POST /api/board-api-keys
Content-Type: application/json

{
  "name": "CI pipeline",
  "expiresInDays": 90
}
```

`expiresInDays` is optional. Omit or pass `null` for a key that never expires.

Returns the key with the plaintext token (shown only in this response):

```json
{
  "id": "uuid",
  "name": "CI pipeline",
  "token": "pcp_board_abc123...",
  "expiresAt": "2026-07-15T09:00:00.000Z",
  "createdAt": "2026-04-16T09:00:00.000Z"
}
```

### Revoke Key

```
DELETE /api/board-api-keys/:id
```

Returns `{ "revoked": true, "keyId": "uuid" }`. The key must belong to the calling user (unless the caller is an instance admin).

## Schema

The feature reuses the existing `board_api_keys` table — no migration was needed.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | Primary key |
| `user_id` | text | FK to `auth_users`, cascade delete |
| `name` | text | User-chosen label |
| `key_hash` | text | SHA-256 of the plaintext token |
| `last_used_at` | timestamptz | Updated on each authenticated request |
| `revoked_at` | timestamptz | Null = active |
| `expires_at` | timestamptz | Null = never expires |
| `created_at` | timestamptz | |

## Key Files

| File | Role |
|---|---|
| `server/src/middleware/auth.ts` | Bearer token validation (unchanged — already supports board keys) |
| `server/src/services/board-auth.ts` | Token generation, hashing, list, revoke |
| `server/src/routes/access.ts` | CRUD endpoints (`/api/board-api-keys`) |
| `server/src/routes/authz.ts` | `assertSessionBoard` guard |
| `packages/shared/src/validators/access.ts` | `createBoardApiKeySchema` |
| `packages/shared/src/types/access.ts` | `BoardApiKeySummary`, `BoardApiKeyCreated` |
| `ui/src/pages/InstanceApiKeys.tsx` | Settings UI page |
| `ui/src/api/boardApiKeys.ts` | UI API client |

## Future

This implementation is scoped to the current single/multi-user model where keys are tied to a human user. If a first-class service-account principal is needed later (key independent of any user), the `company_memberships` table already supports arbitrary `principalType` values, and the actor middleware can be extended with a new branch without changing the key management surface.
