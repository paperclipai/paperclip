# Cloudflare Workers Smart Placement

Automatic workload placement optimization to minimize latency by running Workers closer to backend infrastructure rather than end users.

## Core Concept

Smart Placement automatically analyzes Worker request duration across Cloudflare's global network and intelligently routes requests to optimal data center locations. Instead of defaulting to the location closest to the end user, Smart Placement can forward requests to locations closer to backend infrastructure when this reduces overall request duration.

### When to Use

**Enable Smart Placement when:**
- Worker makes multiple round trips to backend services/databases
- Backend infrastructure is geographically concentrated
- Request duration dominated by backend latency rather than network latency from user
- Running backend logic in Workers (APIs, data aggregation, SSR with DB calls)
- Worker uses `fetch` handler (not RPC methods)

**Do NOT enable for:**
- Workers serving only static content or cached responses
- Workers without significant backend communication
- Pure edge logic (auth checks, redirects, simple transformations)
- Workers without fetch event handlers
- Workers with RPC methods or named entrypoints (only `fetch` handlers are affected)
- Pages/Assets Workers with `run_worker_first = true` (degrades asset serving)

### Decision Tree

```
Does your Worker have a fetch handler?
├─ No → Smart Placement won't work (skip)
└─ Yes
   │
   Does it make multiple backend calls (DB/API)?
   ├─ No → Don't enable (won't help)
   └─ Yes
      │
      Is backend geographically concentrated?
      ├─ No (globally distributed) → Probably won't help
      └─ Yes or uncertain
         │
         Does it serve static assets with run_worker_first=true?
         ├─ Yes → Don't enable (will hurt performance)
         └─ No → Enable Smart Placement
            │
            After 15min, check placement_status
            ├─ SUCCESS → Monitor metrics
            ├─ INSUFFICIENT_INVOCATIONS → Need more traffic
            └─ UNSUPPORTED_APPLICATION → Disable (hurting performance)
```

### Key Architecture Pattern

**Recommended:** Split full-stack applications into separate Workers:
```
User → Frontend Worker (at edge, close to user)
         ↓ Service Binding
       Backend Worker (Smart Placement enabled, close to DB/API)
         ↓
       Database/Backend Service
```

This maintains fast, reactive frontends while optimizing backend latency.

## Quick Start

```jsonc
// wrangler.jsonc
{
  "placement": {
    "mode": "smart"  // or "off" to explicitly disable
  }
}
```

Deploy and wait 15 minutes for analysis. Check status via API or dashboard metrics.

**To disable:** Set `"mode": "off"` or remove `placement` field entirely (both equivalent).

## Requirements

- Wrangler 2.20.0+
- Analysis time: Up to 15 minutes after enabling
- Traffic requirements: Consistent traffic from multiple global locations
- Available on all Workers plans (Free, Paid, Enterprise)

## Placement Status Values

```typescript
type PlacementStatus = 
  | undefined  // Not yet analyzed
  | 'SUCCESS'  // Successfully optimized
  | 'INSUFFICIENT_INVOCATIONS'  // Not enough traffic
  | 'UNSUPPORTED_APPLICATION';  // Made Worker slower (reverted)
```

## CLI Commands

```bash
# Deploy with Smart Placement
wrangler deploy

# Check placement status
curl -H "Authorization: Bearer $TOKEN" \
  https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/services/$WORKER_NAME \
  | jq .result.placement_status

# Monitor
wrangler tail your-worker-name --header cf-placement
```

## Reading Order

**First time?** Start here:
1. This README - understand core concepts and when to use Smart Placement
2. [configuration.md](./configuration.md) - set up wrangler.jsonc and understand limitations
3. [patterns.md](./patterns.md) - see practical examples for your use case
4. [api.md](./api.md) - monitor and verify Smart Placement is working
5. [gotchas.md](./gotchas.md) - troubleshoot common issues

**Quick lookup:**
- "Should I enable Smart Placement?" → See "When to Use" above
- "How do I configure it?" → [configuration.md](./configuration.md)
- "How do I split frontend/backend?" → [patterns.md](./patterns.md)
- "Why isn't it working?" → [gotchas.md](./gotchas.md)

## In This Reference

- [configuration.md](./configuration.md) - wrangler.jsonc setup, mode values, validation rules
- [api.md](./api.md) - Placement Status API, cf-placement header, monitoring
- [patterns.md](./patterns.md) - Frontend/backend split, database workers, SSR patterns
- [gotchas.md](./gotchas.md) - Troubleshooting INSUFFICIENT_INVOCATIONS, performance issues

## See Also

- [workers](https://developers.cloudflare.com/workers/) - Worker runtime and fetch handlers
- [d1](../d1/) - D1 database that benefits from Smart Placement
- [durable-objects](https://developers.cloudflare.com/durable-objects/) - Durable Objects with backend logic
- [bindings](../bindings/) - Service bindings for frontend/backend split
