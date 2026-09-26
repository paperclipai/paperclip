# Tail Workers Processing Decisions

Define the destination contract and required event coverage before writing transformations.

| Task | Documentation |
| --- | --- |
| Export supported telemetry without a custom consumer | [Exporting OpenTelemetry Data](https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/) |
| Process and forward custom execution events | [Tail Workers](https://developers.cloudflare.com/workers/observability/logs/tail-workers/) |
| Aggregate metrics rather than retain individual events | [Analytics Engine from Tail Workers](https://developers.cloudflare.com/workers/observability/logs/tail-workers/#use-analytics-engine-for-aggregated-metrics) |
| Choose filters based on execution and request fields | [Tail handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/tail/) |
| Review sensitive request data handling | [TailRequest](https://developers.cloudflare.com/workers/runtime-apis/handlers/tail/#tailrequest) |

Decide which producers, routes, failures, and successful requests each destination needs. If sampling is appropriate, specify how it affects the questions the data must answer. Minimize retained fields, test transformation and serialization against representative events, and check destination rejection behavior.

Keep producer identity when combining events from multiple Workers. Define how delivery failures become visible before adding fallback storage or batching infrastructure. See [configuration.md](./configuration.md) for deployment ownership.
