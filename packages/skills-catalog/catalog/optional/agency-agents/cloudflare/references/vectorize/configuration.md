# Vectorize configuration routes

| Task | Current documentation |
|------|-----------------------|
| Create an index, choose dimensions and metric | [Create indexes](https://developers.cloudflare.com/vectorize/best-practices/create-indexes/) |
| Bind an index to a Worker, develop, deploy, and verify queries | [Introduction to Vectorize](https://developers.cloudflare.com/vectorize/get-started/intro/) |
| Configure bindings and generate types | [Binding and TypeScript guidance](https://developers.cloudflare.com/vectorize/reference/client-api/#binding-to-a-worker) |
| Create, list, or delete metadata indexes | [Metadata filtering](https://developers.cloudflare.com/vectorize/reference/metadata-filtering/) and [Wrangler commands](https://developers.cloudflare.com/vectorize/reference/wrangler-commands/) |
| Manage indexes and vectors through the CLI | [Wrangler commands](https://developers.cloudflare.com/vectorize/reference/wrangler-commands/) |
| Upload NDJSON and batch ingestion | [Insert vectors](https://developers.cloudflare.com/vectorize/best-practices/insert-vectors/) |
| Check capacity, payload, namespace, or batch constraints | [Limits](https://developers.cloudflare.com/vectorize/platform/limits/) |

## Configuration decisions

Confirm the embedding model, output dimensions, and distance metric before provisioning: dimensions and metric cannot be changed in place. Plan a new index and re-embedding where needed when changing models.

Create metadata indexes before ingesting vectors that must be filterable. If adding one to an existing dataset, plan to re-upsert the affected vectors after index creation.

Choose metadata granularity around actual queries. For range filters over high-cardinality fields, consider buckets that preserve the application's required precision; do not bucket identifiers used for exact matches. Fetch the [cardinality guidance](https://developers.cloudflare.com/vectorize/best-practices/insert-vectors/#performance-tips-when-filtering-by-metadata) before designing the schema.
