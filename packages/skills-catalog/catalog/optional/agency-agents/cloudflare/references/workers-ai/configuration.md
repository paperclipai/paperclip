# Workers AI Configuration

Read the setup guide for the application's existing integration and installed SDK/Wrangler versions before adapting configuration.

| Task | Documentation |
|------|---------------|
| Create and develop a Worker with Workers AI | [Workers and Wrangler setup](https://developers.cloudflare.com/workers-ai/get-started/workers-wrangler/) |
| Add an AI binding to an existing Worker | [Workers bindings](https://developers.cloudflare.com/workers-ai/configuration/bindings/) |
| Generate environment and runtime types | [Workers TypeScript](https://developers.cloudflare.com/workers/languages/typescript/) |
| Call inference from outside Workers | [REST API setup and authentication](https://developers.cloudflare.com/workers-ai/get-started/rest-api/) |
| Use the Vercel AI SDK | [AI SDK integration](https://developers.cloudflare.com/workers-ai/configuration/ai-sdk/) |
| Adapt an existing OpenAI SDK client | [OpenAI compatible endpoints](https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/) |

Prefer the native binding for a Worker that does not need an SDK abstraction; use REST for external services. Preserve an existing SDK integration when it meets the task, and check its supported endpoints and model features before substituting providers.

Local Worker execution and local inference are different: Workers AI inference uses the Cloudflare account even during local development and consumes usage. Follow the current setup guide for development configuration; do not assume the entire Worker must run remotely.
