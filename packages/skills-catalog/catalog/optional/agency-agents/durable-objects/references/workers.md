# Cloudflare Workers Best Practices

High-level guidance for Workers that invoke Durable Objects.

## Wrangler Configuration

### wrangler.jsonc (Recommended)

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "my-worker",
  "main": "src/index.ts",
  "compatibility_date": "2024-12-01",
  "compatibility_flags": ["nodejs_compat"],

  "durable_objects": {
    "bindings": [
      { "name": "CHAT_ROOM", "class_name": "ChatRoom" },
      { "name": "USER_SESSION", "class_name": "UserSession" }
    ]
  },

  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["ChatRoom", "UserSession"] }
  ],

  // Environment variables
  "vars": {
    "ENVIRONMENT": "production"
  },

  // KV namespaces
  "kv_namespaces": [
    { "binding": "CONFIG", "id": "abc123" }
  ],

  // R2 buckets
  "r2_buckets": [
    { "binding": "UPLOADS", "bucket_name": "my-uploads" }
  ],

  // D1 databases
  "d1_databases": [
    { "binding": "DB", "database_id": "xyz789" }
  ]
}
```

### wrangler.toml (Alternative)

```toml
name = "my-worker"
main = "src/index.ts"
compatibility_date = "2024-12-01"
compatibility_flags = ["nodejs_compat"]

[[durable_objects.bindings]]
name = "CHAT_ROOM"
class_name = "ChatRoom"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["ChatRoom"]

[vars]
ENVIRONMENT = "production"
```

## TypeScript Types

### Environment Interface

```typescript
// src/types.ts
import { ChatRoom } from "./durable-objects/chat-room";
import { UserSession } from "./durable-objects/user-session";

export interface Env {
  // Durable Objects
  CHAT_ROOM: DurableObjectNamespace<ChatRoom>;
  USER_SESSION: DurableObjectNamespace<UserSession>;

  // KV
  CONFIG: KVNamespace;

  // R2
  UPLOADS: R2Bucket;

  // D1
  DB: D1Database;

  // Environment variables
  ENVIRONMENT: string;
  API_KEY: string; // From secrets
}
```

### Export Durable Object Classes

```typescript
// src/index.ts
export { ChatRoom } from "./durable-objects/chat-room";
export { UserSession } from "./durable-objects/user-session";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Worker handler
  },
};
```

## Worker Handler Pattern

```typescript
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    try {
      // Route to appropriate handler
      if (url.pathname.startsWith("/api/rooms")) {
        return handleRooms(request, env);
      }
      if (url.pathname.startsWith("/api/users")) {
        return handleUsers(request, env);
      }

      return new Response("Not Found", { status: 404 });
    } catch (error) {
      console.error("Request failed:", error);
      return new Response("Internal Server Error", { status: 500 });
    }
  },
};

async function handleRooms(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const roomId = url.searchParams.get("room");

  if (!roomId) {
    return Response.json({ error: "Missing room parameter" }, { status: 400 });
  }

  const stub = env.CHAT_ROOM.getByName(roomId);

  if (request.method === "POST") {
    const body = await request.json<{ userId: string; message: string }>();
    const result = await stub.sendMessage(body.userId, body.message);
    return Response.json(result);
  }

  const messages = await stub.getMessages();
  return Response.json(messages);
}
```

## Request Validation

```typescript
import { z } from "zod";

const SendMessageSchema = z.object({
  userId: z.string().min(1),
  message: z.string().min(1).max(1000),
});

async function handleSendMessage(request: Request, env: Env): Promise<Response> {
  const body = await request.json();
  const result = SendMessageSchema.safeParse(body);

  if (!result.success) {
    return Response.json(
      { error: "Validation failed", details: result.error.issues },
      { status: 400 }
    );
  }

  const stub = env.CHAT_ROOM.getByName(result.data.userId);
  const message = await stub.sendMessage(result.data.userId, result.data.message);
  return Response.json(message);
}
```

## Observability & Logging

### Structured Logging

```typescript
function log(level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>) {
  console.log(JSON.stringify({
    level,
    message,
    timestamp: new Date().toISOString(),
    ...data,
  }));
}

// Usage
log("info", "Request received", { path: url.pathname, method: request.method });
log("error", "DO call failed", { roomId, error: String(error) });
```

### Request Tracing

```typescript
async function handleRequest(request: Request, env: Env): Promise<Response> {
  const requestId = crypto.randomUUID();
  const startTime = Date.now();

  try {
    const response = await processRequest(request, env);

    log("info", "Request completed", {
      requestId,
      duration: Date.now() - startTime,
      status: response.status,
    });

    return response;
  } catch (error) {
    log("error", "Request failed", {
      requestId,
      duration: Date.now() - startTime,
      error: String(error),
    });
    throw error;
  }
}
```

### Tail Workers (Production)

For production logging, use Tail Workers to forward logs:

```jsonc
// wrangler.jsonc
{
  "tail_consumers": [
    { "service": "log-collector" }
  ]
}
```

## Error Handling

### Graceful DO Errors

```typescript
async function callDO(stub: DurableObjectStub<ChatRoom>, method: string): Promise<Response> {
  try {
    const result = await stub.getMessages();
    return Response.json(result);
  } catch (error) {
    if (error instanceof Error) {
      // DO threw an error
      log("error", "DO operation failed", { error: error.message });
      return Response.json(
        { error: "Service temporarily unavailable" },
        { status: 503 }
      );
    }
    throw error;
  }
}
```

### Timeout Handling

```typescript
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("Timeout")), ms)
  );
  return Promise.race([promise, timeout]);
}

// Usage
const result = await withTimeout(stub.processData(data), 5000);
```

## CORS Handling

```typescript
function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    const response = await handleRequest(request, env);
    
    // Add CORS headers to response
    const newHeaders = new Headers(response.headers);
    Object.entries(corsHeaders()).forEach(([k, v]) => newHeaders.set(k, v));
    
    return new Response(response.body, {
      status: response.status,
      headers: newHeaders,
    });
  },
};
```

## Secrets Management

Set secrets via wrangler CLI (not in config files):

```bash
wrangler secret put API_KEY
wrangler secret put DATABASE_URL
```

Access in code:
```typescript
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const apiKey = env.API_KEY; // From secret
    // ...
  },
};
```

## Development Commands

```bash
# Local development
wrangler dev

# Deploy
wrangler deploy

# Tail logs
wrangler tail

# List DOs
wrangler d1 execute DB --command "SELECT * FROM _cf_DO"
```
