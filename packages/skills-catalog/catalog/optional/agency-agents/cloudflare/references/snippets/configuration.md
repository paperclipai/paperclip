# Snippets Configuration Guide

## Configuration Methods

### 1. Dashboard (GUI)
**Best for**: Quick tests, single snippets, visual rule building

```
1. Go to zone → Rules → Snippets
2. Click "Create Snippet" or select template
3. Enter snippet name (a-z, 0-9, _ only, cannot change later)
4. Write JavaScript code (32KB max)
5. Configure snippet rule:
   - Expression Builder (visual) or Expression Editor (text)
   - Use Ruleset Engine filter expressions
6. Test with Preview/HTTP tabs
7. Deploy or Save as Draft
```

### 2. REST API
**Best for**: CI/CD, automation, programmatic management

```bash
# Create/update snippet
curl "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/snippets/$SNIPPET_NAME" \
  --request PUT \
  --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  --form "files=@example.js" \
  --form "metadata={\"main_module\": \"example.js\"}"

# Create snippet rule
curl "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/snippets/snippet_rules" \
  --request PUT \
  --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  --header "Content-Type: application/json" \
  --data '{
    "rules": [
      {
        "description": "Trigger snippet on /api paths",
        "enabled": true,
        "expression": "starts_with(http.request.uri.path, \"/api/\")",
        "snippet_name": "api_snippet"
      }
    ]
  }'

# List snippets
curl "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/snippets" \
  --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN"

# Delete snippet
curl "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/snippets/$SNIPPET_NAME" \
  --request DELETE \
  --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

### 3. Terraform
**Best for**: Infrastructure-as-code, multi-zone deployments

```hcl
# Configure Terraform provider
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

# Create snippet
resource "cloudflare_snippet" "security_headers" {
  zone_id = var.zone_id
  name    = "security_headers"
  
  main_module = "security_headers.js"
  files {
    name    = "security_headers.js"
    content = file("${path.module}/snippets/security_headers.js")
  }
}

# Create snippet rule
resource "cloudflare_snippet_rules" "security_rules" {
  zone_id = var.zone_id
  
  rules {
    description  = "Apply security headers to all requests"
    enabled      = true
    expression   = "true"
    snippet_name = cloudflare_snippet.security_headers.name
  }
}
```

### 4. Pulumi
**Best for**: Multi-cloud IaC, TypeScript/Python/Go workflows

```typescript
import * as cloudflare from "@pulumi/cloudflare";
import * as fs from "fs";

// Create snippet
const securitySnippet = new cloudflare.Snippet("security-headers", {
  zoneId: zoneId,
  name: "security_headers",
  mainModule: "security_headers.js",
  files: [{
    name: "security_headers.js",
    content: fs.readFileSync("./snippets/security_headers.js", "utf8"),
  }],
});

// Create snippet rule
const snippetRule = new cloudflare.SnippetRules("security-rules", {
  zoneId: zoneId,
  rules: [{
    description: "Apply security headers",
    enabled: true,
    expression: "true",
    snippetName: securitySnippet.name,
  }],
});
```

## Filter Expressions

Snippets use Cloudflare's Ruleset Engine expression language to determine when to execute.

### Common Expression Patterns

```javascript
// Host matching
http.host eq "example.com"
http.host in {"example.com" "www.example.com"}
http.host contains "example"

// Path matching
http.request.uri.path eq "/api/users"
starts_with(http.request.uri.path, "/api/")
ends_with(http.request.uri.path, ".json")
matches(http.request.uri.path, "^/api/v[0-9]+/")

// Query parameters
http.request.uri.query contains "debug=true"

// Headers
http.headers["user-agent"] contains "Mobile"
http.headers["accept-language"] eq "en-US"

// Cookies
http.cookie contains "session="

// Geolocation
ip.geoip.country eq "US"
ip.geoip.continent eq "EU"

// Bot detection (requires Bot Management)
cf.bot_management.score lt 30

// Method
http.request.method eq "POST"
http.request.method in {"POST" "PUT" "PATCH"}

// Combine with logical operators
http.host eq "example.com" and starts_with(http.request.uri.path, "/api/")
ip.geoip.country eq "US" or ip.geoip.country eq "CA"
not http.headers["user-agent"] contains "bot"
```

### Expression Functions

| Function | Example | Description |
|----------|---------|-------------|
| `starts_with()` | `starts_with(http.request.uri.path, "/api/")` | Check prefix |
| `ends_with()` | `ends_with(http.request.uri.path, ".json")` | Check suffix |
| `contains()` | `contains(http.headers["user-agent"], "Mobile")` | Check substring |
| `matches()` | `matches(http.request.uri.path, "^/api/")` | Regex match |
| `lower()` | `lower(http.host) eq "example.com"` | Convert to lowercase |
| `upper()` | `upper(http.headers["x-api-key"])` | Convert to uppercase |
| `len()` | `len(http.request.uri.path) gt 100` | String length |

## Deployment Workflow

### Development
1. Write snippet code locally
2. Test syntax with `node snippet.js` or TypeScript compiler
3. Deploy to Dashboard or use API with `Save as Draft`
4. Test with Preview/HTTP tabs in Dashboard
5. Enable rule when ready

### Production
1. Store snippet code in version control
2. Use Terraform/Pulumi for reproducible deployments
3. Deploy to staging zone first
4. Test with real traffic (use low-traffic subdomain)
5. Apply to production zone
6. Monitor with Analytics/Logpush

## Limits & Requirements

| Resource | Limit | Notes |
|----------|-------|-------|
| Snippet size | 32 KB | Per snippet, compressed |
| Snippet name | 64 chars | `a-z`, `0-9`, `_` only, immutable |
| Snippets per zone | 20 | Soft limit, contact support for more |
| Rules per zone | 20 | One rule per snippet typical |
| Expression length | 4096 chars | Per rule expression |

## Authentication

### API Token (Recommended)
```bash
# Create token at: https://dash.cloudflare.com/profile/api-tokens
# Required permissions: Zone.Snippets:Edit, Zone.Rules:Edit
export CLOUDFLARE_API_TOKEN="your_token_here"
```

### API Key (Legacy)
```bash
export CLOUDFLARE_EMAIL="your@email.com"
export CLOUDFLARE_API_KEY="your_global_api_key"
``` 