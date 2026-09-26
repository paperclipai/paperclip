# GraphQL Analytics API Patterns & Best Practices

## Time-Series Queries

Use time dimension granularity matching your range (see Best Practices below).

```graphql
query TrafficTimeSeries($zoneTag: string!, $start: Time!, $end: Time!) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      httpRequestsAdaptiveGroups(
        filter: { datetime_gt: $start, datetime_lt: $end }
        limit: 1000
        orderBy: [datetimeFiveMinutes_ASC]  # or datetimeHour_ASC for longer ranges
      ) {
        count
        dimensions { datetimeFiveMinutes }
        sum { edgeResponseBytes }
        ratio { status4xx status5xx }
      }
    }
  }
}
```

## Top-N Queries

### Top Countries by Request Count

```graphql
query TopCountries($zoneTag: string!, $start: Time!, $end: Time!) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      httpRequestsAdaptiveGroups(
        filter: { datetime_gt: $start, datetime_lt: $end }
        limit: 10
        orderBy: [count_DESC]
      ) {
        count
        dimensions { clientCountryName }
      }
    }
  }
}
```

Use `orderBy: [sum_edgeResponseBytes_DESC]` for top paths by bandwidth. Add `edgeResponseStatus_geq: 400` to the filter for top error status codes.

## Workers Analytics

```graphql
query WorkersOverview($accountTag: string!, $start: Time!, $end: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      workersInvocationsAdaptive(
        filter: { datetime_gt: $start, datetime_lt: $end }
        limit: 100
        orderBy: [sum_requests_DESC]
      ) {
        sum { requests errors subrequests wallTime }
        quantiles { cpuTimeP50 cpuTimeP99 wallTimeP50 wallTimeP99 }
        dimensions { scriptName }
      }
    }
  }
}
```

Filter by `scriptName` for a specific Worker. Add `datetimeFiveMinutes` dimension + `orderBy: [datetimeFiveMinutes_ASC]` for error rate over time.

## Firewall / Security

```graphql
query RecentFirewallEvents($zoneTag: string!, $start: Time!) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      firewallEventsAdaptive(
        filter: { datetime_gt: $start }
        limit: 50
        orderBy: [datetime_DESC]
      ) {
        action source clientIP clientCountryName userAgent
        clientRequestHTTPHost clientRequestPath ruleId datetime
      }
    }
  }
}
```

For aggregated firewall stats, use `firewallEventsAdaptiveGroups` with `action: "block"` filter and group by `ruleId`, `source`, `datetimeHour`.

## DNS Analytics

```graphql
query DNSQueryVolume($zoneTag: string!, $start: Time!, $end: Time!) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      dnsAnalyticsAdaptiveGroups(
        filter: { datetime_gt: $start, datetime_lt: $end }
        limit: 500
        orderBy: [datetimeFiveMinutes_ASC]
      ) {
        count
        dimensions { datetimeFiveMinutes }
      }
    }
  }
}
```

## Storage Analytics (Account-Scoped)

R2, KV, and D1 use `date` (Date type) filters instead of `datetime` (Time type).

```graphql
# R2 operations
r2OperationsAdaptiveGroups(filter: { date_geq: $start, date_leq: $end }, limit: 100, orderBy: [date_DESC]) {
  dimensions { date bucketName actionType }
  sum { requests }
}

# KV operations
kvOperationsAdaptiveGroups(filter: { date_geq: $start, date_leq: $end }, limit: 100, orderBy: [date_DESC]) {
  dimensions { date actionType }
  sum { requests }
}

# D1 analytics
d1AnalyticsAdaptiveGroups(filter: { date_geq: $start, date_leq: $end }, limit: 100, orderBy: [date_DESC]) {
  dimensions { date databaseId }
  sum { readQueries writeQueries rowsRead rowsWritten }
}
```

## Cache Analytics

```graphql
query CacheStatusBreakdown($zoneTag: string!, $start: Time!, $end: Time!) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      httpRequestsAdaptiveGroups(
        filter: { datetime_gt: $start, datetime_lt: $end }
        limit: 20
        orderBy: [count_DESC]
      ) {
        count
        dimensions { cacheStatus }
        sum { edgeResponseBytes }
      }
    }
  }
}
```

For cache hit ratio over time, use aliases to query the same dataset twice — once with `cacheStatus: "hit"` filter and once without — then compute the ratio client-side.

## Multi-Dataset Queries

A single request can query multiple datasets, avoiding extra HTTP round-trips:

```graphql
query DashboardOverview($zoneTag: string!, $start: Time!, $end: Time!) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      httpTraffic: httpRequestsAdaptiveGroups(
        filter: { datetime_gt: $start, datetime_lt: $end }, limit: 1
      ) { count  sum { edgeResponseBytes }  ratio { status4xx status5xx } }
      firewallEvents: firewallEventsAdaptiveGroups(
        filter: { datetime_gt: $start, datetime_lt: $end }, limit: 5, orderBy: [count_DESC]
      ) { count  dimensions { action source } }
      dnsQueries: dnsAnalyticsAdaptiveGroups(
        filter: { datetime_gt: $start, datetime_lt: $end }, limit: 1
      ) { count }
    }
  }
}
```

## AI & Gateway Analytics

```graphql
# Workers AI inference
aiInferenceAdaptiveGroups(
  filter: { datetime_gt: $start, datetime_lt: $end }, limit: 100, orderBy: [datetimeHour_DESC]
) {
  count
  sum { totalInputTokens totalOutputTokens totalRequestBytesIn }
  dimensions { modelId datetimeHour }
}

# AI Gateway requests
aiGatewayRequestsAdaptiveGroups(
  filter: { datetime_gt: $start, datetime_lt: $end }, limit: 100, orderBy: [datetimeHour_DESC]
) {
  count
  dimensions { gateway provider model datetimeHour }
  sum { cachedTokensIn cachedTokensOut uncachedTokensIn uncachedTokensOut }
}
```

Both are account-scoped — nest under `accounts(filter: { accountTag: $accountTag })`.

## Best Practices

**Always include time filters.** Queries without time filters scan all data and are slow/expensive.

**Match time granularity to range:**

| Time Range | Recommended Dimension |
|------------|----------------------|
| < 6 hours | `datetimeMinute` or `datetimeFiveMinutes` |
| 6-48 hours | `datetimeFiveMinutes` or `datetimeFifteenMinutes` |
| 2-14 days | `datetimeHour` |
| 14+ days | `date` |

**Use aliases** for querying the same dataset with different filters in one request.

**Request only needed fields.** Extra dimensions and metrics increase query cost.

## See Also

- [README.md](README.md) - Overview, decision tree, dataset index
- [api.md](api.md) - Query structure, aggregation fields, filtering operators
- [configuration.md](configuration.md) - Authentication, client setup, introspection queries
- [gotchas.md](gotchas.md) - Rate limits, sampling, troubleshooting
