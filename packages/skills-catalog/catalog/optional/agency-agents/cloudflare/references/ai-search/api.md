# AI Search API Routes

Choose documentation that matches the integration you are working on. Fetch the reference before writing binding configuration, request types, response parsing, or streaming code.

| Task | Documentation |
|------|---------------|
| New Worker integration: bindings, search, chat completions, and streaming | [Search Workers binding](https://developers.cloudflare.com/ai-search/api/search/workers-binding/) |
| Create, list, configure, and inspect instances | [Instances Workers binding](https://developers.cloudflare.com/ai-search/api/instances/workers-binding/) |
| Query over HTTP and configure request authentication | [Search REST API](https://developers.cloudflare.com/ai-search/api/search/rest-api/) |
| Maintain an existing `env.AI.autorag()` integration | [Legacy Workers binding](https://developers.cloudflare.com/ai-search/api/migration/workers-binding-legacy/) |
| Upgrade a legacy binding, including responses, streaming, and filters | [Workers binding migration](https://developers.cloudflare.com/ai-search/api/migration/workers-binding/) |

The legacy binding remains supported; use current bindings for new integrations. Keep legacy request and response handling together until deliberately migrating them.
