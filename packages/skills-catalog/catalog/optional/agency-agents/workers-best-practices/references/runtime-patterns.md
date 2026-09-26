# Workers Runtime Patterns

Consult the sections relevant to the affected behavior. Examples show preferred patterns and common mistakes; **Retrieve** links identify documentation to check when an API, behavior, or limit is uncertain. Doc paths are relative to `https://developers.cloudflare.com`.

- [Request and response handling](#request--response-handling): streaming, memory use, and post-response work
- [Architecture](#architecture): bindings, Queues, Workflows, and database connections
- [Code patterns](#code-patterns): request state, promise lifetime, and platform limits
- [Security](#security): Web Crypto and error handling
- [Development and testing](#development--testing): tests in the Workers runtime

## Request & Response Handling

### Stream request and response bodies

Workers have a 128 MB memory limit. Buffering entire bodies with `await response.text()` or `await request.arrayBuffer()` crashes on large payloads. Stream data through using `TransformStream` or pass `response.body` directly.

**Check**: any `await response.text()`, `await response.json()`, or `await response.arrayBuffer()` on data that could be large or unbounded. Small, bounded payloads (known-size JSON, config files) are fine to buffer.

Correct — stream through:
```ts
async fetch(request: Request, env: Env): Promise<Response> {
  const response = await fetch("https://api.example.com/large-dataset");
  return new Response(response.body, response);
}
```

Correct — concatenate multiple streams:
```ts
async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const urls = ["https://api.example.com/part-1", "https://api.example.com/part-2"];
  const { readable, writable } = new TransformStream();

  // Track the pipeline promise — don't let it float
  ctx.waitUntil((async () => {
    for (const url of urls) {
      const response = await fetch(url);
      if (response.body) {
        await response.body.pipeTo(writable, { preventClose: true });
      }
    }
    await writable.close();
  })());

  return new Response(readable, {
    headers: { "Content-Type": "application/octet-stream" },
  });
}
```

Anti-pattern:
```ts
// Buffers entire body — crashes on large payloads
const response = await fetch("https://api.example.com/large-dataset");
const text = await response.text();
return new Response(text);
```

**Retrieve**: streaming APIs at `/workers/runtime-apis/streams/`.

### Use Zod 4.5.0 or later

**Check**: Workers using Zod for runtime validation depend on [Zod 4.5.0 or later](https://github.com/colinhacks/zod/releases/tag/v4.5.0); older versions retain substantially more heap per schema, so check the installed version when investigating high memory usage or OOMs.

### Use waitUntil for work after the response

`ctx.waitUntil()` performs background work (analytics, cache writes, webhooks) after the response is sent. Keeps response fast. 30-second time limit after response.

**Check**: background work uses `ctx.waitUntil()`, not inline `await`. Do not destructure `ctx` — it loses the `this` binding and throws "Illegal invocation".

```ts
async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const data = await processRequest(request);

  ctx.waitUntil(logToAnalytics(env, data));
  ctx.waitUntil(updateCache(env, data));

  return Response.json(data);
}
```

Anti-pattern:
```ts
// Destructuring ctx loses the this binding
const { waitUntil } = ctx;  // "Illegal invocation" at runtime
waitUntil(somePromise);
```

---

## Architecture

### Use bindings for Cloudflare services, not REST APIs

Bindings (KV, R2, D1, Queues, Workflows) are direct, in-process references — no network hop, no authentication, no extra latency. Using the Cloudflare REST API from a Worker wastes time and adds complexity.

**Check**: no `fetch("https://api.cloudflare.com/client/v4/...")` calls for services available as bindings.

```ts
// Binding — direct, zero-cost
const object = await env.MY_BUCKET.get("my-file");
```

Anti-pattern:
```ts
// REST API from inside a Worker — unnecessary overhead
const response = await fetch(
  "https://api.cloudflare.com/client/v4/accounts/.../r2/buckets/.../objects/my-file",
  { headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` } }
);
```

### Use Queues and Workflows for async and background work

Long-running, retriable, or non-urgent tasks should not block a request.

- **Queues**: decouple producer from consumer. Fan-out, buffering/batching, simple single-step background jobs. At-least-once delivery.
- **Workflows**: multi-step durable execution. Each step's return value is persisted; only failed steps retry. Can run for hours/days/weeks.
- **Both together**: Queue buffers high-throughput entry, consumer creates Workflow instances for complex processing.

**Check**: long-running work (email sends, webhooks, multi-step processes) is offloaded to Queues or Workflows, not done inline in the fetch handler.

```ts
async fetch(request: Request, env: Env): Promise<Response> {
  const order = await request.json<{ id: string; type: string }>();

  if (order.type === "simple") {
    await env.ORDER_QUEUE.send({ orderId: order.id, action: "send-email" });
  } else {
    await env.FULFILLMENT_WORKFLOW.create({ params: { orderId: order.id } });
  }

  return Response.json({ status: "accepted" }, { status: 202 });
}
```

**Retrieve**: `/queues/` and `/workflows/` for current APIs. For Workflow-specific rules, see [Rules of Workflows](https://developers.cloudflare.com/workflows/build/rules-of-workflows/).

### Use service bindings for Worker-to-Worker communication

Service bindings are zero-cost, bypass the public internet, and support type-safe RPC. Do not call another Worker via its public URL.

**Check**: Worker-to-Worker calls use `env.SERVICE_NAME.method()` (RPC) or `env.SERVICE_NAME.fetch()`, not `fetch("https://my-other-worker.example.com/...")`.

```ts
import { WorkerEntrypoint } from "cloudflare:workers";

export class AuthService extends WorkerEntrypoint {
  async verifyToken(token: string): Promise<{ userId: string; valid: boolean }> {
    return { userId: "user-123", valid: true };
  }
}

// Caller Worker
const auth = await env.AUTH_SERVICE.verifyToken(token);
```

**Retrieve**: verify uncertain `WorkerEntrypoint` import paths or signatures against the project's target types, consulting current docs when runtime compatibility needs clarification.

### Use Hyperdrive for external database connections

Hyperdrive maintains a regional connection pool, eliminating per-request TCP + TLS + auth cost (often 300-500ms). Create a new `Client` per request — Hyperdrive manages the underlying pool. Requires `nodejs_compat`.

**Check**: any `new Client()` or database connection that uses a direct connection string instead of `env.HYPERDRIVE.connectionString`.

```jsonc
{
  "hyperdrive": [{ "binding": "HYPERDRIVE", "id": "<YOUR_HYPERDRIVE_ID>" }]
}
```

```ts
import { Client } from "pg";

async fetch(request: Request, env: Env): Promise<Response> {
  const client = new Client({ connectionString: env.HYPERDRIVE.connectionString });
  await client.connect();
  const result = await client.query("SELECT id, name FROM users LIMIT 10");
  return Response.json(result.rows);
}
```

**Retrieve**: `/hyperdrive/` for current configuration and supported databases.

---

## Code Patterns

### Do not store request-scoped state in global scope

Workers reuse isolates across requests. Module-level mutable variables cause cross-request data leaks, stale state, and "Cannot perform I/O on behalf of a different request" errors.

**Check**: no mutable `let`/`var` at module scope that gets assigned inside a handler. Pass state through function arguments.

```ts
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const userId = request.headers.get("X-User-Id");
    const result = await handleRequest(userId, env);
    return Response.json(result);
  },
} satisfies ExportedHandler<Env>;
```

Anti-pattern:
```ts
// Module-level mutable state — leaks between requests
let currentUser: string | null = null;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    currentUser = request.headers.get("X-User-Id");  // Visible to next request
    // ...
  },
};
```

### Always await or waitUntil Promises

A Promise that is not `await`ed, `return`ed, or passed to `ctx.waitUntil()` is a floating promise. Causes: dropped results, swallowed errors, unfinished work. The runtime may terminate the isolate before it completes.

**Check**: async calls in the affected execution path are awaited, returned, or attached to the appropriate lifetime. Use the project's existing floating-promise lint check, such as Oxlint's [typescript/no-floating-promises](https://oxc.rs/docs/guide/usage/linter/rules/typescript/no-floating-promises.html), when available and relevant; otherwise inspect the promise paths directly. Adding lint tooling is a separate change, not a prerequisite for reviewing this behavior.

```ts
// Correct: await when you need the result
const response = await fetch("https://api.example.com/process", { method: "POST", body: JSON.stringify(data) });

// Correct: waitUntil when you don't need the result before responding
ctx.waitUntil(fetch("https://api.example.com/webhook", { method: "POST", body: JSON.stringify(data) }));
```

Anti-pattern:
```ts
// Floating promise — result dropped, error swallowed
fetch("https://api.example.com/webhook", { method: "POST", body: JSON.stringify(data) });
```

### Be aware of platform limits

Workers have a 10ms CPU time limit (Bundled) or 30s (Standard/Unbound). Heavy synchronous work — tight loops, large JSON parsing, compute-intensive crypto — can hit the CPU limit and terminate the request.

**Check**: compute-heavy operations that run synchronously. Consider breaking work into smaller chunks, offloading to Queues/Workflows, or using WebAssembly for CPU-intensive tasks.

**Retrieve**: current limits at `/workers/platform/limits/`.

---

## Security

### Use Web Crypto for secure token generation

Use `crypto.randomUUID()` for unique IDs and `crypto.getRandomValues()` for random bytes. `Math.random()` is not cryptographically secure.

For comparing secrets (API keys, HMAC signatures), use `crypto.subtle.timingSafeEqual()`. Hash both values to a fixed size first — do not short-circuit on length mismatch (leaks length via timing).

**Check**: no `Math.random()` for security-sensitive values. Secret comparisons use `timingSafeEqual` with fixed-size hashing.

```ts
// Secure random UUID
const sessionId = crypto.randomUUID();

// Secure random bytes
const tokenBytes = new Uint8Array(32);
crypto.getRandomValues(tokenBytes);
const token = Array.from(tokenBytes).map((b) => b.toString(16).padStart(2, "0")).join("");
```

```ts
// Constant-time comparison — hash first to avoid length leak
async function verifyToken(provided: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
}
```

Anti-pattern:
```ts
// Predictable — not cryptographically secure
const token = Math.random().toString(36).substring(2);

// Timing side-channel — leaks information about the expected value
return provided === expected;
```

**Retrieve**: `/workers/runtime-apis/web-crypto/` for current API surface.

### Explicit error handling over passThroughOnException

`passThroughOnException()` is a fail-open mechanism that sends requests to the origin when the Worker throws. It hides bugs and makes debugging difficult. Use explicit try/catch with structured error responses.

**Check**: no `ctx.passThroughOnException()` calls. Error handling uses try/catch with structured JSON error responses and `console.error`.

```ts
async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  try {
    const result = await handleRequest(request, env);
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(JSON.stringify({ message: "unhandled error", error: message, path: new URL(request.url).pathname }));
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
```

---

## Development & Testing

### Test with @cloudflare/vitest-pool-workers

Runs tests inside the Workers runtime with real bindings. Catches issues that Node.js-based tests miss.

**Known pitfall**: the Vitest pool auto-injects `nodejs_compat`, so tests pass even if your wrangler config is missing the flag. Always confirm your `wrangler.jsonc` includes `nodejs_compat` if your code depends on Node.js built-ins.

**Check**: test setup uses `@cloudflare/vitest-pool-workers`. Tests cover nullable returns (e.g., KV `.get()` returning `null`).

```ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";

describe("KV operations", () => {
  it("should store and retrieve a value", async () => {
    await env.MY_KV.put("key", "value");
    const result = await env.MY_KV.get("key");
    expect(result).toBe("value");
  });

  it("should return null for missing keys", async () => {
    const result = await env.MY_KV.get("nonexistent");
    expect(result).toBeNull();
  });
});
```

**Retrieve**: `/workers/testing/vitest-integration/` for current setup and configuration.
