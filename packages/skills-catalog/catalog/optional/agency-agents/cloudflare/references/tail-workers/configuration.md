# Tail Workers Configuration

Identify the producer Worker and consumer Worker as separate deployment resources before changing their configuration.

| Task | Documentation |
| --- | --- |
| Connect a producer to a Tail Worker | [Configure Tail Workers](https://developers.cloudflare.com/workers/observability/logs/tail-workers/#configure-tail-workers) |
| Configure environments and resource bindings | [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/) |
| Configure destination credentials | [Secrets](https://developers.cloudflare.com/workers/configuration/secrets/) |
| Use built-in telemetry destinations instead | [Exporting OpenTelemetry Data](https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/) |
| Check availability and billing model | [Tail Workers](https://developers.cloudflare.com/workers/observability/logs/tail-workers/) |
| Check runtime capacity | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Check the handler required by the consumer | [Tail handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/tail/) |

Confirm which project owns each deployment and which environment the destination belongs to. Verify a known producer request reaches the intended destination before expanding coverage. See [api.md](./api.md) for payload handling and [gotchas.md](./gotchas.md) for investigation.
