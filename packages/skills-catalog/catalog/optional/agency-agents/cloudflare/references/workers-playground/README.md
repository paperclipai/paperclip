# Cloudflare Workers Playground Skill Reference

## Overview

Cloudflare Workers Playground is a browser-based sandbox for instantly experimenting with, testing, and deploying Cloudflare Workers without authentication or setup. This skill provides patterns, APIs, and best practices specifically for Workers Playground development.

**URL:** [workers.cloudflare.com/playground](https://workers.cloudflare.com/playground)

## ⚠️ Playground Constraints

**Playground is NOT production-equivalent:**
- ✅ Real Workers runtime, instant testing, shareable URLs
- ❌ No TypeScript (JavaScript only)
- ❌ No bindings (KV, D1, R2, Durable Objects)
- ❌ No environment variables or secrets
- ❌ ES modules only (no Service Worker format)
- ⚠️ Safari broken (use Chrome/Firefox)

**For production:** Use `wrangler` CLI. Playground is for rapid prototyping.

## Quick Start

Minimal Worker:

```javascript
export default {
  async fetch(request, env, ctx) {
    return new Response('Hello World');
  }
};
```

JSON API:

```javascript
export default {
  async fetch(request, env, ctx) {
    const data = { message: 'Hello', timestamp: Date.now() };
    return Response.json(data);
  }
};
```

Proxy with modification:

```javascript
export default {
  async fetch(request, env, ctx) {
    const response = await fetch('https://example.com');
    const modified = new Response(response.body, response);
    modified.headers.set('X-Custom-Header', 'added-by-worker');
    return modified;
  }
};
```

Import from CDN:

```javascript
import { Hono } from 'https://esm.sh/hono@3';

export default {
  async fetch(request) {
    const app = new Hono();
    app.get('/', (c) => c.text('Hello Hono!'));
    return app.fetch(request);
  }
};
```

## Reading Order

1. **[configuration.md](configuration.md)** - Start here: playground setup, constraints, deployment
2. **[api.md](api.md)** - Core APIs: Request, Response, ExecutionContext, fetch, Cache
3. **[patterns.md](patterns.md)** - Common use cases: routing, proxying, A/B testing, multi-module code
4. **[gotchas.md](gotchas.md)** - Troubleshooting: errors, browser issues, limits, best practices

## In This Reference

- **[configuration.md](configuration.md)** - Setup, deployment, configuration
- **[api.md](api.md)** - API endpoints, methods, interfaces
- **[patterns.md](patterns.md)** - Common patterns, use cases, examples
- **[gotchas.md](gotchas.md)** - Troubleshooting, best practices, limitations

## Key Features

**No Setup Required:**
- Open URL and start coding
- No CLI, no account, no config files
- Code executes in real Cloudflare Workers runtime

**Instant Preview:**
- Live preview pane with browser tab or HTTP tester
- Auto-reload on code changes
- DevTools integration (right-click → Inspect)

**Share & Deploy:**
- Copy Link generates permanent shareable URL
- Deploy button publishes to production in ~30 seconds
- Get `*.workers.dev` subdomain immediately

## Common Use Cases

- **API development:** Test endpoints before wrangler setup
- **Learning Workers:** Experiment with APIs without local environment
- **Prototyping:** Quick POCs for edge logic
- **Sharing examples:** Generate shareable links for bug reports or demos
- **Framework testing:** Import from CDN (Hono, itty-router, etc.)

## Limitations vs Production

| Feature | Playground | Production (wrangler) |
|---------|------------|----------------------|
| Language | JavaScript only | JS + TypeScript |
| Bindings | None | KV, D1, R2, DO, AI, etc. |
| Environment vars | None | Full support |
| Module format | ES only | ES + Service Worker |
| CPU time | 10ms (Free plan) | 10ms Free / 30s default, 5min max Paid |
| Custom domains | No | Yes |
| Analytics | No | Yes |

## See Also

- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
- [Workers Examples](https://developers.cloudflare.com/workers/examples/)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)
- [Workers API Reference](https://developers.cloudflare.com/workers/runtime-apis/)
