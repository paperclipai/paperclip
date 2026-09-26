# KV Gotchas & Troubleshooting

Read the linked explanation before applying a workaround.

| Symptom or decision | Documentation and guidance |
|---------------------|----------------------------|
| Stale value after a write or delete | [How KV works](https://developers.cloudflare.com/kv/concepts/how-kv-works/): allow for eventual consistency; neither local read-after-write visibility nor a fixed global propagation deadline is guaranteed. |
| Newly created key still appears absent | [Read caching](https://developers.cloudflare.com/kv/api/read-key-value-pairs/): missing-key lookups are cached too. Treat check-then-create as a race, not an atomic existence test. |
| Concurrent updates overwrite each other or writes are throttled | [Concurrent writes](https://developers.cloudflare.com/kv/api/write-key-value-pairs/#concurrent-writes-to-the-same-key): retries do not make read-modify-write atomic. Use coordination when correctness depends on ordering. |
| Missing-value errors | [Read results](https://developers.cloudflare.com/kv/api/read-key-value-pairs/): distinguish `null` from valid falsy values and distinguish absence from an operation failure. |
| Slow reads, large results, or excessive operations | [Read guidance](https://developers.cloudflare.com/kv/api/read-key-value-pairs/): select result types and bulk reads to match the workload; increasing read cache lifetime trades freshness for cache reuse. |
| Unexpected empty listing page | [Pagination](https://developers.cloudflare.com/kv/api/list-keys/): use the completion flag and cursor, not page length, to determine whether to continue. |
| Data present in one environment but missing in another | [KV bindings](https://developers.cloudflare.com/kv/concepts/kv-bindings/) and [environments](https://developers.cloudflare.com/kv/reference/environments/): check local versus remote storage and the selected namespace. |
| Size, operation, or write-rate failures | [Limits](https://developers.cloudflare.com/kv/platform/limits/): retrieve current constraints before sizing values, batches, or retry policies. |
| Estimate costs or explain billing | [Pricing](https://developers.cloudflare.com/kv/platform/pricing/): check allowances, billable operations, storage, and bulk accounting for the actual workload. |

Confirm freshness and failure requirements before adding a cache or a permissive fallback; see [patterns.md](./patterns.md).
