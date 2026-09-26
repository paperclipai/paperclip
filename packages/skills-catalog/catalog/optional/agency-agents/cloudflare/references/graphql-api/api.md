# GraphQL Analytics API Reference

## Query Root

The schema has a single entry point: `Query.viewer`. Mutations are not supported.

```graphql
{
  cost       # uint64 -- query cost (returned in response)
  viewer {
    budget   # uint64 -- remaining budget
    zones(filter: { zoneTag: "..." }) { ... }
    accounts(filter: { accountTag: "..." }) { ... }
  }
}
```

## Aggregation Fields

Aggregated dataset nodes (`*Groups`) return these field categories. Not every node has all — use introspection to check.

### count

Total events in the group. Available on `*Groups` nodes but **not** on raw `*Adaptive` nodes (e.g., `workersInvocationsAdaptive` — use `sum { requests }` instead).

### sum

Cumulative metrics. Fields vary by dataset:

```graphql
# HTTP requests
sum { edgeResponseBytes edgeRequestBytes visits edgeTimeToFirstByteMs originResponseDurationMs }

# Workers invocations
sum { requests errors subrequests cpuTimeUs wallTime duration responseBodySize clientDisconnects requestDuration }
```

### quantiles

Percentile distributions (on datasets like `workersInvocationsAdaptive`). Available percentiles: P25, P50, P75, P90, P95, P99, P999 for `cpuTime`, `wallTime`, `requestDuration`, `duration`, `responseBodySize`.

```graphql
quantiles { cpuTimeP50 cpuTimeP99 wallTimeP50 wallTimeP99 }
```

### ratio, avg, uniq, confidence

```graphql
ratio { status4xx status5xx }      # float64 (0 to 1) -- HTTP datasets only
avg { sampleInterval }              # useful for understanding sampling resolution
uniq { uniques }                    # unique IP count -- rollup datasets (*1hGroups, *1dGroups) only
confidence(level: 0.95) {           # Adaptive datasets only; works on count and sum fields
  count { estimate lower upper sampleSize }
}
```

## Dimensions

Dimensions are fields you can group by via the `dimensions` sub-selection.

### Time Dimensions

| Dimension | Granularity |
|-----------|------------|
| `date` | Day |
| `datetime` | Exact timestamp |
| `datetimeMinute` | 1 minute |
| `datetimeFiveMinutes` | 5 minutes |
| `datetimeFifteenMinutes` | 15 minutes |
| `datetimeHour` | 1 hour |

Workers datasets also support `datetimeSixHours`.

### HTTP Request Dimensions (httpRequestsAdaptiveGroups)

83 dimensions available. Key ones:

| Dimension | Description |
|-----------|-------------|
| `clientCountryName` | Country of origin |
| `clientRequestHTTPHost` | Requested hostname |
| `clientRequestHTTPMethodName` | HTTP method |
| `clientRequestPath` | URI path |
| `edgeResponseStatus` | Edge HTTP status code |
| `cacheStatus` | Cache status (hit, miss, dynamic, etc.) |
| `coloCode` | Cloudflare datacenter IATA code |
| `clientIP` / `clientAsn` | Client IP address / ASN |
| `botScore` / `botManagementDecision` | Bot management score (0-99) / verdict |
| `wafAttackScore` / `securityAction` | WAF score / firewall action taken |
| `ja3Hash` / `ja4` | TLS fingerprints |
| `sampleInterval` | ABR sample interval |

### Workers Dimensions (workersInvocationsAdaptive)

`scriptName`, `scriptTag`, `scriptVersion`, `environmentName`, `status`, `usageModel`, `coloCode`, `dispatchNamespaceName`, `isDispatcher`

### Firewall Dimensions (firewallEventsAdaptive)

`action`, `source`, `ruleId`, `clientCountryName`, `clientIP`, `clientAsn`, `userAgent`

## Filtering

### Scope Filters

```graphql
zones(filter: { zoneTag: "ZONE_ID" })           # up to 10 zones
zones(filter: { zoneTag_in: ["Z1", "Z2"] })
accounts(filter: { accountTag: "ACCOUNT_ID" })   # exactly 1 account
```

### Dataset Filters

**Always include a time range filter.** Multiple filters at the same level are implicitly AND-ed.

```graphql
httpRequestsAdaptiveGroups(
  filter: { datetime_gt: "2025-01-01T00:00:00Z", datetime_lt: "2025-01-02T00:00:00Z", clientCountryName: "US" }
  limit: 1000
)
```

### Filter Operators

| Operator | Meaning | Example |
|----------|---------|---------|
| (none) | equals | `clientCountryName: "US"` |
| `_gt` / `_lt` | greater / less than | `datetime_gt: "..."` |
| `_geq` / `_leq` | greater/less or equal | `datetime_geq: "..."` |
| `_neq` | not equal | `cacheStatus_neq: "hit"` |
| `_in` / `_notin` | in / not in list | `clientCountryName_in: ["US", "GB"]` |
| `_like` / `_notlike` | SQL LIKE with `%` | `clientRequestPath_like: "/api/%"` |
| `_has` / `_hasall` / `_hasany` | array contains | `botDetectionIds_has: "abc"` |

> `_notin` and `_notlike` are in the schema but not in official docs. Confirmed via introspection.

### Boolean Operators (AND / OR)

```graphql
# Explicit AND
filter: { AND: [{ datetime_gt: "..." }, { datetime_lt: "..." }, { clientCountryName: "US" }] }

# Explicit OR
filter: { datetime_gt: "...", OR: [{ edgeResponseStatus: 403 }, { edgeResponseStatus: 429 }] }
```

## Pagination & Sorting

No cursor-based pagination. Use `limit`, `orderBy`, and filter-based offsets:

```graphql
# First page
httpRequestsAdaptiveGroups(filter: { datetime_gt: "..." }, limit: 100, orderBy: [datetime_ASC])

# Next page: filter by last seen value from previous page
httpRequestsAdaptiveGroups(filter: { datetime_gt: "2025-01-01T01:35:00Z" }, limit: 100, orderBy: [datetime_ASC])
```

Sort with `orderBy: [field_ASC]` or `[field_DESC]`. Multiple sort fields supported.

## Settings Node

Query per-node limits and availability:

```graphql
viewer { zones(filter: { zoneTag: "..." }) { settings {
  httpRequestsAdaptiveGroups { enabled maxDuration maxNumberOfFields maxPageSize notOlderThan }
} } }
```

## See Also

- [README.md](README.md) - Overview, decision tree, dataset index
- [configuration.md](configuration.md) - Authentication, client setup, introspection queries
- [patterns.md](patterns.md) - Common query patterns (time-series, top-N, per-product)
- [gotchas.md](gotchas.md) - Rate limits, sampling, troubleshooting
