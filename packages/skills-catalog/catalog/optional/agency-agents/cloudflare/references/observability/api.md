# Observability APIs

Fetch the applicable reference for current signatures, field locations, units, authentication, and query syntax. Do not infer the Tail event schema from an OpenTelemetry span or a Logpush record.

| Task | Maintained documentation |
| --- | --- |
| Emit console messages and check supported methods | [Console API](https://developers.cloudflare.com/workers/runtime-apis/console/) |
| Filter, group, and aggregate stored Workers Logs | [Query Builder](https://developers.cloudflare.com/workers/observability/query-builder/) |
| Query built-in Workers metrics with GraphQL | [Querying Workers metrics](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/) |
| Define Analytics Engine fields and call `writeDataPoint()` | [Write data points](https://developers.cloudflare.com/analytics/analytics-engine/get-started/) |
| Authenticate and query Analytics Engine datasets | [SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/) |
| Calculate counts, sums, and averages on sampled events | [Analytics Engine sampling](https://developers.cloudflare.com/analytics/analytics-engine/sampling/) |
| Implement a Tail consumer and inspect event properties | [Tail handler API](https://developers.cloudflare.com/workers/runtime-apis/handlers/tail/) |
| Create and manage Logpush jobs | [Logpush API configuration](https://developers.cloudflare.com/logs/logpush/logpush-job/api-configuration/) |
| Select exported Workers event fields | [Workers Trace Events dataset](https://developers.cloudflare.com/logs/logpush/logpush-job/datasets/account/workers_trace_events/) |
| Export OTLP logs and traces | [OpenTelemetry export](https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/) |

Keep dataset field meanings and units consistent between writers and queries. Follow the SQL reference linked from the SQL API for supported date bucketing and aggregate functions; do not assume another SQL dialect's syntax works here. Account for sampling in averages as well as counts and sums.

See [configuration.md](configuration.md) for setup and [patterns.md](patterns.md) for application-level decisions.
