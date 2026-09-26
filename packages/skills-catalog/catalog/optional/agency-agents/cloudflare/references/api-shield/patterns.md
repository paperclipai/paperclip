# Patterns & Use Cases

## Protect API with Schema + JWT

```bash
# 1. Upload OpenAPI schema
POST /zones/{zone_id}/api_gateway/user_schemas

# 2. Configure JWT validation
POST /zones/{zone_id}/api_gateway/token_validation
{
  "name": "Auth0",
  "location": {"header": "Authorization"},
  "jwks": "{...}"
}

# 3. Create JWT rule
POST /zones/{zone_id}/api_gateway/jwt_validation_rules

# 4. Set schema validation action
PUT /zones/{zone_id}/api_gateway/settings/schema_validation
{"validation_default_mitigation_action": "block"}
```

## Progressive Rollout

```
1. Log mode: Observe false positives
   - Schema: Action = Log
   - JWT: Action = Log

2. Block subset: Protect critical endpoints
   - Change specific endpoint actions to Block
   - Monitor firewall events

3. Full enforcement: Block all violations
   - Change default action to Block
   - Handle fallthrough with custom rule
```

## BOLA Detection

### Enumeration Detection
Detects sequential resource access (e.g., `/users/1`, `/users/2`, `/users/3`).

```javascript
// Block BOLA enumeration attempts
(cf.api_gateway.cf-risk-bola-enumeration and http.host eq "api.example.com")
// Action: Block or Challenge
```

### Parameter Pollution
Detects duplicate/excessive parameters in requests.

```javascript
// Block parameter pollution
(cf.api_gateway.cf-risk-bola-pollution and http.host eq "api.example.com")
// Action: Block
```

### Combined BOLA Protection
```javascript
// Comprehensive BOLA rule
(cf.api_gateway.cf-risk-bola-enumeration or cf.api_gateway.cf-risk-bola-pollution)
and http.host eq "api.example.com"
// Action: Block
```

## Authentication Posture

### Detect Missing Auth
```javascript
// Log endpoints lacking authentication
(cf.api_gateway.cf-risk-missing-auth and http.host eq "api.example.com")
// Action: Log (for audit)
```

### Detect Mixed Auth
```javascript
// Alert on inconsistent auth patterns
(cf.api_gateway.cf-risk-mixed-auth and http.host eq "api.example.com")
// Action: Log (review required)
```

## Fallthrough Detection (Shadow APIs)

```javascript
// WAF Custom Rule
(cf.api_gateway.fallthrough_triggered and http.host eq "api.example.com")
// Action: Log (discover unknown) or Block (strict)
```

## Rate Limiting by User

```javascript
// Rate Limiting Rule (modern syntax)
(http.host eq "api.example.com" and
 is_jwt_valid(http.request.jwt.payload["{config_id}"][0]))

// Rate: 100 req/60s
// Counting expression: lookup_json_string(http.request.jwt.payload["{config_id}"][0], "sub")
```

## Volumetric Abuse Response

```javascript
// Detect abnormal traffic spikes
(cf.api_gateway.volumetric_abuse_detected and http.host eq "api.example.com")
// Action: Challenge or Rate Limit

// Combined with rate limiting
(cf.api_gateway.volumetric_abuse_detected or
 cf.threat_score gt 50) and http.host eq "api.example.com"
// Action: JS Challenge
```

## GraphQL Protection

```javascript
// Block oversized queries
(http.request.uri.path eq "/graphql" and
 cf.api_gateway.graphql_query_size gt 100000)
// Action: Block

// Block deep nested queries
(http.request.uri.path eq "/graphql" and
 cf.api_gateway.graphql_query_depth gt 10)
// Action: Block
```

## Architecture Patterns

**Public API:** Discovery + Schema Validation 2.0 + JWT + Rate Limiting + Bot Management  
**Partner API:** mTLS + Schema Validation + Sequence Mitigation  
**Internal API:** Discovery + Schema Learning + Auth Posture

## OWASP API Security Top 10 Mapping (2026)

| OWASP Issue | API Shield Solutions |
|-------------|---------------------|
| API1:2023 Broken Object Level Authorization | **BOLA Detection** (enumeration + pollution), Sequence mitigation, Schema, JWT, Rate Limiting |
| API2:2023 Broken Authentication | **Auth Posture**, mTLS, JWT validation, Bot Management |
| API3:2023 Broken Object Property Auth | Schema validation, JWT validation |
| API4:2023 Unrestricted Resource Access | Rate Limiting, **Volumetric Abuse Detection**, **GraphQL Protection**, Bot Management |
| API5:2023 Broken Function Level Auth | Schema validation, JWT validation, Auth Posture |
| API6:2023 Unrestricted Business Flows | Sequence mitigation, Bot Management |
| API7:2023 SSRF | Schema validation, WAF managed rules |
| API8:2023 Security Misconfiguration | **Schema Validation 2.0**, Auth Posture, WAF rules |
| API9:2023 Improper Inventory Management | **API Discovery**, Schema learning, Auth Posture |
| API10:2023 Unsafe API Consumption | JWT validation, Schema validation, WAF managed |

## Monitoring

**Security Events:** `Security > Events` → Filter: Action = block, Service = API Shield  
**Firewall Analytics:** `Analytics > Security` → Filter by `cf.api_gateway.*` fields  
**Logpush fields:** APIGatewayAuthIDPresent, APIGatewayRequestViolatesSchema, APIGatewayFallthroughDetected, JWTValidationResult

## Availability (2026)

| Feature | Availability | Notes |
|---------|-------------|-------|
| mTLS (CF-managed CA) | All plans | Self-service |
| Endpoint Management | All plans | Limited operations |
| Schema Validation 2.0 | All plans | Limited operations |
| API Discovery | Enterprise | 10K+ ops |
| JWT Validation | Enterprise add-on | Full validation |
| BOLA Detection | Enterprise add-on | Requires session IDs |
| Auth Posture | Enterprise add-on | Security audit |
| Volumetric Abuse Detection | Enterprise add-on | Traffic analysis |
| GraphQL Protection | Enterprise add-on | Query limits |
| Sequence Mitigation | Enterprise (beta) | Contact team |
| Full Suite | Enterprise add-on | All features |

**Enterprise limits:** 10K operations (contact for higher). Preview access available for non-contract evaluation.

## See Also

- [configuration.md](configuration.md) - Setup all features before creating rules
- [api.md](api.md) - Firewall field reference and API endpoints
- [gotchas.md](gotchas.md) - Common issues and limits
