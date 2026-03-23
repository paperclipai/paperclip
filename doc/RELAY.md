# Relay

Status: Experimental
Date: 2026-03-13

## 1. Purpose

The relay gives any Paperclip instance a public HTTPS URL with zero configuration. It enables remote access from any device without VPN, port forwarding, or extra software.

```
Any browser/device                     Paperclip server (behind NAT)
       │                                          │
       │──HTTPS──▶ ┌──────────────┐  ◀──WSS──────│
       │           │ Relay Server │   outbound     │
       │◀──HTTPS── │ (CF Worker)  │   tunnel       │
       │           └──────────────┘               │
       │            Public internet          127.0.0.1:3100
```

Each instance gets its own subdomain (e.g. `d4lsc.relay.example.com`). The relay is a generic transport layer — it forwards HTTP requests and WebSocket frames without inspecting payloads. All authentication is handled by Paperclip's existing auth layer.

The tunnel uses a binary multiplexing protocol for WebSocket data — text frames carry JSON control messages, binary frames carry raw WebSocket payloads with a 37-byte stream header. The bridge never inspects message content.

## 2. What Gets Tunneled

- Static web UI assets (HTML/JS/CSS) — full Paperclip dashboard in any browser
- REST API calls — all existing endpoints work unchanged
- WebSocket connections — real-time events and live updates

## 3. Configuration

One environment variable enables the relay:

```sh
PAPERCLIP_RELAY_URL=wss://relay.example.com
```

When set, the server auto-registers on first startup (obtaining a token and instance ID), then connects to the relay and prints the public subdomain URL:

```
$ npx paperclipai run

  Server listening on 127.0.0.1:3100
  Relay           https://d4lsc.relay.example.com
```

The server stays bound to `127.0.0.1`. The relay client runs inside the same process and forwards to localhost.

## 4. Setup

### 4.1 Deploy the relay server

> **Test relay available**: `paperclip-relay.com` is a community-run relay for testing purposes. It is not affiliated with or operated by Paperclip AI. For production use, deploy your own relay server.

The relay is a Cloudflare Worker with a Durable Object. See section 9 for the full source.

```sh
npm create cloudflare@latest paperclip-relay -- --type worker
cd paperclip-relay
# copy source files from section 8
# set RELAY_DOMAIN in wrangler.toml [vars] to your domain
# add wildcard DNS (*.your-domain.com) pointing to the Worker
npx wrangler deploy
```

### 4.2 Configure Paperclip

Add the relay URL to `.env` or set as an environment variable:

```sh
PAPERCLIP_RELAY_URL=wss://relay.example.com
```

That's it. On first startup, the server automatically:

1. Registers with the relay (`POST /register`)
2. Saves the token to `.env` (`PAPERCLIP_RELAY_TOKEN=rl_...`)
3. Adds the subdomain hostname (e.g. `d4lsc.relay.example.com`) to `allowedHostnames` in `config.json`

On subsequent startups, the saved token is reused — the server reconnects to the same relay instance with the same subdomain.

### 4.3 Open from anywhere

Navigate to `https://<id>.relay.example.com` in any browser. Each Paperclip instance gets its own subdomain, so multiple Macs can use the same relay server without conflict.

## 5. Why Subdomains

SPAs use absolute paths for assets (e.g. `/assets/main.js`). Browsers resolve these against the domain root, not the current path. Path-prefix routing (`relay.example.com/abc12/`) would cause the browser to request `relay.example.com/assets/main.js` — wrong instance, or 404.

Subdomains avoid this entirely: `abc12.relay.example.com/assets/main.js` stays within the same instance. This is the same approach used by Vercel, Netlify, and ngrok.

## 6. Security

**The relay requires `authenticated` deployment mode.** The server refuses to start the relay in `local_trusted` mode and logs an error. This is enforced because `local_trusted` has no login — enabling the relay would expose the instance to the public internet without any authentication.

| Layer | Protection |
|---|---|
| Deployment mode | Must be `authenticated` — enforced at startup |
| Client to relay | HTTPS/TLS (Cloudflare certificate) |
| Relay to Paperclip | WSS/TLS |
| Tunnel auth | Token — only the registered instance can connect |
| API auth | Better Auth session cookies pass through unchanged |

The relay sees traffic in plaintext at the proxy layer. This is the same trust model as any reverse proxy (Cloudflare, nginx, Caddy). Paperclip's own auth layer protects the API.

## 7. Tunnel Protocol

The tunnel WebSocket between the Paperclip server and the relay carries two frame types:

| Tunnel frame type | Content | Used for |
|---|---|---|
| **Text** | JSON | Control messages (`tunnel-ready`, `ws-open`, `ws-close`, `http-request`, `http-response`) |
| **Binary** | 37-byte header + raw payload | WebSocket data (heartbeats, events, any client/server messages) |

Binary data frame format:

```
Byte 0:       Flags (bit 0 = isBinary: 0 = original was text, 1 = original was binary)
Bytes 1–36:   Stream ID (UUID as 36 ASCII chars)
Bytes 37+:    Raw payload (untouched original WebSocket message bytes)
```

This design means the bridge never inspects, parses, or serializes WebSocket message content. Both text and binary WebSocket frames from clients are supported transparently. The `flags` byte preserves the original frame type end-to-end.

## 8. Limitations

- **Latency**: adds 20-100ms per request (Cloudflare edge round-trip)
- **Tunnel single point**: if the server disconnects (sleep, restart), the relay returns 502 until reconnect
- **No end-to-end encryption**: the relay sees plaintext (same as any reverse proxy)

## 9. Relay Server Source

The relay server is a Cloudflare Worker with a Durable Object. The Durable Object holds the persistent tunnel WebSocket from the Paperclip server and forwards requests through it.

Key implementation details:

- **Subdomain routing**: Each instance gets a subdomain (`<id>.relay.example.com`). The Worker extracts the instance ID from the `Host` header and routes to the corresponding Durable Object. Admin endpoints (`/register`, `/tunnel`, `/health`) live on the root domain.
- **Configurable domain**: The relay domain is set via `RELAY_DOMAIN` in `wrangler.toml` — not hardcoded. Anyone can deploy their own relay on any domain.
- **Hibernation recovery**: Durable Objects hibernate when idle, losing in-memory state. WebSockets are restored in the constructor via `getWebSockets()` using tags (`"__tunnel__"` for the tunnel, wsId for clients). Duplicate tunnel WebSockets (from server restarts before old tunnel closes) are detected and cleaned up.
- **Binary multiplexing**: WebSocket data frames are sent as binary tunnel frames (37-byte header + raw payload). JSON is only used for control messages. The DO never inspects WebSocket message content.
- **Multi-value headers**: `set-cookie` headers cannot be comma-joined (cookie values contain commas in date strings). These are sent as JSON arrays with a companion `x-relay-multi-<header>` flag.

### 9.1 `wrangler.toml`

```toml
name = "paperclip-relay"
main = "src/index.ts"
compatibility_date = "2025-01-01"
workers_dev = true

routes = [
  { pattern = "your-domain.com/*", zone_name = "your-domain.com" },
  { pattern = "*.your-domain.com/*", zone_name = "your-domain.com" },
]

[vars]
RELAY_DOMAIN = "your-domain.com"

[durable_objects]
bindings = [
  { name = "TUNNEL", class_name = "TunnelDO" }
]

[[migrations]]
tag = "v1"
new_classes = ["TunnelDO"]
```

### 9.2 `package.json`

```json
{
  "name": "paperclip-relay",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20250301.0",
    "wrangler": "^4.0.0"
  }
}
```

### 9.3 `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "noEmit": true
  },
  "include": ["src"]
}
```

### 9.4 `src/index.ts`

```typescript
export { TunnelDO } from "./tunnel";

interface Env {
  TUNNEL: DurableObjectNamespace;
  RELAY_DOMAIN: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const instanceId = extractSubdomain(url.hostname, env.RELAY_DOMAIN);

    // Subdomain request (e.g. skl1l.relay.example.com) → proxy to instance DO
    if (instanceId) {
      const stub = env.TUNNEL.get(env.TUNNEL.idFromName(instanceId));
      return stub.fetch(request);
    }

    // Admin routes on root domain
    if (url.pathname === "/register" && request.method === "POST") {
      return handleRegister(env);
    }

    if (url.pathname === "/tunnel") {
      const authHeader = request.headers.get("authorization") ?? "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
      if (!token) return new Response("Missing token", { status: 401 });
      return routeToTunnel(env, token, request);
    }

    if (url.pathname === "/health") {
      return Response.json({ status: "ok" });
    }

    return new Response("Not Found", { status: 404 });
  },
};

/** Extract instance ID from subdomain: skl1l.example.com → skl1l (given base "example.com") */
function extractSubdomain(hostname: string, relayDomain: string): string | null {
  const suffix = `.${relayDomain}`;
  if (hostname.endsWith(suffix)) {
    return hostname.slice(0, -suffix.length) || null;
  }
  return null;
}

async function handleRegister(env: Env): Promise<Response> {
  const instanceId = generateId(5);
  const token = "rl_" + generateId(32);

  // Initialize the instance DO
  const doId = env.TUNNEL.idFromName(instanceId);
  const stub = env.TUNNEL.get(doId);
  await stub.fetch(new Request("http://internal/init", {
    method: "POST",
    body: JSON.stringify({ token, instanceId, relayDomain: env.RELAY_DOMAIN }),
  }));

  // Store token → instanceId mapping in the registry DO
  const registry = env.TUNNEL.get(env.TUNNEL.idFromName("__token_registry__"));
  await registry.fetch(new Request("http://internal/register-token", {
    method: "POST",
    body: JSON.stringify({ token, instanceId }),
  }));

  const publicUrl = `https://${instanceId}.${env.RELAY_DOMAIN}`;
  return Response.json({ token, instanceId, publicUrl });
}

/** Look up instanceId from token, then route to the tunnel DO */
async function routeToTunnel(
  env: Env,
  token: string,
  request: Request,
): Promise<Response> {
  const registry = env.TUNNEL.get(env.TUNNEL.idFromName("__token_registry__"));
  const resp = await registry.fetch(new Request("http://internal/lookup", {
    method: "POST",
    body: JSON.stringify({ token }),
  }));
  if (!resp.ok) return new Response("Invalid token", { status: 401 });
  const { instanceId } = await resp.json() as { instanceId: string };

  const stub = env.TUNNEL.get(env.TUNNEL.idFromName(instanceId));
  return stub.fetch(request);
}

function generateId(length: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}
```

### 9.5 `src/tunnel.ts`

```typescript
/**
 * Binary data frame format on the tunnel WebSocket:
 *   Byte 0:       Flags (bit 0 = isBinary: 0 = text, 1 = binary)
 *   Bytes 1–36:   Stream ID (UUID as 36 ASCII chars)
 *   Bytes 37+:    Raw payload (untouched)
 */
const DATA_FRAME_HEADER_SIZE = 37;

interface PendingRequest {
  resolve: (response: Response) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export class TunnelDO {
  private state: DurableObjectState;
  private tunnelWs: WebSocket | null = null;
  private pendingRequests = new Map<string, PendingRequest>();
  private clientWebSockets = new Map<string, WebSocket>();
  private instanceId: string | null = null;
  private relayDomain: string | null = null;

  constructor(state: DurableObjectState) {
    this.state = state;

    // Restore WebSockets after hibernation. The tunnel WS is tagged
    // "__tunnel__"; client WSes are tagged with their wsId.
    // If multiple tunnel WSes exist (e.g., server restarted before old
    // tunnel closed), keep only the last one and close duplicates.
    const allWs = this.state.getWebSockets();
    const tunnelCandidates: WebSocket[] = [];
    for (const ws of allWs) {
      const tags = this.state.getTags(ws);
      if (tags.includes("__tunnel__")) {
        tunnelCandidates.push(ws);
      } else if (tags.length > 0) {
        this.clientWebSockets.set(tags[0], ws);
      }
    }
    if (tunnelCandidates.length > 0) {
      this.tunnelWs = tunnelCandidates[tunnelCandidates.length - 1];
      for (let i = 0; i < tunnelCandidates.length - 1; i++) {
        try { tunnelCandidates[i].close(1000, "duplicate tunnel"); } catch {}
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/init" && request.method === "POST") {
      return this.handleInit(request);
    }

    if (url.pathname === "/register-token" && request.method === "POST") {
      return this.handleRegisterToken(request);
    }

    if (url.pathname === "/lookup" && request.method === "POST") {
      return this.handleTokenLookup(request);
    }

    if (url.pathname === "/tunnel") {
      return this.handleTunnelConnect();
    }

    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return this.handleClientWebSocket(request, url);
    }

    return this.handleHttpProxy(request, url);
  }

  // -- Internal routes -------------------------------------------------------

  private async handleInit(request: Request): Promise<Response> {
    const { token, instanceId, relayDomain } = await request.json() as {
      token: string; instanceId: string; relayDomain: string;
    };
    this.instanceId = instanceId;
    this.relayDomain = relayDomain;
    await this.state.storage.put("token", token);
    await this.state.storage.put("instanceId", instanceId);
    await this.state.storage.put("relayDomain", relayDomain);
    return new Response("OK");
  }

  private async handleRegisterToken(request: Request): Promise<Response> {
    const { token, instanceId } = await request.json() as { token: string; instanceId: string };
    await this.state.storage.put(`token:${token}`, instanceId);
    return new Response("OK");
  }

  private async handleTokenLookup(request: Request): Promise<Response> {
    const { token } = await request.json() as { token: string };
    const instanceId = await this.state.storage.get<string>(`token:${token}`);
    if (!instanceId) return new Response("Not found", { status: 404 });
    return Response.json({ instanceId });
  }

  // -- Tunnel connection -----------------------------------------------------

  private handleTunnelConnect(): Response {
    // Close any existing tunnel WebSocket(s) before accepting the new one.
    for (const ws of this.state.getWebSockets()) {
      const tags = this.state.getTags(ws);
      if (tags.includes("__tunnel__")) {
        try { ws.close(1000, "replaced by new tunnel"); } catch {}
      }
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.state.acceptWebSocket(server, ["__tunnel__"]);
    this.tunnelWs = server;

    void Promise.all([
      this.state.storage.get<string>("instanceId"),
      this.state.storage.get<string>("relayDomain"),
    ]).then(([id, domain]) => {
      this.instanceId = id ?? null;
      this.relayDomain = domain ?? null;
      if (this.instanceId && this.relayDomain) {
        server.send(JSON.stringify({
          type: "tunnel-ready",
          instanceId: this.instanceId,
          publicUrl: `https://${this.instanceId}.${this.relayDomain}`,
        }));
      }
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  // -- HTTP proxy ------------------------------------------------------------

  private handleHttpProxy(request: Request, url: URL): Promise<Response> {
    if (!this.tunnelWs || this.tunnelWs.readyState !== WebSocket.OPEN) {
      return Promise.resolve(new Response("Tunnel offline", { status: 502 }));
    }

    const id = crypto.randomUUID();

    return new Promise<Response>(async (resolve) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        resolve(new Response("Gateway Timeout", { status: 504 }));
      }, 30_000);

      this.pendingRequests.set(id, { resolve, timeout });

      const headers: Record<string, string> = {};
      for (const [key, value] of request.headers.entries()) {
        headers[key] = value;
      }
      headers["x-forwarded-host"] = url.host;
      headers["x-forwarded-proto"] = "https";

      const bodyBuf = request.body
        ? await request.arrayBuffer()
        : new ArrayBuffer(0);

      this.tunnelWs!.send(JSON.stringify({
        id,
        type: "http-request",
        method: request.method,
        path: url.pathname + url.search,
        headers,
        body: arrayBufferToBase64(bodyBuf),
      }));
    });
  }

  // -- WebSocket proxy -------------------------------------------------------

  private handleClientWebSocket(request: Request, url: URL): Response {
    if (!this.tunnelWs || this.tunnelWs.readyState !== WebSocket.OPEN) {
      return new Response("Tunnel offline", { status: 502 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const wsId = crypto.randomUUID();

    this.state.acceptWebSocket(server, [wsId]);
    this.clientWebSockets.set(wsId, server);

    const headers: Record<string, string> = {};
    for (const [key, value] of request.headers.entries()) {
      headers[key] = value;
    }

    this.tunnelWs.send(JSON.stringify({
      type: "ws-open",
      id: wsId,
      path: url.pathname + url.search,
      headers,
    }));

    return new Response(null, { status: 101, webSocket: client });
  }

  // -- WebSocket event handlers ----------------------------------------------

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (ws === this.tunnelWs) {
      this.handleTunnelMessage(message);
      return;
    }

    // Message from a client WebSocket → encode as binary data frame → send through tunnel
    for (const [wsId, clientWs] of this.clientWebSockets) {
      if (clientWs === ws) {
        if (this.tunnelWs && this.tunnelWs.readyState === WebSocket.OPEN) {
          const isBinary = message instanceof ArrayBuffer;
          const payload = isBinary
            ? new Uint8Array(message)
            : new TextEncoder().encode(message as string);

          const frame = new Uint8Array(DATA_FRAME_HEADER_SIZE + payload.length);
          frame[0] = isBinary ? 0x01 : 0x00;
          frame.set(new TextEncoder().encode(wsId), 1);
          frame.set(payload, DATA_FRAME_HEADER_SIZE);

          this.tunnelWs.send(frame.buffer);
        }
        return;
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    if (ws === this.tunnelWs) {
      this.tunnelWs = null;
      this.clientWebSockets.forEach((cws) => cws.close(1001));
      this.clientWebSockets.clear();
      this.pendingRequests.forEach((p) => {
        clearTimeout(p.timeout);
        p.resolve(new Response("Tunnel disconnected", { status: 502 }));
      });
      this.pendingRequests.clear();
      return;
    }

    for (const [wsId, clientWs] of this.clientWebSockets) {
      if (clientWs === ws) {
        this.clientWebSockets.delete(wsId);
        this.tunnelWs?.send(JSON.stringify({
          type: "ws-close",
          id: wsId,
          code,
        }));
        return;
      }
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    void this.webSocketClose(ws, 1006);
  }

  // -- Private helpers -------------------------------------------------------

  private handleTunnelMessage(message: string | ArrayBuffer): void {
    // Binary frame = raw WS data with stream ID header
    if (message instanceof ArrayBuffer) {
      const frame = new Uint8Array(message);
      if (frame.length < DATA_FRAME_HEADER_SIZE) return;

      const isBinary = (frame[0]! & 0x01) !== 0;
      const streamId = new TextDecoder().decode(frame.subarray(1, DATA_FRAME_HEADER_SIZE));
      const payload = frame.subarray(DATA_FRAME_HEADER_SIZE);

      const clientWs = this.clientWebSockets.get(streamId);
      if (clientWs && clientWs.readyState === WebSocket.OPEN) {
        if (isBinary) {
          clientWs.send(payload.buffer);
        } else {
          clientWs.send(new TextDecoder().decode(payload));
        }
      }
      return;
    }

    // Text frame = JSON control/HTTP message
    let msg: any;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }

    if (msg.type === "http-response") {
      const pending = this.pendingRequests.get(msg.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(msg.id);

      const headers = new Headers();
      for (const [key, value] of Object.entries(msg.headers as Record<string, string>)) {
        if (key.startsWith("x-relay-multi-")) continue;
        if (msg.headers[`x-relay-multi-${key}`]) {
          try {
            for (const v of JSON.parse(value) as string[]) {
              headers.append(key, v);
            }
          } catch {
            headers.set(key, value);
          }
        } else {
          headers.set(key, value);
        }
      }

      pending.resolve(new Response(base64ToArrayBuffer(msg.body), {
        status: msg.status,
        headers,
      }));
    } else if (msg.type === "ws-close" || msg.type === "ws-error") {
      const clientWs = this.clientWebSockets.get(msg.id);
      if (clientWs) {
        clientWs.close(msg.code ?? 1000);
        this.clientWebSockets.delete(msg.id);
      }
    }
  }
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
```

## 10. Relationship to Other Docs

- deployment modes: `doc/DEPLOYMENT-MODES.md` — `authenticated` mode is required for relay
