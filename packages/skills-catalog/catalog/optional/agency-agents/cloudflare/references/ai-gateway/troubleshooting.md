# AI Gateway Troubleshooting

Identify the request path and whether the failure comes from gateway access, upstream provider authentication, or request policy before changing credentials or retry behavior. A status code alone does not establish the failing layer.

| Symptom or task | Current documentation |
|-----------------|-----------------------|
| Authentication or provider errors, timeouts, DLP failures, or unexpected cache behavior | [Troubleshooting](https://developers.cloudflare.com/ai-gateway/reference/troubleshooting/) |
| Gateway authentication failure | [Authenticated Gateway](https://developers.cloudflare.com/ai-gateway/configuration/authentication/) and [REST API authentication](https://developers.cloudflare.com/ai-gateway/usage/rest-api/#authentication) |
| Provider key or billing mismatch | [BYOK](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/), [Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/), and the [provider guide](https://developers.cloudflare.com/ai-gateway/usage/providers/) |
| Rate limits or repeated failures | [Rate limiting](https://developers.cloudflare.com/ai-gateway/features/rate-limiting/) and [request handling](https://developers.cloudflare.com/ai-gateway/configuration/request-handling/) |
| Unexpected cache hit or miss, including streaming behavior | [Caching](https://developers.cloudflare.com/ai-gateway/features/caching/) |
| Missing logs, collection overrides, or storage limits | [Logging](https://developers.cloudflare.com/ai-gateway/observability/logging/) and [limits](https://developers.cloudflare.com/ai-gateway/reference/limits/) |
| Inspect headers, request metadata, usage, or export logs | [Header glossary](https://developers.cloudflare.com/ai-gateway/glossary/), [custom metadata](https://developers.cloudflare.com/ai-gateway/observability/custom-metadata/), [analytics](https://developers.cloudflare.com/ai-gateway/observability/analytics/), and [Logpush](https://developers.cloudflare.com/ai-gateway/observability/logging/logpush/) |
| Dynamic route failure | [Dynamic route usage](https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/usage/) |

Check the existing SDK and gateway retry settings together before adding another retry loop. Follow [SDK integration](./sdk-integration.md) when an endpoint or model format is suspect.
