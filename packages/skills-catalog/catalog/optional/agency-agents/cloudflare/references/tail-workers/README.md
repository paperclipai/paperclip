# Cloudflare Tail Workers

Use Tail Workers when execution events need custom processing. Fetch the current documentation before implementing handlers, configuration, or integrations.

| Task | Documentation |
| --- | --- |
| Decide whether custom processing is needed | [Tail Workers](https://developers.cloudflare.com/workers/observability/logs/tail-workers/) |
| Export logs and traces to an observability destination | [Exporting OpenTelemetry Data](https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/) |
| Inspect a deployment interactively | [Real-time logs](https://developers.cloudflare.com/workers/observability/logs/real-time-logs/) |
| Implement the consumer | [Tail handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/tail/) |

Before adding a Tail Worker, check whether built-in OpenTelemetry export meets the destination’s needs. Use the Tail Workers guide for the tradeoff, then identify the custom filtering or transformation that remains necessary.

## In This Reference

- [configuration.md](./configuration.md) — producer, consumer, destination, and environment setup
- [api.md](./api.md) — event fields, execution outcomes, and redaction
- [patterns.md](./patterns.md) — destination and filtering decisions
- [gotchas.md](./gotchas.md) — connection, data, and delivery investigation

See [observability](../observability/README.md) for broader logging and tracing choices.
