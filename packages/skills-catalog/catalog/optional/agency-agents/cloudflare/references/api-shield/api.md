# API Reference

Base: `/zones/{zone_id}/api_gateway`

## Endpoints

```bash
GET /operations                    # List
GET /operations/{op_id}            # Get single
POST /operations/item              # Create: {endpoint,host,method}
POST /operations                   # Bulk: {operations:[{endpoint,host,method}]}
DELETE /operations/{op_id}         # Delete
DELETE /operations                 # Bulk delete: {operation_ids:[...]}
```

## Discovery

```bash
GET /discovery/operations                    # List discovered
PATCH /discovery/operations/{op_id}          # Update: {state:"saved"|"ignored"}
PATCH /discovery/operations                  # Bulk: {operation_ids:{id:{state}}}
GET /discovery                               # OpenAPI export
```

## Config

```bash
GET /configuration        # Get session ID config
PUT /configuration        # Update: {auth_id_characteristics:[{name,type:"header"|"cookie"}]}
```

## Token Validation

```bash
GET /token_validation                  # List
POST /token_validation                 # Create: {name,location:{header:"..."},jwks:"..."}
POST /jwt_validation_rules             # Rule: {name,hostname,token_validation_id,action:"block"}
```

## Workers Integration

### Access JWT Claims
```js
export default {
  async fetch(req, env) {
    // Access validated JWT payload
    const jwt = req.cf?.jwt?.payload?.[env.JWT_CONFIG_ID]?.[0];
    if (jwt) {
      const userId = jwt.sub;
      const role = jwt.role;
    }
  }
}
```

### Access mTLS Info
```js
export default {
  async fetch(req, env) {
    const tls = req.cf?.tlsClientAuth;
    if (tls?.certVerified === 'SUCCESS') {
      const fingerprint = tls.certFingerprintSHA256;
      // Authenticated client
    }
  }
}
```

### Dynamic JWKS Update
```js
export default {
  async scheduled(event, env) {
    const jwks = await (await fetch('https://auth.example.com/.well-known/jwks.json')).json();
    await fetch(`https://api.cloudflare.com/client/v4/zones/${env.ZONE_ID}/api_gateway/token_validation/${env.CONFIG_ID}`, {
      method: 'PATCH',
      headers: {'Authorization': `Bearer ${env.CF_API_TOKEN}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({jwks: JSON.stringify(jwks)})
    });
  }
}
```

## Firewall Fields

### Core Fields
```js
cf.api_gateway.auth_id_present           // Session ID present
cf.api_gateway.request_violates_schema   // Schema violation
cf.api_gateway.fallthrough_triggered     // No endpoint match
cf.tls_client_auth.cert_verified         // mTLS cert valid
cf.tls_client_auth.cert_fingerprint_sha256
```

### JWT Validation (2026)
```js
// Modern validation syntax
is_jwt_valid(http.request.jwt.payload["{config_id}"][0])

// Legacy (still supported)
cf.api_gateway.jwt_claims_valid

// Extract claims
lookup_json_string(http.request.jwt.payload["{config_id}"][0], "claim_name")
```

### Risk Labels (2026)
```js
// BOLA detection
cf.api_gateway.cf-risk-bola-enumeration  // Sequential resource access detected
cf.api_gateway.cf-risk-bola-pollution    // Parameter pollution detected

// Authentication posture
cf.api_gateway.cf-risk-missing-auth      // Endpoint lacks authentication
cf.api_gateway.cf-risk-mixed-auth        // Inconsistent auth patterns
```

## BOLA Detection

```bash
GET /user_schemas/{schema_id}/bola             # Get BOLA config
PATCH /user_schemas/{schema_id}/bola           # Update: {enabled:true}
```

## Auth Posture

```bash
GET /discovery/authentication_posture          # List unprotected endpoints
```

## GraphQL Protection

```bash
GET /settings/graphql_protection               # Get limits
PUT /settings/graphql_protection               # Set: {max_depth,max_size}
```

## See Also

- [configuration.md](configuration.md) - Setup guides for all features
- [patterns.md](patterns.md) - Firewall rules and common patterns
- [API Gateway API Docs](https://developers.cloudflare.com/api/resources/api_gateway/)
