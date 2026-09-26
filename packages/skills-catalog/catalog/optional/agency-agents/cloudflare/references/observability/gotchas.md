# Observability Troubleshooting and Constraints

## Missing or incomplete data

| Symptom | Check and authoritative guide |
| --- | --- |
| Logs missing from the dashboard | Confirm the deployed Worker/environment, collection and persistence settings, recent traffic, query time range, and sampling. Follow [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) and [Query Builder](https://developers.cloudflare.com/workers/observability/query-builder/). |
| Live logs differ from stored logs | Confirm which workflow is being inspected; live streams can sample under load. See [real-time logs](https://developers.cloudflare.com/workers/observability/logs/real-time-logs/). |
| Traces missing or incomplete | Check trace enablement and sampling separately from logs, then consult [tracing setup](https://developers.cloudflare.com/workers/observability/traces/) and [known limitations](https://developers.cloudflare.com/workers/observability/traces/known-limitations/). |
| Export destination has no data | Check signal type, destination name, credentials, endpoint compatibility, and provider status using [OpenTelemetry export](https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/). For a Logpush job, use [Workers Logpush](https://developers.cloudflare.com/workers/observability/logs/logpush/). |
| Tail consumer receives no events | Check the producer's consumer configuration and deployment using [Tail Workers](https://developers.cloudflare.com/workers/observability/logs/tail-workers/). |
| Analytics Engine totals or averages look wrong | Account for sample weights and consistent field meanings using [sampling guidance](https://developers.cloudflare.com/analytics/analytics-engine/sampling/). Check [limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/) for missing writes or expired data. |
| Very short operations appear to take no time | Read [performance and timers](https://developers.cloudflare.com/workers/runtime-apis/performance/) and [trace limitations](https://developers.cloudflare.com/workers/observability/traces/known-limitations/). Tracing does not eliminate the runtime's timing restrictions. |

## Limits, retention, and cost

Fetch these pages when estimating cost or diagnosing truncation and missing data:

- [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/): log size, retention, sampling, and pricing.
- [Workers Traces](https://developers.cloudflare.com/workers/observability/traces/) and [known limitations](https://developers.cloudflare.com/workers/observability/traces/known-limitations/): availability, propagation, and instrumentation constraints.
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/): current observability and Tail Worker billing terms.
- [Analytics Engine limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/) and [pricing](https://developers.cloudflare.com/analytics/analytics-engine/pricing/): field/write limits, retention, query costs, and billing availability.
- [Workers Logpush](https://developers.cloudflare.com/workers/observability/logs/logpush/): Workers-specific eligibility, permissions, and pricing.

Sampling reduces coverage as well as volume. Do not interpret the absence of a sampled event as proof that an error did not happen. Keep required diagnostic context while avoiding credentials, full sensitive URLs, and unnecessary personal data in logs, custom dimensions, and exported records.
