# Configuration

Setup and configuration for TCP Sockets in Cloudflare Workers.

## Wrangler Configuration

### Basic Setup

TCP Sockets are available by default in Workers runtime. No special configuration required in `wrangler.jsonc`:

```jsonc
{
  "name": "private-network-worker",
  "main": "src/index.ts",
  "compatibility_date": "2025-01-01"
}
```

### Environment Variables

Store connection details as env vars:

```jsonc
{
  "vars": { "DB_HOST": "10.0.1.50", "DB_PORT": "5432" }
}
```

```typescript
interface Env { DB_HOST: string; DB_PORT: string; }

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const socket = connect({ hostname: env.DB_HOST, port: parseInt(env.DB_PORT) });
  }
};
```

### Per-Environment Configuration

```jsonc
{
  "vars": { "DB_HOST": "localhost" },
  "env": {
    "staging": { "vars": { "DB_HOST": "staging-db.internal.net" } },
    "production": { "vars": { "DB_HOST": "prod-db.internal.net" } }
  }
}
```

Deploy: `wrangler deploy --env staging` or `wrangler deploy --env production`

## Integration with Cloudflare Tunnel

To connect Workers to private networks, combine TCP Sockets with Cloudflare Tunnel:

```
Worker (TCP Socket) → Tunnel hostname → cloudflared → Private Network
```

### Quick Setup

1. **Install cloudflared** on a server inside your private network
2. **Create tunnel**: `cloudflared tunnel create my-private-network`
3. **Configure routing** in `config.yml`:

```yaml
tunnel: <TUNNEL_ID>
credentials-file: /path/to/<TUNNEL_ID>.json
ingress:
  - hostname: db.internal.example.com
    service: tcp://10.0.1.50:5432
  - service: http_status:404  # Required catch-all
```

4. **Run tunnel**: `cloudflared tunnel run my-private-network`
5. **Connect from Worker**:

```typescript
const socket = connect(
  { hostname: "db.internal.example.com", port: 5432 },  // Tunnel hostname
  { secureTransport: "on" }
);
```

For detailed Tunnel setup, see [Tunnel configuration reference](../tunnel/configuration.md).

## Smart Placement Integration

Reduce latency by auto-placing Workers near backends:

```jsonc
{ "placement": { "mode": "smart" } }
```

Workers automatically relocate closer to TCP socket destinations after observing connection latency. See [Smart Placement reference](../smart-placement/).

## Secrets Management

Store sensitive credentials as secrets (not in wrangler.jsonc):

```bash
wrangler secret put DB_PASSWORD  # Enter value when prompted
```

Access in Worker via `env.DB_PASSWORD`. Use in protocol handshake or authentication.

## Local Development

Test with `wrangler dev`. Note: Local mode may not access private networks. Use public endpoints or mock servers for development:

```typescript
const config = process.env.NODE_ENV === 'dev' 
  ? { hostname: 'localhost', port: 5432 }  // Mock
  : { hostname: 'db.internal.example.com', port: 5432 };  // Production
```

## Connection String Patterns

Parse connection strings to extract host and port:

```typescript
function parseConnectionString(connStr: string): SocketAddress {
  const url = new URL(connStr); // e.g., "postgres://10.0.1.50:5432/mydb"
  return { hostname: url.hostname, port: parseInt(url.port) || 5432 };
}
```

## Hyperdrive Integration

For PostgreSQL/MySQL, prefer Hyperdrive over raw TCP sockets (includes connection pooling):

```jsonc
{ "hyperdrive": [{ "binding": "DB", "id": "<HYPERDRIVE_ID>" }] }
```

See [Hyperdrive reference](../hyperdrive/) for complete setup.

## Compatibility

TCP Sockets available in all modern Workers. Use current date: `"compatibility_date": "2025-01-01"`. No special flags required.

## Related Configuration

- **[Tunnel Configuration](../tunnel/configuration.md)** - Detailed cloudflared setup
- **[Smart Placement](../smart-placement/configuration.md)** - Placement mode options
- **[Hyperdrive](../hyperdrive/configuration.md)** - Database connection pooling setup
