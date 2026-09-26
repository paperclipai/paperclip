# AI Gateway Features

Fetch the relevant guide before setting feature flags, headers, limits, or billing behavior.

| Task | Current documentation |
|------|-----------------------|
| Enable caching, set TTLs, bypass the cache, or choose a custom cache key | [Caching](https://developers.cloudflare.com/ai-gateway/features/caching/) |
| Control request volume with fixed or sliding limits | [Rate limiting](https://developers.cloudflare.com/ai-gateway/features/rate-limiting/) |
| Enforce cost budgets | [Spend limits](https://developers.cloudflare.com/ai-gateway/features/spend-limits/) |
| Evaluate and enforce content policies | [Guardrails setup](https://developers.cloudflare.com/ai-gateway/features/guardrails/set-up-guardrail/) and [usage considerations](https://developers.cloudflare.com/ai-gateway/features/guardrails/usage-considerations/) |
| Detect sensitive data in prompts and responses | [DLP setup](https://developers.cloudflare.com/ai-gateway/features/dlp/set-up-dlp/) |
| Choose provider keys or Cloudflare billing | [BYOK](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/) and [Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/) |
| Configure provider data retention for Unified Billing | [Zero Data Retention](https://developers.cloudflare.com/ai-gateway/features/unified-billing/#zero-data-retention-zdr) |
| Configure log collection, payload storage, and retention | [Logging](https://developers.cloudflare.com/ai-gateway/observability/logging/) |
| Export logs | [Workers Logpush](https://developers.cloudflare.com/ai-gateway/observability/logging/logpush/) |
| Attach request metadata for tracking and routing | [Custom metadata](https://developers.cloudflare.com/ai-gateway/observability/custom-metadata/) |
| Override model costs | [Custom costs](https://developers.cloudflare.com/ai-gateway/configuration/custom-costs/) |
| Check supported providers, quotas, or pricing | [Provider guides](https://developers.cloudflare.com/ai-gateway/usage/providers/), [limits](https://developers.cloudflare.com/ai-gateway/reference/limits/), and [pricing](https://developers.cloudflare.com/ai-gateway/reference/pricing/) |

Choose cache keys only for requests whose responses may safely be shared. Decide what prompt and response data may be stored before enabling logging; do not infer a provider's retention policy from gateway log settings.

For conditional policies and fallbacks, see [dynamic routing](./dynamic-routing.md).
