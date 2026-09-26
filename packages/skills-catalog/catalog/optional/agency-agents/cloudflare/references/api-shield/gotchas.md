# Gotchas & Troubleshooting

## Common Errors

### "Schema Validation 2.0 not working after migration"

**Cause:** Classic rules still active, conflicting with new system
**Solution:**
1. Delete ALL Classic schema validation rules
2. Clear Cloudflare cache (wait 5 min)
3. Re-upload schema via new Schema Validation 2.0 interface
4. Verify in Security > Events
5. Check action is set (Log/Block)

### "Schema validation blocking valid requests"

**Cause:** Schema too restrictive, missing fields, or incorrect types
**Solution:** 
1. Check Firewall Events for violation details
2. Review schema in Settings
3. Test schema in Swagger Editor
4. Use Log mode to validate before blocking
5. Update schema with correct specifications
6. Ensure Schema Validation 2.0 (not Classic)

### "JWT validation failing"

**Cause:** JWKS mismatch with IdP, expired token, wrong header/cookie name, or clock skew
**Solution:** 
1. Verify JWKS matches IdP configuration
2. Check token `exp` claim is valid
3. Confirm header/cookie name matches config
4. Test token at jwt.io
5. Account for clock skew (±5 min tolerance)
6. Use modern syntax: `is_jwt_valid(http.request.jwt.payload["{config_id}"][0])`

### "BOLA detection false positives"

**Cause:** Legitimate sequential access patterns, bulk operations, or sensitivity too high
**Solution:**
1. Review BOLA events in Security > Events
2. Lower sensitivity threshold (High → Medium → Low)
3. Exclude legitimate bulk operations from detection
4. Ensure session identifiers uniquely identify users
5. Verify minimum traffic requirements met (1000+ req/day)

### "Risk labels not appearing in firewall rules"

**Cause:** Feature not enabled, insufficient traffic, or missing session identifiers
**Solution:**
1. Verify Schema Validation 2.0 enabled
2. Enable BOLA Detection in schema settings
3. Configure session identifiers (required for BOLA)
4. Wait 24-48h for ML model training
5. Check minimum traffic thresholds met

### "Endpoint discovery not finding APIs"

**Cause:** Insufficient traffic (<500 reqs/10d), non-2xx responses, Worker direct requests, or incorrect session ID config
**Solution:** Ensure 500+ requests in 10 days, 2xx responses from edge (not Workers direct), configure session IDs correctly. ML updates daily.

### "Sequence detection false positives"

**Cause:** Lookback window issues, non-unique session IDs, or model sensitivity
**Solution:** 
1. Review lookback settings (10 reqs to managed endpoints, 10min window)
2. Ensure session ID uniqueness per user (not shared tokens)
3. Adjust positive/negative model balance
4. Exclude legitimate workflows from detection

### "GraphQL protection blocking valid queries"

**Cause:** Query depth/size limits too restrictive, complex but legitimate queries
**Solution:**
1. Review blocked query patterns in Security > Events
2. Increase max_depth (default: 10) if needed
3. Increase max_size (default: 100KB) for complex queries
4. Whitelist specific query signatures
5. Use Log mode to tune before blocking

### "Token invalid"

**Cause:** Configuration error, JWKS mismatch, or expired token
**Solution:** Verify config matches IdP, update JWKS, check token expiration

### "Schema violation"

**Cause:** Missing required fields, wrong data types, or spec mismatch
**Solution:** Review schema against actual requests, ensure all required fields present, validate types match spec

### "Fallthrough"

**Cause:** Unknown endpoint or pattern mismatch
**Solution:** Update schema with all endpoints, check path pattern matching

### "mTLS failed"

**Cause:** Certificate untrusted/expired or wrong CA
**Solution:** Verify cert chain, check expiration, confirm correct CA uploaded

## Limits (2026)

| Resource/Limit | Value | Notes |
|----------------|-------|-------|
| OpenAPI version | v3.0.x only | No external refs, must be valid |
| Schema operations | 10K (Enterprise) | Contact for higher limits |
| JWT validation sources | Headers/cookies only | No query params/body |
| Endpoint discovery | 500+ reqs/10d | Minimum for ML model |
| Path normalization | Automatic | `/profile/238` → `/profile/{var1}` |
| Schema parameters | No `content` field | No object param validation |
| BOLA detection | 1000+ reqs/day/endpoint | Per-endpoint minimum |
| Session ID uniqueness | Required | BOLA/Sequence need unique IDs |
| GraphQL max depth | 1-50 | Default: 10 |
| GraphQL max size | 1KB-1MB | Default: 100KB |
| JWT claim nesting | 10 levels max | Use dot notation |
| mTLS CA certificates | 5 custom max | CF-managed unlimited |
| Schema upload size | 5MB max | Compressed OpenAPI spec |
| Volumetric abuse baseline | 7 days training | Initial ML period |
| Auth Posture refresh | Daily | Updated nightly |

## See Also

- [configuration.md](configuration.md) - Setup guides to avoid common issues
- [patterns.md](patterns.md) - Best practices and progressive rollout
- [API Shield Docs](https://developers.cloudflare.com/api-shield/)
