# TURN Configuration

Setup and configuration for Cloudflare TURN service in Workers and applications.

## Environment Variables

```bash
# .env
CLOUDFLARE_ACCOUNT_ID=your_account_id
CLOUDFLARE_API_TOKEN=your_api_token
TURN_KEY_ID=your_turn_key_id
TURN_KEY_SECRET=your_turn_key_secret
```

Validate with zod:

```typescript
import { z } from 'zod';

const envSchema = z.object({
  CLOUDFLARE_ACCOUNT_ID: z.string().min(1),
  CLOUDFLARE_API_TOKEN: z.string().min(1),
  TURN_KEY_ID: z.string().min(1),
  TURN_KEY_SECRET: z.string().min(1)
});

export const config = envSchema.parse(process.env);
```

## wrangler.jsonc

```jsonc
{
  "name": "turn-credentials-api",
  "main": "src/index.ts",
  "compatibility_date": "2025-01-01",
  "vars": {
    "TURN_KEY_ID": "your-turn-key-id"  // Non-sensitive, can be in vars
  },
  "env": {
    "production": {
      "kv_namespaces": [
        {
          "binding": "CREDENTIALS_CACHE",
          "id": "your-kv-namespace-id"
        }
      ]
    }
  }
}
```

**Store secrets separately**:
```bash
wrangler secret put TURN_KEY_SECRET
```

## Cloudflare Worker Integration

### Worker Binding Types

```typescript
interface Env {
  TURN_KEY_ID: string;
  TURN_KEY_SECRET: string;
  CREDENTIALS_CACHE?: KVNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // See patterns.md for implementation
  }
}
```

### Basic Worker Example

```typescript
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.url.endsWith('/turn-credentials')) {
      // Validate client auth
      const authHeader = request.headers.get('Authorization');
      if (!authHeader) {
        return new Response('Unauthorized', { status: 401 });
      }

      const response = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.TURN_KEY_SECRET}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ ttl: 3600 })
        }
      );

      if (!response.ok) {
        return new Response('Failed to generate credentials', { status: 500 });
      }

      const data = await response.json();

      // Filter port 53 for browser clients
      const filteredUrls = data.iceServers.urls.filter(
        (url: string) => !url.includes(':53')
      );

      return Response.json({
        iceServers: [
          { urls: 'stun:stun.cloudflare.com:3478' },
          {
            urls: filteredUrls,
            username: data.iceServers.username,
            credential: data.iceServers.credential
          }
        ]
      });
    }

    return new Response('Not found', { status: 404 });
  }
};
```

## IP Allowlisting (Enterprise/Firewall)

For strict firewalls, allowlist these IPs for `turn.cloudflare.com`:

| Type | Address | Protocol |
|------|---------|----------|
| IPv4 | 141.101.90.1/32 | All |
| IPv4 | 162.159.207.1/32 | All |
| IPv6 | 2a06:98c1:3200::1/128 | All |
| IPv6 | 2606:4700:48::1/128 | All |

**IMPORTANT**: These IPs may change with 14-day notice. Monitor DNS:

```bash
# Check A and AAAA records
dig turn.cloudflare.com A
dig turn.cloudflare.com AAAA
```

Set up automated monitoring to detect IP changes and update allowlists within 14 days.

## IPv6 Support

- **Client-to-TURN**: Both IPv4 and IPv6 supported
- **Relay addresses**: IPv4 only (no RFC 6156 support)
- **TCP relaying**: Not supported (RFC 6062)

Clients can connect via IPv6, but relayed traffic uses IPv4 addresses.

## TLS Configuration

### Supported TLS Versions
- TLS 1.1
- TLS 1.2
- TLS 1.3

### Recommended Ciphers (TLS 1.3)
- AEAD-AES128-GCM-SHA256
- AEAD-AES256-GCM-SHA384
- AEAD-CHACHA20-POLY1305-SHA256

### Recommended Ciphers (TLS 1.2)
- ECDHE-ECDSA-AES128-GCM-SHA256
- ECDHE-RSA-AES128-GCM-SHA256
- ECDHE-RSA-AES128-SHA (also TLS 1.1)
- AES128-GCM-SHA256

## See Also

- [api.md](./api.md) - TURN key creation, credential generation API
- [patterns.md](./patterns.md) - Full Worker implementation patterns
- [gotchas.md](./gotchas.md) - Security best practices, troubleshooting
