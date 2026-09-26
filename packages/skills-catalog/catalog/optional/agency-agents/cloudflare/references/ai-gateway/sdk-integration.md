# AI Gateway SDK Integration

Choose an integration that matches the application's runtime and required API shape. Fetch its guide before installing packages or writing requests; model identifiers, SDK options, and gateway headers belong in the docs.

| Integration task | Current documentation |
|------------------|-----------------------|
| New single-model HTTP calls or OpenAI-compatible clients | [REST API](https://developers.cloudflare.com/ai-gateway/usage/rest-api/) |
| Vercel AI SDK, provider adapters, and fallback providers | [Vercel AI SDK integration](https://developers.cloudflare.com/ai-gateway/integrations/vercel-ai-sdk/) |
| Preserve OpenAI-native endpoints with the OpenAI SDK, Python, or HTTP | [OpenAI provider guide](https://developers.cloudflare.com/ai-gateway/usage/providers/openai/) |
| Preserve Anthropic-native requests | [Anthropic provider guide](https://developers.cloudflare.com/ai-gateway/usage/providers/anthropic/) |
| Use another provider or a framework's configurable provider endpoint | [Provider guides](https://developers.cloudflare.com/ai-gateway/usage/providers/) — match the framework's expected API shape to the provider endpoint |
| Configure Workers AI and an AI binding | [Binding setup](https://developers.cloudflare.com/ai-gateway/integrations/aig-workers-ai-binding/) |
| Call Workers AI or third-party models from a Worker; use gateway methods | [Workers binding methods](https://developers.cloudflare.com/ai-gateway/usage/worker-binding-methods/) |
| Set request metadata, caching, or other gateway headers | [Header glossary](https://developers.cloudflare.com/ai-gateway/glossary/) |
| Invoke a dynamic route | [Dynamic route usage](https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/usage/) |

The [legacy Unified API](https://developers.cloudflare.com/ai-gateway/usage/chat-completion/) is deprecated for single-model calls, but dynamic routes still require its compatibility endpoint. Do not migrate a dynamic route to the REST inference endpoint as though it were a single-model call.

Confirm [gateway authentication and provider credentials](./configuration.md) separately, including the selected path's BYOK and billing behavior.
