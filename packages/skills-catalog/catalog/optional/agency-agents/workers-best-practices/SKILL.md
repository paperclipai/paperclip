---
name: "workers-best-practices"
description: "Cloudflare Workers best practices for production applications. Use when writing, reviewing, or configuring Workers."
key: "paperclipai/optional/agency-agents/workers-best-practices"
recommendedForRoles:
  - "engineer"
  - "product"
tags:
  - "agency-agents"
  - "engineer"
  - "product"
  - "workers"
  - "best"
  - "practices"
defaultInstall: false
---
Your knowledge of Cloudflare Workers APIs, types, and configuration may be outdated. **Prefer retrieval over pre-training** when writing or reviewing Workers code.

Use the project's installed versions, generated types, and Wrangler compatibility settings as the baseline for existing code. Retrieve relevant Cloudflare documentation to verify API, configuration, runtime behavior, and limit claims.

## References

Read the sections relevant to the task:

| Reference | When to use it |
|-----------|----------------|
| [Configuration and observability](references/configuration.md) | Compatibility dates, bindings, generated types, secrets, logs, and traces |
| [Runtime patterns](references/runtime-patterns.md) | Streaming, promise lifetime, request state, service calls, security, and runtime tests |
| [Platform API checks](references/platform-apis.md) | Handler signatures, platform classes, binding access, and serialization |

For missing evidence, consult [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/) or find the affected product in the [Cloudflare docs directory](https://developers.cloudflare.com/directory/). Use the installed Wrangler schema for config fields. A newer type package does not supersede the project's configured target.

## Keep Compatibility Dates Current

Use today's date for new Workers. Encourage periodic updates for existing Workers, reviewing compatibility changes and running relevant tests. Assess existing behavior against its configured date and flags; see [compatibility guidance](references/configuration.md#keep-compatibility_date-current).

## Enable Observability

Enable [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) and [Traces](https://developers.cloudflare.com/workers/observability/traces/) when creating or preparing a Worker for production. Set `observability.enabled` and `observability.traces.enabled` to `true`; the top-level setting alone does not enable traces. Use structured JSON logging and configure sampling for the workload. During reviews, flag missing logs or traces. See the [configuration example](references/configuration.md#enable-workers-logs-and-traces).

## Anti-Patterns to Flag

| Anti-pattern | Consequence and preferred pattern |
|-------------|-----------------------------------|
| `await response.text()` or similar buffering on unbounded data | Can exhaust Worker memory; [stream large or unbounded bodies](references/runtime-patterns.md#stream-request-and-response-bodies). |
| Hardcoded secrets in source or config | Leaks credentials through version control; use Wrangler secrets. |
| `Math.random()` for security-sensitive tokens or IDs | Predictable values; use `crypto.randomUUID()` or `crypto.getRandomValues()`. |
| Async work started without awaiting, returning, or attaching it to `ctx.waitUntil()` | Work can be dropped and errors missed; tie it to the request or background-work lifetime. |
| Module-level mutable request state | Leaks data across requests and can cause I/O ownership errors; pass request state explicitly. |
| Cloudflare REST API calls for operations available through Worker bindings | Adds network and authentication overhead; use the available binding. |
| `ctx.passThroughOnException()` used as general error handling | Can conceal Worker failures by forwarding to the origin; use explicit error handling and structured error responses. |
| Hand-written `Env` that duplicates Wrangler bindings | Can drift from configuration; generate binding types with `wrangler types`. |
| Direct string comparison of secret values | Can expose timing differences; use the [Web Crypto comparison pattern](references/runtime-patterns.md#use-web-crypto-for-secure-token-generation). |
| Destructuring `ctx` methods, such as `const { waitUntil } = ctx` | Loses the receiver; call `ctx.waitUntil(...)`. |
| `any` on `Env` or handler parameters | Hides binding and handler contract errors; use the project's generated and platform types. |
| `as unknown as T` to force a platform type match | Hides incompatibilities; fix the underlying contract. |
| `implements` used in place of extending a platform base class | Does not inherit runtime behavior, `this.ctx`, or `this.env`; use the appropriate base class. |
| Unbound `env.X` in a platform class method | Bindings are available through `this.env.X`; see [binding access patterns](references/platform-apis.md#binding-access--the-most-common-error). |
| Applying one serialization rule across Queues, Workflow steps, storage, and WebSockets | Can reject valid payloads or accept unsupported ones; check the [specific API and encoding](references/platform-apis.md#serialization-boundaries). |

## Validation

Use the project's existing checks for affected Workers behavior: type-check binding or handler contract changes, and run relevant runtime tests for behavior changes. Preserve required repository checks; a narrow edit does not require a full Workers audit.

## Scope

This skill covers Workers-specific best practices and code review. For related topics:

- **Durable Objects**: load the `durable-objects` skill
- **Workflows**: see [Rules of Workflows](https://developers.cloudflare.com/workflows/build/rules-of-workflows/)
- **Wrangler CLI commands**: load the `wrangler` skill
