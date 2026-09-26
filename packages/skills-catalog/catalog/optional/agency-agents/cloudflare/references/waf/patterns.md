# WAF Patterns

Choose the workflow that matches the requested outcome, then retrieve its current examples. Make rule scope explicit and review the affected traffic before enforcement.

| Outcome | Documentation |
|---------|---------------|
| Apply managed protection to a zone | [Deploy managed rules](https://developers.cloudflare.com/waf/managed-rules/deploy-api/) |
| Change a managed rule's behavior or evaluate it with logging | [Override a managed ruleset](https://developers.cloudflare.com/ruleset-engine/managed-rulesets/override-managed-ruleset/) |
| Enforce an application-specific request policy | [Create a custom rule](https://developers.cloudflare.com/waf/custom-rules/create-api/) |
| Use attack detection in a request policy | [Attack score semantics and availability](https://developers.cloudflare.com/waf/detections/attack-score/) |
| Protect a login or API endpoint from excessive requests | [Rate limiting API examples](https://developers.cloudflare.com/waf/rate-limiting-rules/create-api/) and [counting parameters](https://developers.cloudflare.com/waf/rate-limiting-rules/parameters/) |
| Exempt narrowly identified traffic from selected protections | [Available skip options](https://developers.cloudflare.com/waf/custom-rules/skip/options/) |
| Adjust protection after a false positive | [Managed rules troubleshooting](https://developers.cloudflare.com/waf/managed-rules/troubleshooting/) |

For a false positive, identify the matching rule and request scope before choosing an exception or override. Keep the adjustment as narrow as the evidence supports. For combined protections, check [WAF phases](https://developers.cloudflare.com/waf/reference/phases/) before deciding where an exception belongs.

Use [configuration.md](configuration.md) to select the deployment method and [api.md](api.md) to preserve existing rules while changing it.
