# WAF Configuration

Identify the account or zone, existing rulesets, and the system managing them before choosing a deployment method. Use the permission requirements in the selected workflow rather than a copied token-permission list.

| Task | Documentation |
|------|---------------|
| Enable protections and configure them in the dashboard | [WAF get started](https://developers.cloudflare.com/waf/get-started/) |
| Configure custom rules through the API or SDK | [Custom rules API workflow](https://developers.cloudflare.com/waf/custom-rules/create-api/) |
| Configure managed rules through the API or SDK | [Managed rules API workflow](https://developers.cloudflare.com/waf/managed-rules/deploy-api/) |
| Configure rate limiting through the API or SDK | [Rate limiting API workflow](https://developers.cloudflare.com/waf/rate-limiting-rules/create-api/) |
| Manage custom rules with Terraform | [Custom rules Terraform guide](https://developers.cloudflare.com/terraform/additional-configurations/waf-custom-rules/) |
| Manage managed rulesets with Terraform | [Managed rules Terraform guide](https://developers.cloudflare.com/terraform/additional-configurations/waf-managed-rulesets/) |
| Manage rate limits with Terraform | [Rate limiting Terraform guide](https://developers.cloudflare.com/terraform/additional-configurations/rate-limiting-rules/) |
| Decide account versus zone placement and phase | [WAF phases](https://developers.cloudflare.com/waf/reference/phases/) |

When adopting existing rules into Terraform, follow the selected guide's import instructions and inspect the plan for unintended removals. Keep the existing management tool when it fits the task. For SDK or Pulumi projects, verify the installed package's types before translating the documented API workflow.

Continue with [patterns.md](patterns.md) for protection choices and [gotchas.md](gotchas.md) for diagnostics.
