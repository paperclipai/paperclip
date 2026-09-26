# Vectorize API routes

Fetch the relevant section of the [Workers binding API](https://developers.cloudflare.com/vectorize/reference/client-api/) before writing calls or types.

| Task | Current documentation |
|------|-----------------------|
| Vector shape, binding, and generated TypeScript types | [Vectorize API](https://developers.cloudflare.com/vectorize/reference/client-api/) |
| Insert, upsert, retrieve by ID, delete, or inspect an index | [Operations](https://developers.cloudflare.com/vectorize/reference/client-api/#operations) |
| Query by vector or ID; choose returned metadata, values, and scoring precision | [Query vectors](https://developers.cloudflare.com/vectorize/best-practices/query-vectors/) and [query options](https://developers.cloudflare.com/vectorize/reference/client-api/#query-vectors) |
| Filter by metadata, combine conditions, or use nested properties | [Metadata filtering](https://developers.cloudflare.com/vectorize/reference/metadata-filtering/) |
| Batch ingestion and select vector formats | [Insert vectors](https://developers.cloudflare.com/vectorize/best-practices/insert-vectors/) and [current limits](https://developers.cloudflare.com/vectorize/platform/limits/) |
| Manage indexes or vectors outside a Worker | [Wrangler commands](https://developers.cloudflare.com/vectorize/reference/wrangler-commands/) and [REST API](https://developers.cloudflare.com/api/resources/vectorize/subresources/indexes/methods/list/) |

## Operation choices

- Choose insert when existing IDs should be preserved; choose upsert when they should be replaced. Upsert replaces the whole vector, including metadata, so provide the complete intended record.
- Request only the values and metadata the caller needs. Indexed metadata can omit fields or truncate strings; full metadata and vector values change query limits and latency. Fetch the current query options before choosing a result count.
- Treat accepted mutations and query visibility as separate events. Use current mutation guidance when implementing ingestion verification or read-after-write behavior.
