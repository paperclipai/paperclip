# Smart Placement Patterns

## Backend Worker with Database Access

```typescript
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const user = await env.DATABASE.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();
    const orders = await env.DATABASE.prepare('SELECT * FROM orders WHERE user_id = ?').bind(userId).all();
    return Response.json({ user, orders });
  }
};
```

```jsonc
{ "placement": { "mode": "smart" }, "d1_databases": [{ "binding": "DATABASE", "database_id": "xxx" }] }
```

## Frontend + Backend Split (Service Bindings)

**Frontend:** Runs at edge for fast user response
**Backend:** Smart Placement runs close to database

```typescript
// Frontend Worker - routes requests to backend
interface Env {
  BACKEND: Fetcher;  // Service Binding to backend Worker
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname.startsWith('/api/')) {
      return env.BACKEND.fetch(request);  // Forward to backend
    }
    return new Response('Frontend content');
  }
};

// Backend Worker - database operations
interface BackendEnv {
  DATABASE: D1Database;
}

export default {
  async fetch(request: Request, env: BackendEnv): Promise<Response> {
    const data = await env.DATABASE.prepare('SELECT * FROM table').all();
    return Response.json(data);
  }
};
```

**CRITICAL:** Use fetch-based Service Bindings (shown above). If using RPC with `WorkerEntrypoint`, Smart Placement will NOT optimize those method calls - only `fetch` handlers are affected.

**RPC vs Fetch - CRITICAL:** Smart Placement ONLY works with fetch-based bindings, NOT RPC.

```typescript
// ❌ RPC - Smart Placement has NO EFFECT on backend RPC methods
export class BackendRPC extends WorkerEntrypoint {
  async getData() {
    // ALWAYS runs at edge, Smart Placement ignored
    return await this.env.DATABASE.prepare('SELECT * FROM table').all();
  }
}

// ✅ Fetch - Smart Placement WORKS
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Runs close to DATABASE when Smart Placement enabled
    const data = await env.DATABASE.prepare('SELECT * FROM table').all();
    return Response.json(data);
  }
};
```

## External API Integration

```typescript
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const apiUrl = 'https://api.partner.com';
    const headers = { 'Authorization': `Bearer ${env.API_KEY}` };
    
    const [profile, transactions] = await Promise.all([
      fetch(`${apiUrl}/profile`, { headers }),
      fetch(`${apiUrl}/transactions`, { headers })
    ]);
    
    return Response.json({ 
      profile: await profile.json(), 
      transactions: await transactions.json()
    });
  }
};
```

## SSR / API Gateway Pattern

```typescript
// Frontend (edge) - auth/routing close to user
export default {
  async fetch(request: Request, env: Env) {
    if (!request.headers.get('Authorization')) {
      return new Response('Unauthorized', { status: 401 });
    }
    const data = await env.BACKEND.fetch(request);
    return new Response(renderPage(await data.json()), { 
      headers: { 'Content-Type': 'text/html' } 
    });
  }
};

// Backend (Smart Placement) - DB operations close to data
export default {
  async fetch(request: Request, env: Env) {
    const data = await env.DATABASE.prepare('SELECT * FROM pages WHERE id = ?').bind(pageId).first();
    return Response.json(data);
  }
};
```

## Durable Objects with Smart Placement

**Key principle:** Smart Placement does NOT control WHERE Durable Objects run. DOs always run in their designated region (based on jurisdiction or smart location hints).

**What Smart Placement DOES affect:** The location of the coordinator Worker's `fetch` handler that makes calls to multiple DOs.

**Pattern:** Enable Smart Placement on coordinator Worker that aggregates data from multiple DOs:

```typescript
// Worker with Smart Placement - aggregates data from multiple DOs
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const userId = new URL(request.url).searchParams.get('user');
    
    // Get DO stubs
    const userDO = env.USER_DO.get(env.USER_DO.idFromName(userId));
    const analyticsID = env.ANALYTICS_DO.idFromName(`analytics-${userId}`);
    const analyticsDO = env.ANALYTICS_DO.get(analyticsID);
    
    // Fetch from multiple DOs
    const [userData, analyticsData] = await Promise.all([
      userDO.fetch(new Request('https://do/profile')),
      analyticsDO.fetch(new Request('https://do/stats'))
    ]);
    
    return Response.json({
      user: await userData.json(),
      analytics: await analyticsData.json()
    });
  }
};
```

```jsonc
// wrangler.jsonc
{
  "placement": { "mode": "smart" },
  "durable_objects": {
    "bindings": [
      { "name": "USER_DO", "class_name": "UserDO" },
      { "name": "ANALYTICS_DO", "class_name": "AnalyticsDO" }
    ]
  }
}
```

**When this helps:** 
- Worker's `fetch` handler runs closer to DO regions, reducing network latency for multiple DO calls
- Most beneficial when DOs are geographically concentrated or in specific jurisdictions
- Helps when coordinator makes many sequential or parallel DO calls

**When this DOESN'T help:**
- DOs are globally distributed (no single optimal Worker location)
- Worker only calls a single DO
- DO calls are infrequent or cached

## Best Practices

- Split full-stack apps: frontend at edge, backend with Smart Placement
- Use fetch-based Service Bindings (not RPC)
- Enable for backend logic: APIs, data aggregation, DB operations
- Don't enable for: static content, edge logic, RPC methods, Pages with `run_worker_first`
- Wait 15+ min for analysis, verify `placement_status = SUCCESS`
