# TURN API Reference

Complete API documentation for Cloudflare TURN service credentials and key management.

## Authentication

All endpoints require Cloudflare API token with "Calls Write" permission.

Base URL: `https://api.cloudflare.com/client/v4`

## TURN Key Management

### List TURN Keys

```
GET /accounts/{account_id}/calls/turn_keys
```

### Get TURN Key Details

```
GET /accounts/{account_id}/calls/turn_keys/{key_id}
```

### Create TURN Key

```
POST /accounts/{account_id}/calls/turn_keys
Content-Type: application/json

{
  "name": "my-turn-key"
}
```

**Response includes**:
- `uid`: Key identifier
- `key`: The actual secret key (only returned on creation—save immediately)
- `name`: Human-readable name
- `created`: ISO 8601 timestamp
- `modified`: ISO 8601 timestamp

### Update TURN Key

```
PUT /accounts/{account_id}/calls/turn_keys/{key_id}
Content-Type: application/json

{
  "name": "updated-name"
}
```

### Delete TURN Key

```
DELETE /accounts/{account_id}/calls/turn_keys/{key_id}
```

## Generate Temporary Credentials

```
POST https://rtc.live.cloudflare.com/v1/turn/keys/{key_id}/credentials/generate
Authorization: Bearer {key_secret}
Content-Type: application/json

{
  "ttl": 86400
}
```

### Credential Constraints

| Parameter | Min | Max | Default | Notes |
|-----------|-----|-----|---------|-------|
| ttl | 1 | 172800 (48hrs) | varies | API rejects values >172800 |

**CRITICAL**: Maximum TTL is 48 hours (172800 seconds). API will reject requests exceeding this limit.

### Response Schema

```json
{
  "iceServers": {
    "urls": [
      "stun:stun.cloudflare.com:3478",
      "turn:turn.cloudflare.com:3478?transport=udp",
      "turn:turn.cloudflare.com:3478?transport=tcp",
      "turn:turn.cloudflare.com:53?transport=udp",
      "turn:turn.cloudflare.com:80?transport=tcp",
      "turns:turn.cloudflare.com:5349?transport=tcp",
      "turns:turn.cloudflare.com:443?transport=tcp"
    ],
    "username": "1738035200:user123",
    "credential": "base64encodedhmac=="
  }
}
```

**Port 53 Warning**: Filter port 53 URLs for browser clients—blocked by Chrome/Firefox. See [gotchas.md](./gotchas.md#using-port-53-in-browsers).

## Revoke Credentials

```
POST https://rtc.live.cloudflare.com/v1/turn/keys/{key_id}/credentials/revoke
Authorization: Bearer {key_secret}
Content-Type: application/json

{
  "username": "1738035200:user123"
}
```

**Response**: 204 No Content

Billing stops immediately. Active connection drops after short delay (~seconds).

## TypeScript Types

```typescript
interface CloudflareTURNConfig {
  keyId: string;
  keySecret: string;
  ttl?: number; // Max 172800 (48 hours)
}

interface TURNCredentialsRequest {
  ttl?: number; // Max 172800 seconds
}

interface TURNCredentialsResponse {
  iceServers: {
    urls: string[];
    username: string;
    credential: string;
  };
}

interface RTCIceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
  credentialType?: "password";
}

interface TURNKeyResponse {
  uid: string;
  key: string; // Only present on creation
  name: string;
  created: string;
  modified: string;
}
```

## Validation Function

```typescript
function validateRTCIceServer(obj: unknown): obj is RTCIceServer {
  if (!obj || typeof obj !== 'object') {
    return false;
  }

  const server = obj as Record<string, unknown>;

  if (typeof server.urls !== 'string' && !Array.isArray(server.urls)) {
    return false;
  }

  if (server.username && typeof server.username !== 'string') {
    return false;
  }

  if (server.credential && typeof server.credential !== 'string') {
    return false;
  }

  return true;
}
```

## Type-Safe Credential Generation

```typescript
async function fetchTURNServers(
  config: CloudflareTURNConfig
): Promise<RTCIceServer[]> {
  // Validate TTL constraint
  const ttl = config.ttl ?? 3600;
  if (ttl > 172800) {
    throw new Error('TTL cannot exceed 172800 seconds (48 hours)');
  }

  const response = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${config.keyId}/credentials/generate`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.keySecret}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ ttl })
    }
  );

  if (!response.ok) {
    throw new Error(`TURN credential generation failed: ${response.status}`);
  }

  const data = await response.json();
  
  // Filter port 53 for browser clients
  const filteredUrls = data.iceServers.urls.filter(
    (url: string) => !url.includes(':53')
  );

  const iceServers = [
    { urls: 'stun:stun.cloudflare.com:3478' },
    {
      urls: filteredUrls,
      username: data.iceServers.username,
      credential: data.iceServers.credential,
      credentialType: 'password' as const
    }
  ];

  // Validate before returning
  if (!iceServers.every(validateRTCIceServer)) {
    throw new Error('Invalid ICE server configuration received');
  }

  return iceServers;
}
```

## See Also

- [configuration.md](./configuration.md) - Worker setup, environment variables
- [patterns.md](./patterns.md) - Implementation examples using these APIs
- [gotchas.md](./gotchas.md) - Security best practices, common mistakes
