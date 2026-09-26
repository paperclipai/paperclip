# Cloudflare GraphQL Analytics API

Query analytics data across all Cloudflare products via a single GraphQL endpoint. Covers HTTP requests, Workers metrics, DNS, Firewall events, Network Analytics, and 70+ other datasets.

## Overview

- **Single endpoint** for all analytics: `https://api.cloudflare.com/client/v4/graphql`
- **1,400+ schema types** spanning every Cloudflare product
- **Two scopes**: zone-level (per-domain) and account-level (cross-domain)
- **Adaptive sampling** on high-traffic datasets with confidence intervals
- **No mutations** - read-only analytics (the Mutation type is a stub)
- **Cost-based rate limiting** - default 300 queries per 5 minutes per user (max 320, varies by query cost)

## Quick Decision Tree

```
Need analytics data from Cloudflare?
├─ HTTP traffic (requests, bandwidth, cache) → httpRequestsAdaptiveGroups (zone or account)
├─ Workers performance (CPU, wall time, errors) → workersInvocationsAdaptive (account)
├─ Firewall/WAF events → firewallEventsAdaptive / firewallEventsAdaptiveGroups (zone or account)
├─ DNS query analytics → dnsAnalyticsAdaptive / dnsAnalyticsAdaptiveGroups (zone or account)
├─ Network layer (DDoS, Magic Transit) → *NetworkAnalyticsAdaptiveGroups (account)
├─ Storage (R2, KV, D1, DO) → r2OperationsAdaptiveGroups / kvOperationsAdaptiveGroups / etc. (account)
├─ AI (Workers AI, AI Gateway) → aiInferenceAdaptive / aiGatewayRequestsAdaptiveGroups (account)
├─ Load Balancing → loadBalancingRequestsAdaptiveGroups (zone)
├─ Custom high-cardinality metrics → Workers Analytics Engine (see ../analytics-engine/)
└─ Need raw logs, not aggregates → Logpush (see Cloudflare docs)
```

## Core Concepts

| Concept | Description |
|---------|-------------|
| **Endpoint** | `POST https://api.cloudflare.com/client/v4/graphql` |
| **Explorer** | [graphql.cloudflare.com](https://graphql.cloudflare.com/) - interactive query builder |
| **Viewer** | Root query object: `viewer { zones(...) { ... } }` or `viewer { accounts(...) { ... } }` |
| **Dataset (Node)** | A queryable table under a zone or account (e.g., `httpRequestsAdaptiveGroups`) |
| **Dimensions** | Fields to group by (time buckets, country, status code, script name, etc.) |
| **Metrics** | Aggregation fields: `count`, `sum { ... }`, `avg { ... }`, `quantiles { ... }`, `ratio { ... }` |
| **Filter** | Input object constraining results by time range, dimensions, etc. |
| **Limit** | Maximum rows returned per dataset node (required, max varies by dataset) |
| **OrderBy** | Enum-based sorting: `[field_ASC]` or `[field_DESC]` |
| **Adaptive Sampling** | Nodes with `Adaptive` in the name use ABR sampling; results are statistically representative |

## Query Structure

Every query follows this pattern:

```graphql
{
  viewer {
    # Zone-scoped
    zones(filter: { zoneTag: "ZONE_ID" }) {
      datasetName(
        filter: { datetime_gt: "...", datetime_lt: "..." }
        limit: 1000
        orderBy: [datetimeFiveMinutes_DESC]
      ) {
        count
        dimensions { ... }
        sum { ... }
      }
    }
    # Account-scoped
    accounts(filter: { accountTag: "ACCOUNT_ID" }) {
      datasetName(filter: { ... }, limit: 100) {
        count
        dimensions { ... }
        sum { ... }
      }
    }
  }
}
```

## Dataset Naming Convention

Dataset names follow a consistent pattern visible in the schema:

| Pattern | Meaning | Example |
|---------|---------|---------|
| `*Adaptive` | Raw rows with adaptive sampling; some (e.g., `workersInvocationsAdaptive`) also support aggregation fields (`sum`, `quantiles`, `avg`) | `httpRequestsAdaptive`, `workersInvocationsAdaptive` |
| `*AdaptiveGroups` | Aggregated data with adaptive sampling | `httpRequestsAdaptiveGroups` |
| `*1hGroups` | Hourly rollups (pre-aggregated) | `httpRequests1hGroups` |
| `*1dGroups` | Daily rollups (pre-aggregated) | `httpRequests1dGroups` |
| `*1mGroups` | Minutely rollups | `httpRequests1mGroups` |
| `Zone*` prefix | Zone-scoped dataset | `ZoneHttpRequestsAdaptiveGroups` |
| `Account*` prefix | Account-scoped dataset | `AccountWorkersInvocationsAdaptive` |

**Prefer `*AdaptiveGroups` nodes** for most use cases - they support flexible time grouping via dimension fields (`datetimeFiveMinutes`, `datetimeHour`, etc.) and are the most commonly used.

## Key Datasets by Product

### Zone-Scoped (per-domain)

| Dataset | Description |
|---------|-------------|
| `httpRequestsAdaptiveGroups` | HTTP traffic: requests, bytes, cache status, bot scores, WAF scores |
| `httpRequests1hGroups` / `1dGroups` / `1mGroups` | Pre-aggregated HTTP rollups (hourly/daily/minutely) |
| `firewallEventsAdaptiveGroups` | WAF, rate limiting, bot management, firewall rule events |
| `dnsAnalyticsAdaptiveGroups` | DNS query volumes, response codes, query types |
| `loadBalancingRequestsAdaptiveGroups` | Load Balancer origin request metrics |
| `pageShieldReportsAdaptiveGroups` | Page Shield CSP reports |

### Account-Scoped (cross-domain)

| Dataset | Description |
|---------|-------------|
| `workersInvocationsAdaptive` | Workers: requests, errors, CPU time, wall time, subrequests |
| `durableObjectsInvocationsAdaptiveGroups` | DO invocations |
| `durableObjectsStorageGroups` / `durableObjectsPeriodicGroups` | DO storage and periodic metrics |
| `d1AnalyticsAdaptiveGroups` / `d1QueriesAdaptiveGroups` | D1 database analytics |
| `r2OperationsAdaptiveGroups` / `r2StorageAdaptiveGroups` | R2 operations and storage |
| `kvOperationsAdaptiveGroups` / `kvStorageAdaptiveGroups` | KV operations and storage |
| `aiInferenceAdaptiveGroups` | Workers AI inference metrics |
| `aiGatewayRequestsAdaptiveGroups` | AI Gateway request analytics |
| `pagesFunctionsInvocationsAdaptiveGroups` | Pages Functions metrics |
| `magicTransitNetworkAnalyticsAdaptiveGroups` | Magic Transit packet/byte analytics |
| `spectrumNetworkAnalyticsAdaptiveGroups` | Spectrum TCP/UDP analytics |
| `gatewayL7RequestsAdaptiveGroups` | Zero Trust Gateway HTTP metrics |
| `gatewayResolverQueriesAdaptiveGroups` | Zero Trust Gateway DNS metrics |

## Reading Order

| Task | Start Here | Then Read |
|------|------------|-----------|
| **First query** | [configuration.md](configuration.md) (auth) -> this README (structure) | [api.md](api.md) |
| **Build a dashboard** | [patterns.md](patterns.md) (time-series, top-N) | [api.md](api.md) (aggregation fields) |
| **Debug query issues** | [gotchas.md](gotchas.md) | [api.md](api.md) (filtering) |
| **Understand sampling** | [gotchas.md](gotchas.md) (sampling section) | [api.md](api.md) (confidence intervals) |
| **Product-specific metrics** | [patterns.md](patterns.md) (per-product examples) | [api.md](api.md) (dataset reference) |

## In This Reference

- **[api.md](api.md)** - Query structure, aggregation fields (sum/avg/quantiles/count), filtering operators, dimensions, dataset details
- **[configuration.md](configuration.md)** - Authentication, API tokens, client setup (curl, JS, Python), introspection
- **[patterns.md](patterns.md)** - Common queries: time-series, top-N, Workers metrics, HTTP analytics, firewall events, multi-zone
- **[gotchas.md](gotchas.md)** - Rate limits, sampling caveats, query cost, common errors, plan-based limits

## See Also

- [GraphQL Analytics API Docs](https://developers.cloudflare.com/analytics/graphql-api/)
- [GraphQL API Explorer](https://graphql.cloudflare.com/)
- [Observability Reference](../observability/) - Workers Logs, Tail Workers, console logging
- [Analytics Engine Reference](../analytics-engine/) - Custom high-cardinality analytics via Workers
- [Web Analytics Reference](../web-analytics/) - Client-side (RUM) analytics
- [API Reference](../api/) - REST API, SDKs, authentication basics
