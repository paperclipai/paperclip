# Common Patterns

Real-world patterns and examples for TCP Sockets in Cloudflare Workers.

```typescript
import { connect } from 'cloudflare:sockets';
```

## Basic Patterns

### Simple Request-Response

```typescript
const socket = connect({ hostname: "echo.example.com", port: 7 }, { secureTransport: "on" });
try {
  await socket.opened;
  const writer = socket.writable.getWriter();
  await writer.write(new TextEncoder().encode("Hello\n"));
  await writer.close();
  
  const reader = socket.readable.getReader();
  const { value } = await reader.read();
  return new Response(value);
} finally {
  await socket.close();
}
```

### Reading All Data

```typescript
async function readAll(socket: Socket): Promise<Uint8Array> {
  const reader = socket.readable.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}
```

### Streaming Response

```typescript
// Stream socket data directly to HTTP response
const socket = connect({ hostname: "stream.internal", port: 9000 }, { secureTransport: "on" });
const writer = socket.writable.getWriter();
await writer.write(new TextEncoder().encode("STREAM\n"));
await writer.close();
return new Response(socket.readable);
```

## Protocol Examples

### Redis RESP

```typescript
// Send: *2\r\n$3\r\nGET\r\n$<keylen>\r\n<key>\r\n
// Recv: $<len>\r\n<data>\r\n or $-1\r\n for null
const socket = connect({ hostname: "redis.internal", port: 6379 });
const writer = socket.writable.getWriter();
await writer.write(new TextEncoder().encode(`*2\r\n$3\r\nGET\r\n$3\r\nkey\r\n`));
```

### PostgreSQL

**Use [Hyperdrive](../hyperdrive/) for production.** Raw Postgres protocol is complex (startup, auth, query messages).

### MQTT

```typescript
const socket = connect({ hostname: "mqtt.broker", port: 1883 });
const writer = socket.writable.getWriter();
// CONNECT: 0x10 <len> 0x00 0x04 "MQTT" 0x04 <flags> ...
// PUBLISH: 0x30 <len> <topic_len> <topic> <message>
```

## Error Handling Patterns

### Retry with Backoff

```typescript
async function connectWithRetry(addr: SocketAddress, opts: SocketOptions, maxRetries = 3): Promise<Socket> {
  for (let i = 1; i <= maxRetries; i++) {
    try {
      const socket = connect(addr, opts);
      await socket.opened;
      return socket;
    } catch (error) {
      if (i === maxRetries) throw error;
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i - 1))); // Exponential backoff
    }
  }
  throw new Error('Unreachable');
}
```

### Timeout

```typescript
async function connectWithTimeout(addr: SocketAddress, opts: SocketOptions, ms = 5000): Promise<Socket> {
  const socket = connect(addr, opts);
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timeout')), ms));
  await Promise.race([socket.opened, timeout]);
  return socket;
}
```

### Fallback

```typescript
async function connectWithFallback(primary: string, fallback: string, port: number): Promise<Socket> {
  try {
    const socket = connect({ hostname: primary, port }, { secureTransport: "on" });
    await socket.opened;
    return socket;
  } catch {
    return connect({ hostname: fallback, port }, { secureTransport: "on" });
  }
}
```

## Security Patterns

### Destination Allowlist (Prevent SSRF)

```typescript
const ALLOWED_HOSTS = ['db.internal.company.net', 'api.internal.company.net', /^10\.0\.1\.\d+$/];

function isAllowed(hostname: string): boolean {
  return ALLOWED_HOSTS.some(p => p instanceof RegExp ? p.test(hostname) : p === hostname);
}

export default {
  async fetch(req: Request): Promise<Response> {
    const target = new URL(req.url).searchParams.get('host');
    if (!target || !isAllowed(target)) return new Response('Forbidden', { status: 403 });
    const socket = connect({ hostname: target, port: 443 });
    // Use socket...
  }
};
```

### Connection Pooling

```typescript
class SocketPool {
  private pool = new Map<string, Socket[]>();
  
  async acquire(hostname: string, port: number): Promise<Socket> {
    const key = `${hostname}:${port}`;
    const sockets = this.pool.get(key) || [];
    if (sockets.length > 0) return sockets.pop()!;
    const socket = connect({ hostname, port }, { secureTransport: "on" });
    await socket.opened;
    return socket;
  }
  
  release(hostname: string, port: number, socket: Socket): void {
    const key = `${hostname}:${port}`;
    const sockets = this.pool.get(key) || [];
    if (sockets.length < 3) { sockets.push(socket); this.pool.set(key, sockets); }
    else socket.close();
  }
}
```

## Multi-Protocol Gateway

```typescript
interface Protocol { name: string; defaultPort: number; test(host: string, port: number): Promise<string>; }

const PROTOCOLS: Record<string, Protocol> = {
  redis: {
    name: 'redis',
    defaultPort: 6379,
    async test(host, port) {
      const socket = connect({ hostname: host, port });
      try {
        const writer = socket.writable.getWriter();
        await writer.write(new TextEncoder().encode('*1\r\n$4\r\nPING\r\n'));
        writer.releaseLock();
        const reader = socket.readable.getReader();
        const { value } = await reader.read();
        return new TextDecoder().decode(value || new Uint8Array());
      } finally { await socket.close(); }
    }
  }
};

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const proto = url.pathname.slice(1);  // /redis
    const host = url.searchParams.get('host');
    if (!host || !PROTOCOLS[proto]) return new Response('Invalid', { status: 400 });
    const result = await PROTOCOLS[proto].test(host, parseInt(url.searchParams.get('port') || '') || PROTOCOLS[proto].defaultPort);
    return new Response(result);
  }
};
```


