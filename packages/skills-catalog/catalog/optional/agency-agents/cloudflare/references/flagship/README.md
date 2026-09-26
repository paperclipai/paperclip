# Cloudflare Flagship

Feature flag service for controlling feature visibility without redeploying code. Define flags with targeting rules and percentage-based rollouts, then evaluate them in Workers via a native binding or from any JavaScript runtime via the OpenFeature SDK.

## When to Use

| Need | Use Flagship? | Alternative |
|------|--------------|-------------|
| Feature toggles (on/off) | Yes | — |
| Gradual rollouts (percentage-based) | Yes | — |
| A/B testing with attribute targeting | Yes | — |
| Multi-variant configuration delivery | Yes | — |
| Environment-specific config (dev/staging/prod) | Consider | Wrangler environments, secrets |
| Static config that never changes | No | `wrangler.jsonc` vars |
| Per-request rate limiting | No | Rate Limiting rules |

## Key Concepts

- **Apps** — Top-level organizational unit. Maps to a project or service. Each account can have multiple apps.
- **Flags** — Named feature toggles with a key, variations, targeting rules, and enabled/disabled state.
- **Variations** — Possible values a flag returns. Types: boolean, string, number, JSON object. All variations on a flag must share the same type.
- **Targeting rules** — Sequential, priority-ordered conditions that determine which variation to serve. First match wins; no match returns the default.
- **Evaluation context** — Key-value attributes (`userId`, `country`, `plan`, etc.) passed at evaluation time for rule matching and rollout bucketing.
- **Percentage rollouts** — Gradually release to a fraction of users. Consistent hashing on a configurable attribute ensures sticky bucketing.

## Two Evaluation Paths

| Path | Runtime | Package | Latency | Auth |
|------|---------|---------|---------|------|
| **Binding** (`env.FLAGS`) | Workers only | `@cloudflare/workers-types` | Lowest (no HTTP) | Automatic via binding |
| **OpenFeature SDK** | Workers, Node.js, browser | `@cloudflare/flagship` + `@openfeature/server-sdk` or `@openfeature/web-sdk` | HTTP per eval (server) or prefetch (client) | API token or binding passthrough |

**Recommendation:** Use the binding inside Workers. Use the SDK when running outside Workers or when you need OpenFeature vendor-neutrality.

## Reading Order

| Task | Read |
|------|------|
| Set up Flagship in a Worker | `configuration.md` → `api.md` |
| Evaluate flags in code | `configuration.md` → `patterns.md` |
| Manage flags via REST API | `api.md` → `patterns.md` |
| Design targeting rules & rollouts | `patterns.md` → `gotchas.md` |
| Debug flag evaluation issues | `gotchas.md` → `api.md` |

REST API note: management endpoints use Cloudflare v4 envelopes (`result`, `result_info`, `errors`) and snake_case fields. The `/evaluate` endpoint is the exception: it is not enveloped and returns OpenFeature-style camelCase.

## In This Reference

- **[api.md](./api.md)** — REST API endpoints, binding methods, OpenFeature SDK, schemas
- **[configuration.md](./configuration.md)** — Wrangler binding setup, SDK installation, TypeScript types
- **[patterns.md](./patterns.md)** — Flag CRUD via API, targeting rules, rollouts, OpenFeature usage
- **[gotchas.md](./gotchas.md)** — Common errors, limits, anti-patterns, troubleshooting

## See Also

- **[Flagship API reference](https://developers.cloudflare.com/api/resources/flagship/)** — Source of truth for REST API paths, envelopes, and response fields
- **[Workers docs](https://developers.cloudflare.com/workers/)** — Workers runtime (Flagship runs inside Workers)
- **[../kv/](../kv/)** — KV storage (Flagship uses KV infrastructure for flag delivery)
- **[Wrangler docs](https://developers.cloudflare.com/workers/wrangler/)** — Wrangler CLI for deployment and config
