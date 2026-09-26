# GraphQL Analytics API Gotchas & Troubleshooting

## Rate Limits

| Limit | Value |
|-------|-------|
| GraphQL queries per user | **Default 300 per 5 minutes** (max 320, at least 1/sec) |
| General API rate limit | 1200 requests per 5 minutes (shared across all API calls) |
| Zone scope per query | Up to **10 zones** |
| Account scope per query | Exactly **1 account** |

The GraphQL rate limit is separate from the general API limit. Exceeding either results in `HTTP 429` and blocks all API calls for 5 minutes. Enterprise customers can contact support to raise limits.

### "429 Too Many Requests"

**Cause:** Exceeded rate limit.

**Solution:** Batch multiple datasets into single queries, cache results, increase intervals between queries. Use `{ viewer { budget } }` to monitor remaining budget.

## Sampling & Data Accuracy

### Adaptive Bit Rate (ABR) Sampling

Datasets with `Adaptive` in the name use adaptive sampling:
- Results are **statistically representative**, not exact
- Same query may return **slightly different numbers** each run
- Higher traffic = higher sampling rate = more accurate
- `sampleInterval` dimension shows the ratio (1 = no sampling, 10 = ~1-in-10 sampled)

For high-confidence numbers, use `confidence(level: 0.95)` to get estimate bounds. For exact counts, use rollup nodes (`httpRequests1hGroups`, `httpRequests1dGroups`) which are pre-aggregated without sampling.

### Rollup vs. Adaptive

| Feature | Rollup (`*1hGroups`, `*1dGroups`) | Adaptive (`*AdaptiveGroups`) |
|---------|-----------------------------------|-----------------------------|
| Sampling | No (pre-aggregated) | Yes (ABR) |
| Flexibility | Fixed time buckets | Any granularity |
| Dimensions | Fewer | Many more |
| Accuracy | Exact | Statistical estimate |

## Common Errors

### "Access denied" / "authentication error"

**Cause:** Token lacks required permission or wrong scope.

**Solution:** Account-scoped queries need **Account Analytics: Read**. Zone-scoped queries need **Zone Analytics: Read**. Verify: `curl -s https://api.cloudflare.com/client/v4/user/tokens/verify -H "Authorization: Bearer $TOKEN"`

### "field not found" / "Cannot query field"

**Cause:** Wrong dataset name, nonexistent field, or wrong scope (zone vs. account).

**Solution:** Names are case-sensitive camelCase (`httpRequestsAdaptiveGroups`). Zone datasets go under `zones(...)`, account datasets under `accounts(...)`. Use introspection to verify.

### "filter is required" / empty results

**Cause:** Missing required time range filter or incorrect zone/account tag.

**Solution:** Always include `datetime_gt` / `datetime_lt` (or `_geq` / `_leq`).

### "limit is required" / "limit exceeds maximum"

**Cause:** Missing `limit` or exceeding node's max page size.

**Solution:** Always specify `limit`. Max varies by dataset (typically 10,000 for groups, 100 for raw events). Check via settings query.

### "query is too complex" / "query exceeds budget"

**Cause:** Too many fields, datasets, or too broad a time range.

**Solution:** Reduce time range, request fewer dimensions/metrics, break into smaller queries. Monitor `cost` and `budget` in responses.

### 200 Response with Errors

GraphQL returns HTTP 200 even on failures. **Always check `response.errors`:**

```json
{ "data": null, "errors": [{ "message": "filter is required for httpRequestsAdaptiveGroups" }] }
```

## Plan-Based Availability

Not all datasets are available on all plans. Higher plans get more datasets, longer retention (`notOlderThan`), wider time ranges (`maxDuration`), more fields, and larger page sizes.

### "node is not available" / "node is disabled"

**Cause:** Dataset not on your plan, or product not enabled.

**Solution:** Check `settings { <nodeName> { enabled } }`. Some datasets require specific subscriptions (e.g., Network Analytics requires Magic Transit/Spectrum).

## DateTime & Timezone Handling

- All times are **UTC only** (ISO 8601: `"2025-01-15T10:30:00Z"`)
- `Date` type: `"2025-01-15"` (used in `date_geq`/`date_leq` for storage datasets)
- `Time` type: `"2025-01-15T10:30:00Z"` (used in `datetime_gt`/`datetime_lt`)
- Filters are start-inclusive: events that start within the window are included

## Performance Tips

- **Narrow time ranges** are faster and cheaper
- **Select only needed dimensions** — each additional dimension increases cost
- **Use rollup nodes** (`*1dGroups`) for simple daily totals without dimension breakdowns
- **Batch datasets** into one query instead of separate HTTP requests

## See Also

- [README.md](README.md) - Overview, decision tree, dataset index
- [api.md](api.md) - Query structure, aggregation fields, filtering operators
- [configuration.md](configuration.md) - Authentication, client setup, introspection queries
- [patterns.md](patterns.md) - Common query patterns (time-series, top-N, per-product)
