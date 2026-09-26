# Terraform Configuration Reference

Complete resource configurations for Cloudflare infrastructure.

## Zone & DNS

```hcl
# Zone + settings
resource "cloudflare_zone" "example" { account = { id = var.account_id }; name = "example.com"; type = "full" }
resource "cloudflare_zone_settings_override" "example" {
  zone_id = cloudflare_zone.example.id
  settings { ssl = "strict"; always_use_https = "on"; min_tls_version = "1.2"; tls_1_3 = "on"; http3 = "on" }
}

# DNS records (A, CNAME, MX, TXT)
resource "cloudflare_dns_record" "www" {
  zone_id = cloudflare_zone.example.id; name = "www"; content = "192.0.2.1"; type = "A"; proxied = true
}
resource "cloudflare_dns_record" "mx" {
  for_each = { "10" = "mail1.example.com", "20" = "mail2.example.com" }
  zone_id = cloudflare_zone.example.id; name = "@"; content = each.value; type = "MX"; priority = each.key
}
```

## Workers

### Simple Pattern (Legacy - Still Works)

```hcl
resource "cloudflare_workers_script" "api" {
  account_id = var.account_id; name = "api-worker"; content = file("worker.js")
  module = true; compatibility_date = "2025-01-01"
  kv_namespace_binding { name = "KV"; namespace_id = cloudflare_workers_kv_namespace.cache.id }
  r2_bucket_binding { name = "BUCKET"; bucket_name = cloudflare_r2_bucket.assets.name }
  d1_database_binding { name = "DB"; database_id = cloudflare_d1_database.app.id }
  secret_text_binding { name = "SECRET"; text = var.secret }
}
```

### Gradual Rollouts (Recommended for Production)

```hcl
resource "cloudflare_worker" "api" { account_id = var.account_id; name = "api-worker" }
resource "cloudflare_worker_version" "api_v1" {
  account_id = var.account_id; worker_name = cloudflare_worker.api.name
  content = file("worker.js"); content_sha256 = filesha256("worker.js")
  compatibility_date = "2025-01-01"
  bindings {
    kv_namespace { name = "KV"; namespace_id = cloudflare_workers_kv_namespace.cache.id }
    r2_bucket { name = "BUCKET"; bucket_name = cloudflare_r2_bucket.assets.name }
  }
}
resource "cloudflare_workers_deployment" "api" {
  account_id = var.account_id; worker_name = cloudflare_worker.api.name
  versions { version_id = cloudflare_worker_version.api_v1.id; percentage = 100 }
}
```

### Worker Binding Types (v5)

| Binding | Attribute | Example |
|---------|-----------|---------|
| KV | `kv_namespace_binding` | `{ name = "KV", namespace_id = "..." }` |
| R2 | `r2_bucket_binding` | `{ name = "BUCKET", bucket_name = "..." }` |
| D1 | `d1_database_binding` | `{ name = "DB", database_id = "..." }` |
| Service | `service_binding` | `{ name = "AUTH", service = "auth-worker" }` |
| Secret | `secret_text_binding` | `{ name = "API_KEY", text = "..." }` |
| Queue | `queue_binding` | `{ name = "QUEUE", queue_name = "..." }` |
| Vectorize | `vectorize_binding` | `{ name = "INDEX", index_name = "..." }` |
| Hyperdrive | `hyperdrive_binding` | `{ name = "DB", id = "..." }` |
| AI | `ai_binding` | `{ name = "AI" }` |
| Browser | `browser_binding` | `{ name = "BROWSER" }` |
| Analytics | `analytics_engine_binding` | `{ name = "ANALYTICS", dataset = "..." }` |
| mTLS | `mtls_certificate_binding` | `{ name = "CERT", certificate_id = "..." }` |

### Routes & Triggers

```hcl
resource "cloudflare_worker_route" "api" {
  zone_id = cloudflare_zone.example.id; pattern = "api.example.com/*"
  script_name = cloudflare_workers_script.api.name
}
resource "cloudflare_worker_cron_trigger" "task" {
  account_id = var.account_id; script_name = cloudflare_workers_script.api.name
  schedules = ["*/5 * * * *"]
}
```

## Storage (KV, R2, D1)

```hcl
# KV
resource "cloudflare_workers_kv_namespace" "cache" { account_id = var.account_id; title = "cache" }
resource "cloudflare_workers_kv" "config" {
  account_id = var.account_id; namespace_id = cloudflare_workers_kv_namespace.cache.id
  key_name = "config"; value = jsonencode({ version = "1.0" })
}

# R2
resource "cloudflare_r2_bucket" "assets" { account_id = var.account_id; name = "assets"; location = "WNAM" }

# D1 (migrations via wrangler) & Queues
resource "cloudflare_d1_database" "app" { account_id = var.account_id; name = "app-db" }
resource "cloudflare_queue" "events" { account_id = var.account_id; name = "events-queue" }
```

## Pages

```hcl
resource "cloudflare_pages_project" "site" {
  account_id = var.account_id; name = "site"; production_branch = "main"
  deployment_configs {
    production {
      compatibility_date = "2025-01-01"
      environment_variables = { NODE_ENV = "production" }
      kv_namespaces = { KV = cloudflare_workers_kv_namespace.cache.id }
      d1_databases = { DB = cloudflare_d1_database.app.id }
    }
  }
  build_config { build_command = "npm run build"; destination_dir = "dist" }
  source { type = "github"; config { owner = "org"; repo_name = "site"; production_branch = "main" }}
}

resource "cloudflare_pages_domain" "custom" {
  account_id = var.account_id; project_name = cloudflare_pages_project.site.name; domain = "site.example.com"
}
```

## Rulesets (WAF, Redirects, Cache)

```hcl
# WAF
resource "cloudflare_ruleset" "waf" {
  zone_id = cloudflare_zone.example.id; name = "WAF"; kind = "zone"; phase = "http_request_firewall_custom"
  rules { action = "block"; enabled = true; expression = "(cf.client.bot) and not (cf.verified_bot)" }
}

# Redirects
resource "cloudflare_ruleset" "redirects" {
  zone_id = cloudflare_zone.example.id; name = "Redirects"; kind = "zone"; phase = "http_request_dynamic_redirect"
  rules {
    action = "redirect"; enabled = true; expression = "(http.request.uri.path eq \"/old\")"
    action_parameters { from_value { status_code = 301; target_url { value = "https://example.com/new" }}}
  }
}

# Cache rules
resource "cloudflare_ruleset" "cache" {
  zone_id = cloudflare_zone.example.id; name = "Cache"; kind = "zone"; phase = "http_request_cache_settings"
  rules {
    action = "set_cache_settings"; enabled = true; expression = "(http.request.uri.path matches \"\\.(jpg|png|css|js)$\")"
    action_parameters { cache = true; edge_ttl { mode = "override_origin"; default = 86400 }}
  }
}
```

## Load Balancers

```hcl
resource "cloudflare_load_balancer_monitor" "http" {
  account_id = var.account_id; type = "http"; path = "/health"; interval = 60; timeout = 5
}
resource "cloudflare_load_balancer_pool" "api" {
  account_id = var.account_id; name = "api-pool"; monitor = cloudflare_load_balancer_monitor.http.id
  origins { name = "api-1"; address = "192.0.2.1" }
  origins { name = "api-2"; address = "192.0.2.2" }
}
resource "cloudflare_load_balancer" "api" {
  zone_id = cloudflare_zone.example.id; name = "api.example.com"
  default_pool_ids = [cloudflare_load_balancer_pool.api.id]; steering_policy = "geo"
}
```

## Access (Zero Trust)

```hcl
resource "cloudflare_access_application" "admin" {
  account_id = var.account_id; name = "Admin"; domain = "admin.example.com"; type = "self_hosted"
  session_duration = "24h"; allowed_idps = [cloudflare_access_identity_provider.github.id]
}
resource "cloudflare_access_policy" "allow" {
  account_id = var.account_id; application_id = cloudflare_access_application.admin.id
  name = "Allow"; decision = "allow"; precedence = 1
  include { email = ["admin@example.com"] }
}
resource "cloudflare_access_identity_provider" "github" {
  account_id = var.account_id; name = "GitHub"; type = "github"
  config { client_id = var.github_id; client_secret = var.github_secret }
}
```

## See Also

- [README](./README.md) - Provider setup
- [API](./api.md) - Data sources
- [Patterns](./patterns.md) - Use cases
- [Troubleshooting](./gotchas.md) - Issues
