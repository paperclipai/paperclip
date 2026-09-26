# Cloudflare Terraform Provider

**Expert guidance for Cloudflare Terraform Provider - infrastructure as code for Cloudflare resources.**

## Core Principles

- **Provider-first**: Use Terraform provider for ALL infrastructure - never mix with wrangler.jsonc for the same resources
- **State management**: Always use remote state (S3, Terraform Cloud, etc.) for team environments
- **Modular architecture**: Create reusable modules for common patterns (zones, workers, pages)
- **Version pinning**: Always pin provider version with `~>` for predictable upgrades
- **Secret management**: Use variables + environment vars for sensitive data - never hardcode API tokens

## Provider Version

| Version | Status | Notes |
|---------|--------|-------|
| 5.x | Current | Auto-generated from OpenAPI, breaking changes from v4 |
| 4.x | Legacy | Manual maintenance, deprecated |

**Critical:** v5 renamed many resources (`cloudflare_record` → `cloudflare_dns_record`, `cloudflare_worker_*` → `cloudflare_workers_*`). See [gotchas.md](./gotchas.md#v5-breaking-changes) for migration details.

## Provider Setup

### Basic Configuration

```hcl
terraform {
  required_version = ">= 1.0"
  
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.15.0"
    }
  }
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token  # or CLOUDFLARE_API_TOKEN env var
}
```

### Authentication Methods (priority order)

1. **API Token** (RECOMMENDED): `api_token` or `CLOUDFLARE_API_TOKEN`
   - Create: Dashboard → My Profile → API Tokens
   - Scope to specific accounts/zones for security
   
2. **Global API Key** (LEGACY): `api_key` + `api_email` or `CLOUDFLARE_API_KEY` + `CLOUDFLARE_EMAIL`
   - Less secure, use tokens instead
   
3. **User Service Key**: `user_service_key` for Origin CA certificates



## Quick Reference: Common Commands

```bash
terraform init          # Initialize provider
terraform plan          # Plan changes
terraform apply         # Apply changes
terraform destroy       # Destroy resources
terraform import cloudflare_zone.example <zone-id>  # Import existing
terraform state list    # List resources in state
terraform output        # Show outputs
terraform fmt -recursive  # Format code
terraform validate      # Validate configuration
```

## Import Existing Resources

Use cf-terraforming to generate configs from existing Cloudflare resources:

```bash
# Install
brew install cloudflare/cloudflare/cf-terraforming

# Generate HCL from existing resources
cf-terraforming generate --resource-type cloudflare_dns_record --zone <zone-id>

# Import into Terraform state
cf-terraforming import --resource-type cloudflare_dns_record --zone <zone-id>
```

## Reading Order

1. Start with [README.md](./README.md) for provider setup and authentication
2. Review [configuration.md](./configuration.md) for resource configurations
3. Check [api.md](./api.md) for data sources and existing resource queries
4. See [patterns.md](./patterns.md) for multi-environment and CI/CD patterns
5. Read [gotchas.md](./gotchas.md) for state drift, v5 breaking changes, and troubleshooting

## In This Reference
- [configuration.md](./configuration.md) - Resources for zones, DNS, workers, KV, R2, D1, Pages, rulesets
- [api.md](./api.md) - Data sources for existing resources
- [patterns.md](./patterns.md) - Architecture patterns, multi-env setup, CI/CD integration
- [gotchas.md](./gotchas.md) - Common issues, security, best practices

## See Also
- [pulumi](../pulumi/) - Alternative IaC tool for Cloudflare
- [wrangler](https://developers.cloudflare.com/workers/wrangler/) - CLI deployment alternative
- [workers](https://developers.cloudflare.com/workers/) - Worker runtime documentation
