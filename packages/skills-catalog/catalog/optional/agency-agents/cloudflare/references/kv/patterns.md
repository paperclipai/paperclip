# KV Patterns & Best Practices

Read the guide for the pattern before implementing it, and confirm that [KV's consistency model](https://developers.cloudflare.com/kv/concepts/how-kv-works/) fits the application.

| Task | Documentation and design decision |
|------|-----------------------------------|
| Cache application data or API results | [Cache data with KV](https://developers.cloudflare.com/kv/examples/cache-data-with-workers-kv/): decide acceptable staleness, expiration, and behavior when the origin fails. |
| Cache eligible HTTP responses | [Workers Cache](https://developers.cloudflare.com/workers/cache/): choose the HTTP caching mechanism based on response semantics. |
| Store configuration or feature flags | [Distributed configuration](https://developers.cloudflare.com/kv/examples/distributed-configuration-with-workers-kv/): choose defaults and rollout behavior that tolerate delayed updates. |
| Coalesce related keys | [Read guidance](https://developers.cloudflare.com/kv/api/read-key-value-pairs/): fewer reads can improve cache reuse, but combined values couple updates and can introduce write races. |
| Organize and enumerate keys by prefix | [List keys](https://developers.cloudflare.com/kv/api/list-keys/): use a consistent naming scheme and paginate every listing. |
| Attach schema versions or other metadata | [Write metadata](https://developers.cloudflare.com/kv/api/write-key-value-pairs/) and [read metadata](https://developers.cloudflare.com/kv/api/read-key-value-pairs/): define compatibility and migration behavior for older records; migrations must account for concurrent writes. |

## Application-specific decisions

The linked APIs are building blocks, not complete session or multi-tier cache implementations. Preserve these requirements when designing an application:

- For a memory → KV → origin cache, define each layer's lifetime and refill behavior. Process memory is not shared durable state; KV adds its own stale-value and negative-lookup caching.
- For sessions, decide how quickly creation, updates, and revocation must become visible. KV alone cannot provide immediate global revocation or guaranteed immediate reads after session creation. Use a store with suitable consistency when those are requirements, and define application expiration checks using the [write expiration guidance](https://developers.cloudflare.com/kv/api/write-key-value-pairs/).
- For counters, rate limits, or other atomic read-modify-write decisions, use coordination such as [Durable Objects](https://developers.cloudflare.com/durable-objects/). Serializing writes through an object does not make separate KV reads strongly consistent.
- Choose missing-data defaults separately from service-error handling. A fallback appropriate for display preferences may be inappropriate for authorization or session validation.
