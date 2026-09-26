# Cloudflare Workers AI

Use Workers AI for managed model inference from Workers or an external service. Fetch the relevant documentation before choosing a model or writing integration code; model availability, schemas, capabilities, limits, and prices change independently.

## Choose a model

Start with the [model catalog](https://developers.cloudflare.com/workers-ai/models/) and open the selected model's page for its exact identifier, input/output schema, context window, and supported features. Compare candidates on the user's task, language, quality requirements, latency, and [current pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/). Evaluate with representative inputs rather than treating model size as a quality or cost ranking.

For tool use, streaming, or structured output, confirm support for the selected model and integration. For embeddings, check output dimensions and compatibility with the existing index; changing the model may require re-embedding stored documents, even if dimensions match.

## Route by task

- [configuration.md](./configuration.md): choose an integration, configure bindings and types, or set up development.
- [api.md](./api.md): find inference schemas, streaming, tool calling, and structured output.
- [patterns.md](./patterns.md): choose direct generation or RAG, and find integration examples.
- [gotchas.md](./gotchas.md): diagnose binding, schema, limit, pricing, and SDK issues.

If a topic is missing, use the [Workers AI documentation index](https://developers.cloudflare.com/workers-ai/llms.txt) to find its current page.

## Related products

- [Vectorize](../vectorize/): vector storage and retrieval.
- [AI Gateway](../ai-gateway/): inference analytics, caching, and request controls.
- [Workers](https://developers.cloudflare.com/workers/): runtime and application hosting.
