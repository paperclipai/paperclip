## Best Practices Summary

**Smart Shield Note:** Argo Smart Routing evolving into Smart Shield. Best practices below remain applicable; monitor Cloudflare changelog for Smart Shield updates.

1. **Always check editability** before attempting to enable/disable Argo
2. **Set up billing notifications** to avoid unexpected costs
3. **Combine with Tiered Cache** for maximum performance benefit
4. **Use in production only** - disable for dev/staging to control costs
5. **Monitor analytics** - require 500+ requests in 48h for detailed metrics
6. **Handle errors gracefully** - check for billing, permissions, zone compatibility
7. **Test configuration changes** in staging before production
8. **Use TypeScript SDK** for type safety and better developer experience
9. **Implement retry logic** for API calls in production systems
10. **Document zone-specific settings** for team visibility

## Common Errors

### "Argo unavailable"

**Problem:** API returns error "Argo Smart Routing is unavailable for this zone"

**Cause:** Zone not eligible or billing not set up

**Solution:**
1. Verify zone has Enterprise or higher plan
2. Check billing is configured in Account → Billing
3. Ensure payment method is valid and current
4. Contact Cloudflare support if eligibility unclear

### "Cannot enable/disable"

**Problem:** API call succeeds but status remains unchanged, or `editable: false` in GET response

**Cause:** Insufficient permissions or zone restrictions

**Solution:**
1. Check API token has `Zone:Argo Smart Routing:Edit` permission
2. Verify `editable: true` in GET response before attempting PATCH
3. If `editable: false`, check:
   - Billing configured for account
   - Zone plan includes Argo (Enterprise+)
   - No active zone holds or suspensions
   - API token has correct scopes

### `editable: false` Error

**Problem:** GET request returns `"editable": false`, preventing enable/disable

**Cause:** Zone-level restrictions from billing, plan, or permissions

**Solution Pattern:**
```typescript
const status = await client.argo.smartRouting.get({ zone_id: zoneId });

if (!status.editable) {
  // Don't attempt to modify - will fail
  console.error('Cannot modify Argo settings:');
  console.error('- Check billing is configured');
  console.error('- Verify zone has Enterprise+ plan');
  console.error('- Confirm API token has Edit permission');
  throw new Error('Argo is not editable for this zone');
}

// Safe to proceed with enable/disable
await client.argo.smartRouting.edit({ zone_id: zoneId, value: 'on' });
```

### Rate Limiting

**Problem:** `429 Too Many Requests` error from API

**Cause:** Exceeded API rate limits (typically 1200 requests per 5 minutes)

**Solution:**
```typescript
import { RateLimitError } from 'cloudflare';

try {
  await client.argo.smartRouting.edit({ zone_id: zoneId, value: 'on' });
} catch (error) {
  if (error instanceof RateLimitError) {
    const retryAfter = error.response?.headers.get('retry-after');
    console.log(`Rate limited. Retry after ${retryAfter} seconds`);
    
    // Implement exponential backoff
    await new Promise(resolve => setTimeout(resolve, (retryAfter || 60) * 1000));
    // Retry request
  }
}
```

## Limits

| Resource/Limit | Value | Notes |
|----------------|-------|-------|
| Min requests for analytics | 500 in 48h | For detailed metrics via GraphQL |
| Zones supported | Enterprise+ | Check zone plan in dashboard |
| Billing requirement | Must be configured | Before enabling; verify payment method |
| API rate limit | 1200 req / 5 min | Per API token across all endpoints |
| Spectrum apps | No hard limit | Each app can enable Argo independently |
| Traffic counting | Proxied only | Only orange-clouded DNS records count |
| DDoS/WAF exemption | Yes | Mitigated traffic excluded from billing |
| Analytics latency | 1-5 minutes | Real-time metrics not available |

## Additional Resources

- [Official Argo Smart Routing Docs](https://developers.cloudflare.com/argo-smart-routing/)
- [Cloudflare Smart Shield](https://developers.cloudflare.com/smart-shield/)
- [API Authentication](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)
- [Cloudflare TypeScript SDK](https://github.com/cloudflare/cloudflare-typescript)
- [Cloudflare Python SDK](https://github.com/cloudflare/cloudflare-python)
