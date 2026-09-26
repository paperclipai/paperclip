# Cloudflare Snippets Skill Reference

## Description
Expert guidance for **Cloudflare Snippets ONLY** - a lightweight JavaScript-based edge logic platform for modifying HTTP requests and responses. Snippets run as part of the Ruleset Engine and are included at no additional cost on paid plans (Pro, Business, Enterprise).

## What Are Snippets?
Snippets are JavaScript functions executed at the edge as part of Cloudflare's Ruleset Engine. Key characteristics:
- **Execution time**: 5ms CPU limit per request
- **Size limit**: 32KB per snippet
- **Runtime**: V8 isolate (subset of Workers APIs)
- **Subrequests**: 2-5 fetch calls depending on plan
- **Cost**: Included with Pro/Business/Enterprise plans

## Snippets vs Workers Decision Matrix

| Factor | Choose Snippets If... | Choose Workers If... |
|--------|----------------------|---------------------|
| **Complexity** | Simple request/response modifications | Complex business logic, routing, middleware |
| **Execution time** | <5ms sufficient | Need >5ms or variable time |
| **Subrequests** | 2-5 fetch calls sufficient | Need >5 subrequests or complex orchestration |
| **Code size** | <32KB sufficient | Need >32KB or npm dependencies |
| **Cost** | Want zero additional cost | Can afford $5/mo + usage |
| **APIs** | Need basic fetch, headers, URL | Need KV, D1, R2, Durable Objects, cron triggers |
| **Deployment** | Need rule-based triggers | Want custom routing logic |

**Rule of thumb**: Use Snippets for modifications, Workers for applications.

## Execution Model
1. Request arrives at Cloudflare edge
2. Ruleset Engine evaluates snippet rules (filter expressions)
3. If rule matches, snippet executes within 5ms limit
4. Modified request/response continues through pipeline
5. Response returned to client

Snippets execute synchronously in the request path - performance is critical.

## Reading Order
1. **[configuration.md](configuration.md)** - Start here: setup, deployment methods (Dashboard/API/Terraform)
2. **[api.md](api.md)** - Core APIs: Request, Response, headers, `request.cf` properties
3. **[patterns.md](patterns.md)** - Real-world examples: geo-routing, A/B tests, security headers
4. **[gotchas.md](gotchas.md)** - Troubleshooting: common errors, performance tips, API limitations

## In This Reference

- **[configuration.md](configuration.md)** - Setup, deployment, configuration
- **[api.md](api.md)** - API endpoints, methods, interfaces
- **[patterns.md](patterns.md)** - Common patterns, use cases, examples
- **[gotchas.md](gotchas.md)** - Troubleshooting, best practices, limitations

## Quick Start
```javascript
// Snippet: Add security headers
export default {
  async fetch(request) {
    const response = await fetch(request);
    const newResponse = new Response(response.body, response);
    newResponse.headers.set("X-Frame-Options", "DENY");
    newResponse.headers.set("X-Content-Type-Options", "nosniff");
    return newResponse;
  }
}
```

Deploy via Dashboard (Rules → Snippets) or API/Terraform. See configuration.md for details.

## See Also

- [Cloudflare Docs](https://developers.cloudflare.com/rules/snippets/)
