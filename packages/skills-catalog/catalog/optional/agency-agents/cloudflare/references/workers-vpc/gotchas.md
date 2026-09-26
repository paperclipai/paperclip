# Gotchas and Troubleshooting

Common pitfalls, limitations, and solutions for TCP Sockets in Cloudflare Workers.

## Platform Limits

### Connection Limits

| Limit | Value |
|-------|-------|
| Max concurrent sockets per request | 6 (hard limit) |
| Socket lifetime | Request duration |
| Connection timeout | Platform-dependent, no setting |

**Problem:** Exceeding 6 connections throws error

**Solution:** Process in batches of 6

```typescript
for (let i = 0; i < hosts.length; i += 6) {
  const batch = hosts.slice(i, i + 6).map(h => connect({ hostname: h, port: 443 }));
  await Promise.all(batch.map(async s => { /* use */ await s.close(); }));
}
```

### Blocked Destinations

Cloudflare IPs (1.1.1.1), localhost (127.0.0.1), port 25 (SMTP), Worker's own URL blocked for security.

**Solution:** Use public IPs or Tunnel hostnames: `connect({ hostname: "db.internal.company.net", port: 5432 })`

### Scope Requirements

**Problem:** Sockets created in global scope fail

**Cause:** Sockets tied to request lifecycle

**Solution:** Create inside handler: `export default { async fetch() { const socket = connect(...); } }`

## Common Errors

### Error: "proxy request failed"

**Causes:** Blocked destination (Cloudflare IP, localhost, port 25), DNS failure, network unreachable

**Solution:** Validate destinations, use Tunnel hostnames, catch errors with try/catch

### Error: "TCP Loop detected"

**Cause:** Worker connecting to itself

**Solution:** Connect to external service, not Worker's own hostname

### Error: "Port 25 prohibited"

**Cause:** SMTP port blocked

**Solution:** Use Email Workers API for email

### Error: "socket is not open"

**Cause:** Read/write after close

**Solution:** Always use try/finally to ensure proper closure order

### Error: Connection timeout

**Cause:** No built-in timeout

**Solution:** Use `Promise.race()`:

```typescript
const socket = connect(addr, opts);
const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000));
await Promise.race([socket.opened, timeout]);
```

## TLS/SSL Issues

### StartTLS Timing

**Problem:** Calling `startTls()` too early

**Solution:** Send protocol-specific STARTTLS command, wait for server OK, then call `socket.startTls()`

### Certificate Validation

**Problem:** Self-signed certs fail

**Solution:** Use proper certs or Tunnel (handles TLS termination)

## Performance Issues

### Not Using Connection Pooling

**Problem:** New connection overhead per request

**Solution:** Use [Hyperdrive](../hyperdrive/) for databases (built-in pooling)

### Not Using Smart Placement

**Problem:** High latency to backend

**Solution:** Enable: `{ "placement": { "mode": "smart" } }` in wrangler.jsonc

### Forgetting to Close Sockets

**Problem:** Resource leaks

**Solution:** Always use try/finally:

```typescript
const socket = connect({ hostname: "api.internal", port: 443 });
try {
  // Use socket
} finally {
  await socket.close();
}
```

## Data Handling Issues

### Assuming Single Read Gets All Data

**Problem:** Only reading once may miss chunked data

**Solution:** Loop `reader.read()` until `done === true` (see patterns.md)

### Text Encoding Issues

**Problem:** Using wrong encoding

**Solution:** Specify encoding: `new TextDecoder('iso-8859-1').decode(data)`

## Security Issues

### SSRF Vulnerability

**Problem:** User-controlled destinations allow access to internal services

**Solution:** Validate against strict allowlist:

```typescript
const ALLOWED = ['api1.internal.net', 'api2.internal.net'];
const host = new URL(req.url).searchParams.get('host');
if (!host || !ALLOWED.includes(host)) return new Response('Forbidden', { status: 403 });
```

## When to Use Alternatives

| Use Case | Alternative | Reason |
|----------|-------------|--------|
| PostgreSQL/MySQL | [Hyperdrive](../hyperdrive/) | Connection pooling, caching |
| HTTP/HTTPS | `fetch()` | Simpler, built-in |
| HTTP with SSRF protection | VPC Services (beta 2025+) | Declarative bindings |

## Debugging Tips

1. **Log connection details:** `const info = await socket.opened; console.log(info.remoteAddress);`
2. **Test with public services first:** Use tcpbin.com:4242 echo server
3. **Verify Tunnel:** `cloudflared tunnel info <name>` and `cloudflared tunnel route ip list`

## Related

- [Hyperdrive](../hyperdrive/) - Database connections
- [Smart Placement](../smart-placement/) - Latency optimization
- [Tunnel Troubleshooting](../tunnel/gotchas.md)
