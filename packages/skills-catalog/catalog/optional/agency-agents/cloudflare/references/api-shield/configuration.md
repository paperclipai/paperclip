# Configuration

## Schema Validation 2.0 Setup

> ⚠️ **Classic Schema Validation deprecated.** Use Schema Validation 2.0.

**Upload schema (Dashboard):**
```
Security > API Shield > Schema Validation > Add validation
- Upload .yml/.yaml/.json (OpenAPI v3.0)
- Endpoints auto-added to Endpoint Management
- Action: Log | Block | None
- Body inspection: JSON payloads
```

**Change validation action:**
```
Security > API Shield > Settings > Schema Validation
Per-endpoint: Filter → ellipses → Change action
Default action: Set global mitigation action
```

**Migration from Classic:**
```
1. Export existing schema (if available)
2. Delete all Classic schema validation rules
3. Wait 5 min for cache clear
4. Re-upload via Schema Validation 2.0 interface
5. Verify in Security > Events
```

**Fallthrough rule** (catch-all unknown endpoints):
```
Security > API Shield > Settings > Fallthrough > Use Template
- Select hostnames
- Create rule with cf.api_gateway.fallthrough_triggered
- Action: Log (discover) or Block (strict)
```

**Body inspection:** Supports `application/json`, `*/*`, `application/*`. Disable origin MIME sniffing to prevent bypasses.

## JWT Validation

**Setup token config:**
```
Security > API Shield > Settings > JWT Settings > Add configuration
- Name: "Auth0 JWT Config"
- Location: Header/Cookie + name (e.g., "Authorization")
- JWKS: Paste public keys from IdP
```

**Create validation rule:**
```
Security > API Shield > API Rules > Add rule
- Hostname: api.example.com
- Deselect endpoints to ignore
- Token config: Select config
- Enforce presence: Ignore or Mark as non-compliant
- Action: Log/Block/Challenge
```

**Rate limit by JWT claim:**
```wirefilter
lookup_json_string(http.request.jwt.claims["{config_id}"][0], "sub")
```

**Special cases:**
- Two JWTs, different IdPs: Create 2 configs, select both, "Validate all"
- IdP migration: 2 configs + 2 rules, adjust actions per state
- Bearer prefix: API Shield handles with/without
- Nested claims: Dot notation `user.email`

## Mutual TLS (mTLS)

**Setup:**
```
SSL/TLS > Client Certificates > Create Certificate
- Generate CF-managed CA (all plans)
- Upload custom CA (Enterprise, max 5)
```

**Configure mTLS rule:**
```
Security > API Shield > mTLS
- Select hostname(s)
- Choose certificate(s)
- Action: Block/Log/Challenge
```

**Test:**
```bash
openssl req -x509 -newkey rsa:4096 -keyout client-key.pem -out client-cert.pem -days 365
curl https://api.example.com/endpoint --cert client-cert.pem --key client-key.pem
```

## Session Identifiers

Critical for BOLA Detection, Sequence Mitigation, and analytics. Configure header/cookie that uniquely IDs API users.

**Examples:** JWT sub claim, session token, API key, custom user ID header

**Configure:**
```
Security > API Shield > Settings > Session Identifiers
- Type: Header/Cookie
- Name: "X-User-ID" or "Authorization"
```

## BOLA Detection

Detects Broken Object Level Authorization attacks (enumeration + parameter pollution).

**Enable:**
```
Security > API Shield > Schema Validation > [Select Schema] > BOLA Detection
- Enable detection
- Threshold: Sensitivity level (Low/Medium/High)
- Action: Log or Block
```

**Requirements:**
- Schema Validation 2.0 enabled
- Session identifiers configured
- Minimum traffic: 1000+ requests/day per endpoint

## Authentication Posture

Identifies unprotected or inconsistently protected endpoints.

**View report:**
```
Security > API Shield > Authentication Posture
- Shows endpoints lacking JWT/mTLS
- Highlights mixed authentication patterns
```

**Remediate:**
1. Review flagged endpoints
2. Add JWT validation rules
3. Configure mTLS for sensitive endpoints
4. Monitor posture score

## Volumetric Abuse + GraphQL

**Volumetric Abuse Detection:**
`Security > API Shield > Settings > Volumetric Abuse Detection`
- Enable per-endpoint monitoring, set thresholds, action: Log | Challenge | Block

**GraphQL Protection:**
`Security > API Shield > Settings > GraphQL Protection`
- Max query depth: 10, max size: 100KB, block introspection (production)

## Terraform

```hcl
# Session identifier
resource "cloudflare_api_shield" "main" {
  zone_id = var.zone_id
  auth_id_characteristics {
    type = "header"
    name = "Authorization"
  }
}

# Add endpoint
resource "cloudflare_api_shield_operation" "users_get" {
  zone_id  = var.zone_id
  method   = "GET"
  host     = "api.example.com"
  endpoint = "/api/users/{id}"
}

# JWT validation rule
resource "cloudflare_ruleset" "jwt_validation" {
  zone_id = var.zone_id
  name    = "API JWT Validation"
  kind    = "zone"
  phase   = "http_request_firewall_custom"

  rules {
    action = "block"
    expression = "(http.host eq \"api.example.com\" and not is_jwt_valid(http.request.jwt.payload[\"{config_id}\"][0]))"
    description = "Block invalid JWTs"
  }
}
```

## See Also

- [api.md](api.md) - API endpoints and Workers integration
- [patterns.md](patterns.md) - Firewall rules and deployment patterns
- [gotchas.md](gotchas.md) - Troubleshooting and limits
