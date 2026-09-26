# Cloudflare AI Search

Use AI Search for managed content indexing and retrieval, with optional answer generation. Start with [How AI Search works](https://developers.cloudflare.com/ai-search/concepts/how-ai-search-works/).

## Choose the right product

- **Managed search or RAG over your content:** AI Search.
- **Custom embeddings and vector-index management:** [Vectorize](../vectorize/README.md).
- **Model inference without a managed retrieval pipeline:** [Workers AI](../workers-ai/README.md).

For freshness requirements, read [Syncing](https://developers.cloudflare.com/ai-search/configuration/indexing/syncing/) for your data source before choosing an architecture. Use the current [limits and pricing](https://developers.cloudflare.com/ai-search/platform/limits-pricing/) instead of assuming a fixed indexing interval or account limit.

## Find the right documentation

Read the linked page before implementing; these references route to the maintained documentation instead of copying API examples or configuration.

| Task | Start here |
|------|------------|
| Build a new Worker integration | [Workers binding quick start](https://developers.cloudflare.com/ai-search/get-started/workers/) |
| Choose an API or maintain an existing integration | [API routes](api.md) |
| Connect data, configure indexing, or manage environments | [Configuration routes](configuration.md) |
| Choose retrieval, generation, or tenant isolation patterns | [Pattern routes](patterns.md) |
| Diagnose indexing, authentication, filters, or limits | [Troubleshooting routes](gotchas.md) |

Existing `env.AI.autorag()` integrations can continue to work. Use the [migration guide](https://developers.cloudflare.com/ai-search/api/migration/workers-binding/) when upgrading; migration is not required just to maintain an existing integration.
