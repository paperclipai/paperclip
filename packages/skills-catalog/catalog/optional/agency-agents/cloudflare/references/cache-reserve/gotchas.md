# Cache Reserve Gotchas

## Common Errors

### "Assets Not Being Cached in Cache Reserve"

**Cause:** Asset is not cacheable, TTL < 10 hours, Content-Length header missing, or blocking headers present (Set-Cookie, Vary: *)  
**Solution:** Ensure minimum TTL of 10+ hours (`Cache-Control: public, max-age=36000`), add Content-Length header, remove Set-Cookie header, and set `Vary: Accept-Encoding` (not *)

### "Range Requests Not Working" (Video Seeking Fails)

**Cause:** Cache Reserve does **NOT** support range requests (HTTP 206 Partial Content)  
**Solution:** Range requests bypass Cache Reserve entirely. For video streaming with seeking:
- Use edge cache only (shorter TTLs)
- Consider R2 with direct access for range-heavy workloads
- Accept that seekable content won't benefit from Cache Reserve persistence

### "Origin Bandwidth Higher Than Expected"

**Cause:** Cache Reserve fetches **uncompressed** content from origin, even though it serves compressed to visitors  
**Solution:** 
- If origin charges by bandwidth, factor in uncompressed transfer costs
- Cache Reserve compresses for visitors automatically (saves visitor bandwidth)
- Compare: origin egress savings vs higher uncompressed fetch costs

### "Cloudflare Images Not Caching with Cache Reserve"

**Cause:** Cloudflare Images with `Vary: Accept` header (format negotiation) is incompatible with Cache Reserve  
**Solution:** 
- Cache Reserve silently skips images with Vary for format negotiation
- Original images (non-transformed) may still be eligible
- Use Cloudflare Images variants or edge cache for transformed images

### "High Class A Operations Costs"

**Cause:** Frequent cache misses, short TTLs, or frequent revalidation  
**Solution:** Increase TTL for stable content (24+ hours), enable Tiered Cache to reduce direct Cache Reserve misses, or use stale-while-revalidate

### "Purge Not Working as Expected"

**Cause:** Purge by tag only triggers revalidation but doesn't remove from Cache Reserve storage  
**Solution:** Use purge by URL for immediate removal, or disable Cache Reserve then clear all data for complete removal

### "O2O (Orange-to-Orange) Assets Not Caching"

**Cause:** Orange-to-Orange (proxied zone requesting another proxied zone on Cloudflare) bypasses Cache Reserve  
**Solution:** 
- **What is O2O**: Zone A (proxied) → Zone B (proxied), both on Cloudflare
- **Detection**: Check `cf-cache-status` for `BYPASS` and review request path
- **Workaround**: Use R2 or direct origin access instead of O2O proxy chains

### "Cache Reserve must be OFF before clearing data"

**Cause:** Attempting to clear Cache Reserve data while it's still enabled  
**Solution:** Disable Cache Reserve first, wait briefly for propagation (5s), then clear data (can take up to 24 hours)

## Limits

| Limit | Value | Notes |
|-------|-------|-------|
| Minimum TTL | 10 hours (36000 seconds) | Assets with shorter TTL not eligible |
| Default retention | 30 days (2592000 seconds) | Configurable |
| Maximum file size | Same as R2 limits | No practical limit |
| Purge/clear time | Up to 24 hours | Complete propagation time |
| Plan requirement | Paid Cache Reserve or Smart Shield | Not available on free plans |
| Content-Length header | Required | Must be present for eligibility |
| Set-Cookie header | Blocks caching | Must not be present (or use private directive) |
| Vary header | Cannot be * | Can use Vary: Accept-Encoding |
| Image transformations | Variants not eligible | Original images only |
| Range requests | NOT supported | HTTP 206 bypasses Cache Reserve |
| Compression | Fetches uncompressed | Serves compressed to visitors |
| Worker control | Zone-level only | Cannot control per-request |
| O2O requests | Bypassed | Orange-to-Orange not eligible |

## Additional Resources

- **Official Docs**: https://developers.cloudflare.com/cache/advanced-configuration/cache-reserve/
- **API Reference**: https://developers.cloudflare.com/api/resources/cache/subresources/cache_reserve/
- **Cache Rules**: https://developers.cloudflare.com/cache/how-to/cache-rules/
- **Workers Cache API**: https://developers.cloudflare.com/workers/runtime-apis/cache/
- **R2 Documentation**: https://developers.cloudflare.com/r2/
- **Smart Shield**: https://developers.cloudflare.com/smart-shield/
- **Tiered Cache**: https://developers.cloudflare.com/cache/how-to/tiered-cache/

## Troubleshooting Flowchart

Asset not caching in Cache Reserve?

```
1. Is Cache Reserve enabled for zone?
   → No: Enable via Dashboard or API
   → Yes: Continue to step 2

2. Is Tiered Cache enabled?
   → No: Enable Tiered Cache (required!)
   → Yes: Continue to step 3

3. Does asset have TTL ≥ 10 hours?
   → No: Increase via Cache Rules (edge_ttl override)
   → Yes: Continue to step 4

4. Is Content-Length header present?
   → No: Fix origin to include Content-Length
   → Yes: Continue to step 5

5. Is Set-Cookie header present?
   → Yes: Remove Set-Cookie or scope appropriately
   → No: Continue to step 6

6. Is Vary header set to *?
   → Yes: Change to specific value (e.g., Accept-Encoding)
   → No: Continue to step 7

7. Is this a range request?
   → Yes: Range requests bypass Cache Reserve (not supported)
   → No: Continue to step 8

8. Is this an O2O (Orange-to-Orange) request?
   → Yes: O2O bypasses Cache Reserve
   → No: Continue to step 9

9. Check Logpush CacheReserveUsed field
   → Filter logs to see if assets ever hit Cache Reserve
   → Verify cf-cache-status header (should be HIT after first request)
```

## See Also

- [README](./README.md) - Overview and core concepts
- [Configuration](./configuration.md) - Setup and Cache Rules
- [API Reference](./api.md) - Purging and monitoring
- [Patterns](./patterns.md) - Best practices and optimization
