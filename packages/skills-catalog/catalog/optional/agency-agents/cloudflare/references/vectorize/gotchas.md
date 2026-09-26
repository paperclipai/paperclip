# Vectorize troubleshooting routes

Fetch current documentation before diagnosing a numeric limit, API error, or delayed mutation. Do not infer batch sizes or result limits from old snippets.

| Symptom or decision | What to check | Current documentation |
|---------------------|---------------|-----------------------|
| A write succeeded but search has not changed | Mutations are asynchronous; acceptance does not guarantee query visibility | [Insert, upsert, and delete semantics](https://developers.cloudflare.com/vectorize/reference/client-api/#operations) |
| Ingestion is slow or a batch is rejected | Batch size depends on the interface; inspect throughput and payload constraints | [Write throughput](https://developers.cloudflare.com/vectorize/best-practices/insert-vectors/#improve-write-throughput) and [limits](https://developers.cloudflare.com/vectorize/platform/limits/) |
| Query count is rejected or metadata is incomplete | Returned values and metadata affect query limits; indexed metadata can be truncated | [Query options](https://developers.cloudflare.com/vectorize/reference/client-api/#query-vectors) |
| Metadata filters return no matches | Confirm field type, operators, nesting, and index creation; re-upsert data written before the metadata index existed | [Metadata filtering](https://developers.cloudflare.com/vectorize/reference/metadata-filtering/) |
| Query has no matches or poor relevance | Check embedding model and dimensions, metric, namespace, filters, and mutation visibility | [Query vectors](https://developers.cloudflare.com/vectorize/best-practices/query-vectors/) and [index configuration](https://developers.cloudflare.com/vectorize/best-practices/create-indexes/) |
| Existing IDs or metadata behave unexpectedly on update | Insert preserves existing IDs; upsert replaces the full vector and metadata | [Mutation semantics](https://developers.cloudflare.com/vectorize/reference/client-api/#operations) |
| Capacity or model output no longer fits | Check current limits and model output dimensions; changing dimensions or metric requires another index | [Limits](https://developers.cloudflare.com/vectorize/platform/limits/) and [create indexes](https://developers.cloudflare.com/vectorize/best-practices/create-indexes/) |

For changes to embedding providers or tenant boundaries, also read [pattern decisions](patterns.md).
