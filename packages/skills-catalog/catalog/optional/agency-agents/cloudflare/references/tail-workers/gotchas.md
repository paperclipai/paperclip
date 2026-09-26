# Tail Workers Troubleshooting

Trace one known producer invocation through consumer execution and destination receipt to locate the failure.

| Task | Documentation |
| --- | --- |
| Consumer receives no events or producer setup fails | [Configure Tail Workers](https://developers.cloudflare.com/workers/observability/logs/tail-workers/#configure-tail-workers) |
| Async processing or event interpretation is incorrect | [Tail handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/tail/) |
| Filters confuse HTTP responses with execution failures | [TailItems](https://developers.cloudflare.com/workers/runtime-apis/handlers/tail/#tailitems) |
| Request data is missing or unexpectedly retained | [TailRequest](https://developers.cloudflare.com/workers/runtime-apis/handlers/tail/#tailrequest) |
| Inspect producer and consumer execution | [Real-time logs](https://developers.cloudflare.com/workers/observability/logs/real-time-logs/) |
| Reconsider a custom exporter at higher volume | [Exporting OpenTelemetry Data](https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/) |

Verify producer configuration, consumer identity, and destination credentials independently. Include both handled error responses and thrown exceptions when checking filters. Make destination failures observable without exposing the payload or credentials in diagnostic logs. Do not infer retention, retries, or batch guarantees from an example.

See [api.md](./api.md) for data contracts and [patterns.md](./patterns.md) for destination decisions.
