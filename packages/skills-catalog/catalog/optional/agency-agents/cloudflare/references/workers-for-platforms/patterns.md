# Multi-Tenant Patterns

## Billing by Plan

```typescript
interface Env {
  DISPATCHER: DispatchNamespace;
  CUSTOMERS_KV: KVNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const userWorkerName = new URL(request.url).hostname.split(".")[0];
    const customerPlan = await env.CUSTOMERS_KV.get(userWorkerName);
    
    const plans = {
      enterprise: { cpuMs: 50, subRequests: 50 },
      pro: { cpuMs: 20, subRequests: 20 },
      free: { cpuMs: 10, subRequests: 5 },
    };
    const limits = plans[customerPlan as keyof typeof plans] || plans.free;
    
    const userWorker = env.DISPATCHER.get(userWorkerName, {}, { limits });
    return await userWorker.fetch(request);
  },
};
```

## Resource Isolation

**Complete isolation:** Create unique resources per customer
- KV namespace per customer
- D1 database per customer
- R2 bucket per customer

```typescript
const bindings = [{
  type: "kv_namespace",
  name: "USER_KV",
  namespace_id: `customer-${customerId}-kv`
}];
```

## Hostname Routing

### Wildcard Route (Recommended)
Configure `*/*` route on SaaS domain → dispatch Worker

**Benefits:**
- Supports subdomains + custom vanity domains
- No per-route limits (regular Workers limited to 100 routes)
- Programmatic control
- Works with any DNS proxy settings

**Setup:**
1. Cloudflare for SaaS custom hostnames
2. Fallback origin (dummy `A 192.0.2.0` if Worker is origin)
3. DNS CNAME to SaaS domain
4. `*/*` route → dispatch Worker
5. Routing logic in dispatch Worker

```typescript
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const hostname = new URL(request.url).hostname;
    const hostnameData = await env.ROUTING_KV.get(`hostname:${hostname}`, { type: "json" });
    
    if (!hostnameData?.workerName) {
      return new Response("Hostname not configured", { status: 404 });
    }
    
    const userWorker = env.DISPATCHER.get(hostnameData.workerName);
    return await userWorker.fetch(request);
  },
};
```

### Subdomain-Only
1. Wildcard DNS: `*.saas.com` → origin
2. Route: `*.saas.com/*` → dispatch Worker
3. Extract subdomain for routing

### Orange-to-Orange (O2O) Behavior

When customers use Cloudflare and CNAME to your Workers domain:

| Scenario | Behavior | Route Pattern |
|----------|----------|---------------|
| Customer not on Cloudflare | Standard routing | `*/*` or `*.domain.com/*` |
| Customer on Cloudflare (proxied CNAME) | Invokes Worker at edge | `*/*` required |
| Customer on Cloudflare (DNS-only CNAME) | Standard routing | Any route works |

**Recommendation:** Always use `*/*` wildcard for consistent O2O behavior.

### Custom Metadata Routing

For Cloudflare for SaaS: Store worker name in custom hostname `custom_metadata`, retrieve in dispatch worker to route requests. Requires custom hostnames as subdomains of your domain.

## Observability

### Logpush
- Enable on dispatch Worker → captures all user Worker logs
- Filter by `Outcome` or `Script Name`

### Tail Workers
- Real-time logs with custom formatting
- Receives HTTP status, `console.log()`, exceptions, diagnostics

### Analytics Engine
```typescript
// Track violations
env.ANALYTICS.writeDataPoint({
  indexes: [customerName],
  blobs: ["cpu_limit_exceeded"],
});
```

### GraphQL
```graphql
query {
  viewer {
    accounts(filter: {accountTag: $accountId}) {
      workersInvocationsAdaptive(filter: {dispatchNamespaceName: "production"}) {
        sum { requests errors cpuTime }
      }
    }
  }
}
```

## Use Case Implementations

### AI Code Execution
```typescript
async function deployGeneratedCode(name: string, code: string) {
  const file = new File([code], `${name}.mjs`, { type: "application/javascript+module" });
  await client.workersForPlatforms.dispatch.namespaces.scripts.update("production", name, {
    account_id: accountId,
    metadata: { main_module: `${name}.mjs`, tags: [name, "ai-generated"] },
    files: [file],
  });
}

// Short limits for untrusted code
const userWorker = env.DISPATCHER.get(sessionId, {}, { limits: { cpuMs: 5, subRequests: 3 } });
```

**VibeSDK:** For AI-powered code generation + deployment platforms, see [VibeSDK](https://github.com/cloudflare/vibesdk) - handles AI generation, sandbox execution, live preview, and deployment.

Reference: [AI Vibe Coding Platform Architecture](https://developers.cloudflare.com/reference-architecture/diagrams/ai/ai-vibe-coding-platform/)

### Edge Functions Platform
```typescript
// Route: /customer-id/function-name
const [customerId, functionName] = new URL(request.url).pathname.split("/").filter(Boolean);
const workerName = `${customerId}-${functionName}`;
const userWorker = env.DISPATCHER.get(workerName);
```

### Website Builder
- Deploy static assets + Worker code
- See [api.md](./api.md#static-assets) for full implementation
- Salt hashes for asset isolation

## Best Practices

### Architecture
- One namespace per environment (production, staging)
- Platform logic in dispatch Worker (auth, rate limiting, validation)
- Isolation automatic (no shared cache, untrusted mode)

### Routing
- Use `*/*` wildcard routes
- Store mappings in KV
- Handle missing Workers gracefully

### Limits & Security
- Set custom limits by plan
- Track violations with Analytics Engine
- Use outbound Workers for egress control
- Sanitize responses

### Tags
- Tag all Workers: customer ID, plan, environment
- Enable bulk operations
- Filter efficiently

See [README.md](./README.md), [configuration.md](./configuration.md), [api.md](./api.md), [gotchas.md](./gotchas.md)
