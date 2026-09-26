# Workers AI Patterns

Use direct generation when the supplied context fits the selected model and retrieval is unnecessary. Use RAG when answers need grounding in a document corpus or relevant passages must be selected from larger data; decide from the actual model context budget rather than a fixed token threshold.

| Task | Documentation |
|------|---------------|
| Build retrieval with Workers AI, Vectorize, and document storage | [RAG tutorial](https://developers.cloudflare.com/workers-ai/guides/tutorials/build-a-retrieval-augmented-generation-ai/) |
| Stream responses or integrate tool calling in an SDK application | [AI SDK integration](https://developers.cloudflare.com/workers-ai/configuration/ai-sdk/) |
| Constrain generated JSON | [JSON mode](https://developers.cloudflare.com/workers-ai/features/json-mode/) |
| Add caching, retries, or model fallbacks | [Caching](https://developers.cloudflare.com/ai-gateway/features/caching/), [request handling](https://developers.cloudflare.com/ai-gateway/configuration/request-handling/), and [dynamic routing](https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/) |

Treat tutorial models as examples; select models using the [model criteria](./README.md#choose-a-model). For RAG, embed queries and documents with compatible models and match the index dimensions to the embeddings. Budget for retrieval and embedding work as well as generation.

Before adding a fallback model, verify that it can satisfy the same schema, context, and tool requirements. For retry decisions, distinguish transient failures from invalid inputs or configuration using the [error and limit references](./gotchas.md).
