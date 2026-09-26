# Terraform Patterns & Use Cases

Architecture patterns, multi-environment setups, and real-world use cases.

## Recommended Directory Structure

```
terraform/
├── environments/
│   ├── production/
│   │   ├── main.tf
│   │   └── terraform.tfvars
│   └── staging/
│       ├── main.tf
│       └── terraform.tfvars
├── modules/
│   ├── zone/
│   ├── worker/
│   └── dns/
└── shared/          # Shared resources across envs
    └── main.tf
```

**Note:** Cloudflare recommends avoiding modules for provider resources due to v5 auto-generation complexity. Prefer environment directories + shared state instead.

## Multi-Environment Setup

```hcl
# Directory: environments/{production,staging}/main.tf + modules/{zone,worker,pages}
module "zone" {
  source = "../../modules/zone"; account_id = var.account_id; zone_name = "example.com"; environment = "production"
}
module "api_worker" {
  source = "../../modules/worker"; account_id = var.account_id; zone_id = module.zone.zone_id
  name = "api-worker-prod"; script = file("../../workers/api.js"); environment = "production"
}
```

## R2 State Backend

```hcl
terraform {
  backend "s3" {
    bucket = "terraform-state"
    key = "cloudflare.tfstate"
    region = "auto"
    endpoints = { s3 = "https://<account_id>.r2.cloudflarestorage.com" }
    skip_credentials_validation = true
    skip_region_validation = true
    skip_requesting_account_id = true
    skip_metadata_api_check = true
    skip_s3_checksum = true
  }
}
```

## Worker with All Bindings

```hcl
locals { worker_name = "full-stack-worker" }
resource "cloudflare_workers_kv_namespace" "app" { account_id = var.account_id; title = "${local.worker_name}-kv" }
resource "cloudflare_r2_bucket" "app" { account_id = var.account_id; name = "${local.worker_name}-bucket" }
resource "cloudflare_d1_database" "app" { account_id = var.account_id; name = "${local.worker_name}-db" }

resource "cloudflare_worker_script" "app" {
  account_id = var.account_id; name = local.worker_name; content = file("worker.js"); module = true
  compatibility_date = "2025-01-01"
  kv_namespace_binding { name = "KV"; namespace_id = cloudflare_workers_kv_namespace.app.id }
  r2_bucket_binding { name = "BUCKET"; bucket_name = cloudflare_r2_bucket.app.name }
  d1_database_binding { name = "DB"; database_id = cloudflare_d1_database.app.id }
  secret_text_binding { name = "API_KEY"; text = var.api_key }
}
```

## Wrangler Integration

**CRITICAL**: Wrangler and Terraform must NOT manage same resources.

**Terraform**: Zones, DNS, security rules, Access, load balancers, worker deployments (CI/CD), KV/R2/D1 resource creation  
**Wrangler**: Local dev (`wrangler dev`), manual deploys, D1 migrations, KV bulk ops, log streaming (`wrangler tail`)

### CI/CD Pattern

```hcl
# Terraform creates infrastructure
resource "cloudflare_workers_kv_namespace" "app" { account_id = var.account_id; title = "app-kv" }
resource "cloudflare_d1_database" "app" { account_id = var.account_id; name = "app-db" }
output "kv_namespace_id" { value = cloudflare_workers_kv_namespace.app.id }
output "d1_database_id" { value = cloudflare_d1_database.app.id }
```

```yaml
# GitHub Actions: terraform apply → envsubst wrangler.jsonc.template → wrangler deploy
- run: terraform apply -auto-approve
- run: |
    export KV_NAMESPACE_ID=$(terraform output -raw kv_namespace_id)
    envsubst < wrangler.jsonc.template > wrangler.jsonc
- run: wrangler deploy
```

## Use Cases

### Static Site + API Worker

```hcl
resource "cloudflare_pages_project" "frontend" {
  account_id = var.account_id; name = "frontend"; production_branch = "main"
  build_config { build_command = "npm run build"; destination_dir = "dist" }
}
resource "cloudflare_worker_script" "api" {
  account_id = var.account_id; name = "api"; content = file("api-worker.js")
  d1_database_binding { name = "DB"; database_id = cloudflare_d1_database.api_db.id }
}
resource "cloudflare_dns_record" "frontend" {
  zone_id = cloudflare_zone.main.id; name = "app"; content = cloudflare_pages_project.frontend.subdomain; type = "CNAME"; proxied = true
}
resource "cloudflare_worker_route" "api" {
  zone_id = cloudflare_zone.main.id; pattern = "api.example.com/*"; script_name = cloudflare_worker_script.api.name
}
```

### Multi-Region Load Balancing

```hcl
resource "cloudflare_load_balancer_pool" "us" {
  account_id = var.account_id; name = "us-pool"; monitor = cloudflare_load_balancer_monitor.http.id
  origins { name = "us-east"; address = var.us_east_ip }
}
resource "cloudflare_load_balancer_pool" "eu" {
  account_id = var.account_id; name = "eu-pool"; monitor = cloudflare_load_balancer_monitor.http.id
  origins { name = "eu-west"; address = var.eu_west_ip }
}
resource "cloudflare_load_balancer" "global" {
  zone_id = cloudflare_zone.main.id; name = "api.example.com"; steering_policy = "geo"
  default_pool_ids = [cloudflare_load_balancer_pool.us.id]
  region_pools { region = "WNAM"; pool_ids = [cloudflare_load_balancer_pool.us.id] }
  region_pools { region = "WEU"; pool_ids = [cloudflare_load_balancer_pool.eu.id] }
}
```

### Secure Admin with Access

```hcl
resource "cloudflare_pages_project" "admin" { account_id = var.account_id; name = "admin"; production_branch = "main" }
resource "cloudflare_access_application" "admin" {
  account_id = var.account_id; name = "Admin"; domain = "admin.example.com"; type = "self_hosted"; session_duration = "24h"
  allowed_idps = [cloudflare_access_identity_provider.google.id]
}
resource "cloudflare_access_policy" "allow" {
  account_id = var.account_id; application_id = cloudflare_access_application.admin.id
  name = "Allow admins"; decision = "allow"; precedence = 1; include { email = var.admin_emails }
}
```

### Reusable Module

```hcl
# modules/cloudflare-zone/main.tf
variable "account_id" { type = string }; variable "domain" { type = string }; variable "ssl_mode" { default = "strict" }
resource "cloudflare_zone" "main" { account = { id = var.account_id }; name = var.domain }
resource "cloudflare_zone_settings_override" "main" {
  zone_id = cloudflare_zone.main.id; settings { ssl = var.ssl_mode; always_use_https = "on" }
}
output "zone_id" { value = cloudflare_zone.main.id }

# Usage: module "prod" { source = "./modules/cloudflare-zone"; account_id = var.account_id; domain = "example.com" }
```

## See Also

- [README](./README.md) - Provider setup
- [Configuration Reference](./configuration.md) - All resource types
- [API Reference](./api.md) - Data sources
- [Troubleshooting](./gotchas.md) - Best practices, common issues
