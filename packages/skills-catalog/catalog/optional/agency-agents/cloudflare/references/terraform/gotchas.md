# Terraform Troubleshooting & Best Practices

Common issues, security considerations, and best practices.

## State Drift Issues

Some resources have known state drift. Add lifecycle blocks to prevent perpetual diffs:

| Resource | Drift Attributes | Workaround |
|----------|------------------|------------|
| `cloudflare_pages_project` | `deployment_configs.*` | `ignore_changes = [deployment_configs]` |
| `cloudflare_workers_script` | secrets returned as REDACTED | `ignore_changes = [secret_text_binding]` |
| `cloudflare_load_balancer` | `adaptive_routing`, `random_steering` | `ignore_changes = [adaptive_routing, random_steering]` |
| `cloudflare_workers_kv` | special chars in keys (< 5.16.0) | Upgrade to 5.16.0+ |

```hcl
# Example: Ignore secret drift
resource "cloudflare_workers_script" "api" {
  account_id = var.account_id
  name = "api-worker"
  content = file("worker.js")
  secret_text_binding { name = "API_KEY"; text = var.api_key }
  
  lifecycle {
    ignore_changes = [secret_text_binding]
  }
}
```

## v5 Breaking Changes

Provider v5 is current (auto-generated from OpenAPI). v4→v5 has breaking changes:

**Resource Renames:**

| v4 Resource | v5 Resource | Notes |
|-------------|-------------|-------|
| `cloudflare_record` | `cloudflare_dns_record` | |
| `cloudflare_worker_script` | `cloudflare_workers_script` | Note: plural |
| `cloudflare_worker_*` | `cloudflare_workers_*` | All worker resources |
| `cloudflare_access_*` | `cloudflare_zero_trust_*` | Access → Zero Trust |

**Attribute Changes:**

| v4 Attribute | v5 Attribute | Resources |
|--------------|--------------|-----------|
| `zone` | `name` | zone |
| `account_id` | `account.id` | zone (object syntax) |
| `key` | `key_name` | KV |
| `location_hint` | `location` | R2 |

**State Migration:**

```bash
# Rename resources in state after v5 upgrade
terraform state mv cloudflare_record.example cloudflare_dns_record.example
terraform state mv cloudflare_worker_script.api cloudflare_workers_script.api
```

## Resource-Specific Gotchas

### R2 Location Case Sensitivity

**Problem:** Terraform creates R2 bucket but fails on subsequent applies  
**Cause:** Location must be UPPERCASE  
**Solution:** Use `WNAM`, `ENAM`, `WEUR`, `EEUR`, `APAC` (not `wnam`, `enam`, etc.)

```hcl
resource "cloudflare_r2_bucket" "assets" {
  account_id = var.account_id
  name = "assets"
  location = "WNAM"  # UPPERCASE required
}
```

### KV Special Characters (< 5.16.0)

**Problem:** Keys with `+`, `#`, `%` cause encoding issues  
**Cause:** URL encoding bug in provider < 5.16.0  
**Solution:** Upgrade to 5.16.0+ or avoid special chars in keys

### D1 Migrations

**Problem:** Terraform creates database but schema is empty  
**Cause:** Terraform only creates D1 resource, not schema  
**Solution:** Run migrations via wrangler after Terraform apply

```bash
# After terraform apply
wrangler d1 migrations apply <db-name>
```

### Worker Script Size Limit

**Problem:** Worker deployment fails with "script too large"  
**Cause:** Worker script + dependencies exceed 10 MB limit  
**Solution:** Use code splitting, external dependencies, or minification

### Pages Project Drift

**Problem:** Pages project shows perpetual diff on `deployment_configs`  
**Cause:** Cloudflare API adds default values not in Terraform state  
**Solution:** Add lifecycle ignore block (see State Drift table above)

## Common Errors

### "Error: couldn't find resource"

**Cause:** Resource was deleted outside Terraform  
**Solution:** Import resource back into state with `terraform import cloudflare_zone.example <zone-id>` or remove from state with `terraform state rm cloudflare_zone.example`

### "409 Conflict on worker deployment"

**Cause:** Worker being deployed by both Terraform and wrangler simultaneously  
**Solution:** Choose one deployment method; if using Terraform, remove wrangler deployments

### "DNS record already exists"

**Cause:** Existing DNS record not imported into Terraform state  
**Solution:** Find record ID in Cloudflare dashboard and import with `terraform import cloudflare_dns_record.example <zone-id>/<record-id>`

### "Invalid provider configuration"

**Cause:** API token missing, invalid, or lacking required permissions  
**Solution:** Set `CLOUDFLARE_API_TOKEN` environment variable or check token permissions in dashboard

### "State locking errors"

**Cause:** Multiple concurrent Terraform runs or stale lock from crashed process  
**Solution:** Remove stale lock with `terraform force-unlock <lock-id>` (use with caution)

## Limits

| Resource | Limit | Notes |
|----------|-------|-------|
| API token rate limit | Varies by plan | Use `api_client_logging = true` to debug
| Worker script size | 10 MB | Includes all dependencies
| KV keys per namespace | Unlimited | Pay per operation
| R2 storage | Unlimited | Pay per GB
| D1 databases | 50,000 per account | Free tier: 10
| Pages projects | 500 per account | 100 for free accounts
| DNS records | 3,500 per zone | Free plan

## See Also

- [README](./README.md) - Provider setup
- [Configuration](./configuration.md) - Resources
- [API](./api.md) - Data sources
- [Patterns](./patterns.md) - Use cases
- Provider docs: https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs
