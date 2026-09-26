# Workers Playground API

## Handler

```javascript
export default {
  async fetch(request, env, ctx) {
    // request: Request, env: {} (empty in playground), ctx: ExecutionContext
    return new Response('Hello');
  }
};
```

## Request

```javascript
const method = request.method;       // "GET", "POST"
const url = new URL(request.url);    // Parse URL
const headers = request.headers;     // Headers object
const body = await request.json();   // Read body (consumes stream)
const clone = request.clone();       // Clone before reading body

// Query params
url.searchParams.get('page');        // Single value
url.searchParams.getAll('tag');      // Array

// Cloudflare metadata
request.cf.country;                  // "US"
request.cf.colo;                     // "SFO"
```

## Response

```javascript
// Text
return new Response('Hello', { status: 200 });

// JSON
return Response.json({ data }, { status: 200, headers: {...} });

// Redirect
return Response.redirect('/new-path', 301);

// Modify existing
const modified = new Response(response.body, response);
modified.headers.set('X-Custom', 'value');
```

## ExecutionContext

```javascript
// Background work (after response sent)
ctx.waitUntil(fetch('https://logs.example.com', { method: 'POST', body: '...' }));
return new Response('OK'); // Returns immediately
```

## Fetch

```javascript
const response = await fetch('https://api.example.com');
const data = await response.json();

// With options
await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'Alice' })
});
```

## Cache

```javascript
const cache = caches.default;

// Check cache
let response = await cache.match(request);
if (!response) {
  response = await fetch(origin);
  await cache.put(request, response.clone()); // Clone before put!
}
return response;
```

## Crypto

```javascript
crypto.randomUUID();                 // UUID v4
crypto.getRandomValues(new Uint8Array(16));

// SHA-256 hash
const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
```

## Limits (Playground = Free Plan)

| Resource | Limit |
|----------|-------|
| CPU time | 10ms (Free plan; Paid: 30s default, 5min max) |
| Subrequests | 50 |
| Memory | 128 MB |
