# TCP Sockets API Reference

Complete API reference for the Cloudflare Workers TCP Sockets API (`cloudflare:sockets`).

## Core Function: `connect()`

```typescript
function connect(
  address: SocketAddress,
  options?: SocketOptions
): Socket
```

Creates an outbound TCP connection to the specified address.

### Parameters

#### `SocketAddress`

```typescript
interface SocketAddress {
  hostname: string; // DNS hostname or IP address
  port: number;     // TCP port (1-65535, excluding blocked ports)
}
```

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `hostname` | `string` | Target hostname or IP | `"db.internal.net"`, `"10.0.1.50"` |
| `port` | `number` | TCP port number | `5432`, `443`, `22` |

DNS names are resolved at connection time. IPv4, IPv6, and private IPs (10.x, 172.16.x, 192.168.x) supported.

#### `SocketOptions`

```typescript
interface SocketOptions {
  secureTransport?: "off" | "on" | "starttls";
  allowHalfOpen?: boolean;
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `secureTransport` | `"off" \| "on" \| "starttls"` | `"off"` | TLS mode |
| `allowHalfOpen` | `boolean` | `false` | Allow half-closed connections |

**`secureTransport` modes:**

| Mode | Behavior | Use Case |
|------|----------|----------|
| `"off"` | Plain TCP, no encryption | Testing, internal trusted networks |
| `"on"` | Immediate TLS handshake | HTTPS, secure databases, SSH |
| `"starttls"` | Start plain, upgrade later with `startTls()` | Postgres, SMTP, IMAP |

**`allowHalfOpen`:** When `false` (default), closing read stream auto-closes write stream. When `true`, streams are independent.

### Returns

A `Socket` object with readable/writable streams.

## Socket Interface

```typescript
interface Socket {
  // Streams
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  
  // Connection state
  opened: Promise<SocketInfo>;
  closed: Promise<void>;
  
  // Methods
  close(): Promise<void>;
  startTls(): Socket;
}
```

### Properties

#### `readable: ReadableStream<Uint8Array>`

Stream for reading data from the socket. Use `getReader()` to consume data.

```typescript
const reader = socket.readable.getReader();
const { done, value } = await reader.read(); // Read one chunk
```

#### `writable: WritableStream<Uint8Array>`

Stream for writing data to the socket. Use `getWriter()` to send data.

```typescript
const writer = socket.writable.getWriter();
await writer.write(new TextEncoder().encode("HELLO\r\n"));
await writer.close();
```

#### `opened: Promise<SocketInfo>`

Promise that resolves when connection succeeds, rejects on failure.

```typescript
interface SocketInfo {
  remoteAddress?: string; // May be undefined
  localAddress?: string;  // May be undefined
}

try {
  const info = await socket.opened;
} catch (error) {
  // Connection failed
}
```

#### `closed: Promise<void>`

Promise that resolves when socket is fully closed (both directions).

### Methods

#### `close(): Promise<void>`

Closes the socket gracefully, waiting for pending writes to complete.

```typescript
const socket = connect({ hostname: "api.internal", port: 443 });
try {
  // Use socket
} finally {
  await socket.close(); // Always call in finally block
}
```

#### `startTls(): Socket`

Upgrades connection to TLS. Only available when `secureTransport: "starttls"` was specified.

```typescript
const socket = connect(
  { hostname: "db.internal", port: 5432 },
  { secureTransport: "starttls" }
);

// Send protocol-specific StartTLS command
const writer = socket.writable.getWriter();
await writer.write(new TextEncoder().encode("STARTTLS\r\n"));

// Upgrade to TLS - use returned socket, not original
const secureSocket = socket.startTls();
const secureWriter = secureSocket.writable.getWriter();
```

## Complete Example

```typescript
import { connect } from 'cloudflare:sockets';

export default {
  async fetch(req: Request): Promise<Response> {
    const socket = connect({ hostname: "echo.example.com", port: 7 }, { secureTransport: "on" });

    try {
      await socket.opened;
      
      const writer = socket.writable.getWriter();
      await writer.write(new TextEncoder().encode("Hello, TCP!\n"));
      await writer.close();

      const reader = socket.readable.getReader();
      const { value } = await reader.read();
      
      return new Response(value);
    } finally {
      await socket.close();
    }
  }
};
```

See [patterns.md](./patterns.md) for multi-chunk reading, error handling, and protocol implementations.

## Quick Reference

| Task | Code |
|------|------|
| Import | `import { connect } from 'cloudflare:sockets';` |
| Connect | `connect({ hostname: "host", port: 443 })` |
| With TLS | `connect(addr, { secureTransport: "on" })` |
| StartTLS | `socket.startTls()` after handshake |
| Write | `await writer.write(data); await writer.close();` |
| Read | `const { value } = await reader.read();` |
| Error handling | `try { await socket.opened; } catch { }` |
| Always close | `try { } finally { await socket.close(); }` |

## See Also

- [patterns.md](./patterns.md) - Real-world protocol implementations
- [configuration.md](./configuration.md) - Wrangler setup and environment variables
- [gotchas.md](./gotchas.md) - Limits and error handling
