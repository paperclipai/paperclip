# KV API Reference

Read the relevant API page before implementing; it defines current options, result shapes, supported bulk operations, and constraints.

| Task | Documentation |
|------|---------------|
| Read one or several keys; choose text, JSON, binary, or stream results | [Read key-value pairs](https://developers.cloudflare.com/kv/api/read-key-value-pairs/) |
| Read metadata with values; tune read caching or coalesce related keys | [Read guidance](https://developers.cloudflare.com/kv/api/read-key-value-pairs/) |
| Write values and metadata; set absolute expiration or a relative lifetime | [Write key-value pairs](https://developers.cloudflare.com/kv/api/write-key-value-pairs/) |
| Delete a key | [Delete key-value pairs](https://developers.cloudflare.com/kv/api/delete-key-value-pairs/) |
| Enumerate keys, filter by prefix, and paginate | [List keys](https://developers.cloudflare.com/kv/api/list-keys/) |
| Access namespaces or perform bulk operations outside a Worker | [KV REST API](https://developers.cloudflare.com/api/resources/kv/) and [Wrangler KV commands](https://developers.cloudflare.com/kv/reference/kv-commands/) |

Handle missing values explicitly: JavaScript reads return `null` for absent keys; valid stored values can be falsy. Choose defaults separately from how you handle request failures.

For pagination, follow the returned cursor until `list_complete` is true, even if a page has no keys. Preserve the original prefix on subsequent calls. Listing returns key information, not stored values; use the listing guide to decide whether metadata avoids additional reads.

Use [gotchas.md](./gotchas.md) for consistency and contention decisions before adding retries or read-after-write verification.
