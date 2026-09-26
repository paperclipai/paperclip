# Cloudflare WAF

Use this reference for managed protection, custom request policies, rate limiting, and investigation of blocked traffic. Read the relevant developer documentation before implementing; it owns schemas, expressions, ruleset IDs, phase order, and plan availability.

| Task | Start here |
|------|------------|
| Choose and enable WAF protections | [Get started](https://developers.cloudflare.com/waf/get-started/) |
| Deploy managed protection | [Managed rules deployment](https://developers.cloudflare.com/waf/managed-rules/deploy-api/) |
| Match application-specific requests | [Custom rules](https://developers.cloudflare.com/waf/custom-rules/create-api/) |
| Limit request volume | [Rate limiting](https://developers.cloudflare.com/waf/rate-limiting-rules/create-api/) |
| Understand score-based detection | [Attack score](https://developers.cloudflare.com/waf/detections/attack-score/) |
| Diagnose blocked or unmitigated requests | [Managed rules troubleshooting](https://developers.cloudflare.com/waf/managed-rules/troubleshooting/) |

Identify the target account or zone and inspect existing rules before planning a change. Keep the requested traffic scope explicit, especially for exceptions and account-wide deployments.

## Reading Order

1. [configuration.md](configuration.md) — deployment method and existing configuration.
2. [api.md](api.md) — API workflows and expression references.
3. [patterns.md](patterns.md) — choose a protection or exception workflow.
4. [gotchas.md](gotchas.md) — diagnose ordering, scope, and false positives.
