# Configuration

## Getting Started

Navigate to [workers.cloudflare.com/playground](https://workers.cloudflare.com/playground)

- **No account required** for testing
- **No CLI or local setup** needed
- Code executes in real Cloudflare Workers runtime
- Share code via URL (never expires)

## Playground Constraints

⚠️ **Important Limitations**

| Constraint | Playground | Production Workers |
|------------|------------|-------------------|
| **Module Format** | ES modules only | ES modules or Service Worker |
| **TypeScript** | Not supported (JS only) | Supported via build step |
| **Bindings** | Not available | KV, D1, R2, Durable Objects, etc. |
| **wrangler.toml** | Not used | Required for config |
| **Environment Variables** | Not available | Full support |
| **Secrets** | Not available | Full support |
| **Custom Domains** | Not available | Full support |

**Playground is for rapid prototyping only.** For production apps, use `wrangler` CLI.

## Code Editor

### Syntax Requirements

Must export default object with `fetch` handler:

```javascript
export default {
  async fetch(request, env, ctx) {
    return new Response('Hello World');
  }
};
```

**Key Points:**
- Must use ES modules (`export default`)
- `fetch` method receives `(request, env, ctx)`
- Must return `Response` object
- TypeScript not supported (use plain JavaScript)

### Multi-Module Code

Import from external URLs or inline modules:

```javascript
// Import from CDN
import { Hono } from 'https://esm.sh/hono@3';

// Or paste library code and import relatively
// (See patterns.md for multi-module examples)

export default {
  async fetch(request) {
    const app = new Hono();
    app.get('/', (c) => c.text('Hello'));
    return app.fetch(request);
  }
};
```

## Preview Panel

### Browser Tab

Default interactive preview with address bar:
- Enter custom URL paths
- Automatic reload on code changes
- DevTools available (right-click → Inspect)

### HTTP Test Panel

Switch to **HTTP** tab for raw HTTP testing:
- Change HTTP method (GET, POST, PUT, DELETE, PATCH, etc.)
- Add/edit request headers
- Modify request body (JSON, form data, text)
- View response headers and body
- Test different content types

Example HTTP test:
```
Method: POST
URL: /api/users
Headers:
  Content-Type: application/json
  Authorization: Bearer token123
Body:
{
  "name": "Alice",
  "email": "alice@example.com"
}
```

## Sharing Code

**Copy Link** button generates shareable URL:
- Code embedded in URL fragment
- Links never expire
- No account required
- Can be bookmarked for later

Example: `https://workers.cloudflare.com/playground#abc123...`

## Deploying from Playground

Click **Deploy** button to move code to production:

1. **Log in** to Cloudflare account (creates free account if needed)
2. **Review** Worker name and code
3. **Deploy** to global network (takes ~30 seconds)
4. **Get URL**: Deployed to `<name>.workers.dev` subdomain
5. **Manage** from dashboard: add bindings, custom domains, analytics

**After deploy:**
- Code runs on Cloudflare's global network (300+ cities)
- Can add KV, D1, R2, Durable Objects bindings
- Configure custom domains and routes
- View analytics and logs
- Set environment variables and secrets

**Note:** Deployed Workers are production-ready but start on Free plan (100k requests/day).

## Browser Compatibility

| Browser | Status | Notes |
|---------|--------|-------|
| Chrome/Edge | ✅ Full support | Recommended |
| Firefox | ✅ Full support | Works well |
| Safari | ⚠️ Broken | Preview fails with "PreviewRequestFailed" |

**Safari users:** Use Chrome, Firefox, or Edge for Workers Playground.

## DevTools Integration

1. **Open preview** in browser tab
2. **Right-click** → Inspect Element
3. **Console tab** shows Worker logs:
   - `console.log()` output
   - Uncaught errors
   - Network requests (subrequests)

**Note:** DevTools show client-side console, not Worker execution logs. For production logging, use Logpush or Tail Workers.

## Limits in Playground

Same as production Free plan:

| Resource | Limit | Notes |
|----------|-------|-------|
| CPU time | 10ms | Per request |
| Memory | 128 MB | Per request |
| Script size | 1 MB | After compression |
| Subrequests | 50 | Outbound fetch calls |
| Request size | 100 MB | Incoming |
| Response size | Unlimited | Outgoing (streamed) |

**Exceeding CPU time** throws error immediately. Optimize hot paths or upgrade to Paid plan (30s default, 5min max CPU).
