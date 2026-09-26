# Cloudflare Vectorize

Use Vectorize when you need to control embeddings, vector indexing, and retrieval for semantic search, recommendations, or RAG. For a managed retrieval pipeline, see [AI Search](../ai-search/README.md).

Fetch current documentation before implementing. Start with the [Vectorize documentation index](https://developers.cloudflare.com/vectorize/llms.txt) to discover pages; load only those relevant to the task. Treat the docs as the source of truth for APIs, configuration, models, limits, and pricing.

## Task routing

| Task | Read |
|------|------|
| Create an index and connect a Worker | [Configuration](configuration.md) and [Introduction to Vectorize](https://developers.cloudflare.com/vectorize/get-started/intro/) |
| Insert, update, query, retrieve, or delete vectors | [API routes](api.md) |
| Generate embeddings, build RAG, or partition tenant data | [Patterns](patterns.md) |
| Diagnose missing matches, metadata, or rejected requests | [Gotchas](gotchas.md) |

## Decisions to make first

- Use a consistent embedding model and preprocessing for stored vectors and queries. Matching dimensions alone does not make different models' embeddings compatible.
- Choose dimensions from the embedding output and a distance metric appropriate to that model. Changing either requires a new index; check [index configuration and scoring semantics](https://developers.cloudflare.com/vectorize/best-practices/create-indexes/) before choosing thresholds.
- Plan filterable metadata before ingestion. Adding an index later requires re-upserting existing vectors to index that metadata; see [metadata filtering](https://developers.cloudflare.com/vectorize/reference/metadata-filtering/).
- A namespace partitions search; your application must authorize access and derive tenant scope from trusted identity. See [tenant patterns](patterns.md).
- Design for asynchronous mutation visibility rather than assuming a completed write is already searchable. See [mutation semantics](https://developers.cloudflare.com/vectorize/reference/client-api/).
