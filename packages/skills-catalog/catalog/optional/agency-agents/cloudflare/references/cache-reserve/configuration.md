# Cache Reserve Configuration

## Dashboard Setup

**Minimum steps to enable:**

```bash
# Navigate to dashboard
https://dash.cloudflare.com/caching/cache-reserve

# Click "Enable Storage Sync" or "Purchase" button
```

**Prerequisites:**
- Paid Cache Reserve plan or Smart Shield Advanced required
- Tiered Cache **required** for Cache Reserve to function optimally

## API Configuration

### REST API

```bash
# Enable
curl -X PATCH "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/cache/cache_reserve" \
  -H "Authorization: Bearer $API_TOKEN" -H "Content-Type: application/json" \
  -d '{"value": "on"}'

# Check status
curl -X GET "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/cache/cache_reserve" \
  -H "Authorization: Bearer $API_TOKEN"
```

### TypeScript SDK

```bash
npm install cloudflare
```

```typescript
import Cloudflare from 'cloudflare';

const client = new Cloudflare({
  apiToken: process.env.CLOUDFLARE_API_TOKEN,
});

// Enable Cache Reserve
await client.cache.cacheReserve.edit({
  zone_id: 'abc123',
  value: 'on',
});

// Get Cache Reserve status
const status = await client.cache.cacheReserve.get({
  zone_id: 'abc123',
});
console.log(status.value); // 'on' or 'off'
```

### Python SDK

```bash
pip install cloudflare
```

```python
from cloudflare import Cloudflare

client = Cloudflare(api_token=os.environ.get("CLOUDFLARE_API_TOKEN"))

# Enable Cache Reserve
client.cache.cache_reserve.edit(
    zone_id="abc123",
    value="on"
)

# Get Cache Reserve status
status = client.cache.cache_reserve.get(zone_id="abc123")
print(status.value)  # 'on' or 'off'
```

### Terraform

```hcl
terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
  }
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

resource "cloudflare_zone_cache_reserve" "example" {
  zone_id = var.zone_id
  enabled = true
}

# Tiered Cache is required for Cache Reserve
resource "cloudflare_tiered_cache" "example" {
  zone_id    = var.zone_id
  cache_type = "smart"
}
```

### Pulumi

```typescript
import * as cloudflare from "@pulumi/cloudflare";

// Enable Cache Reserve
const cacheReserve = new cloudflare.ZoneCacheReserve("example", {
  zoneId: zoneId,
  enabled: true,
});

// Enable Tiered Cache (required)
const tieredCache = new cloudflare.TieredCache("example", {
  zoneId: zoneId,
  cacheType: "smart",
});
```

### Required API Token Permissions

- `Zone Settings Read`
- `Zone Settings Write`
- `Zone Read`
- `Zone Write`

## Cache Rules Integration

Control Cache Reserve eligibility via Cache Rules:

```typescript
// Enable for static assets
{
  action: 'set_cache_settings',
  action_parameters: {
    cache_reserve: { eligible: true, minimum_file_ttl: 86400 },
    edge_ttl: { mode: 'override_origin', default: 86400 },
    cache: true
  },
  expression: '(http.request.uri.path matches "\\.(jpg|png|webp|pdf|zip)$")'
}

// Disable for APIs
{
  action: 'set_cache_settings',
  action_parameters: { cache_reserve: { eligible: false } },
  expression: '(http.request.uri.path matches "^/api/")'
}

// Create via API: PUT to zones/{zone_id}/rulesets/phases/http_request_cache_settings/entrypoint
```

## Wrangler Integration

Cache Reserve works automatically with Workers deployed via Wrangler. No special wrangler.jsonc configuration needed - enable Cache Reserve via Dashboard or API for the zone.

## See Also

- [README](./README.md) - Overview and core concepts
- [API Reference](./api.md) - Purging and monitoring APIs
- [Patterns](./patterns.md) - Best practices and optimization
- [Gotchas](./gotchas.md) - Common issues and troubleshooting
