# Cloudflare Queues

Use Queues to decouple producers from asynchronous consumers and buffer bursts of work. Design consumers for duplicate delivery; use Workflows when the task needs durable multi-step orchestration.

Fetch the relevant documentation below before implementing. Treat current Cloudflare docs as the source of truth for API signatures, acknowledgement semantics, configuration, limits, and pricing.

## Choose a consumer

- Use a Worker push consumer when processing runs on Workers.
- Use an HTTP pull consumer when processing runs in another environment; plan for polling, visibility timeouts, and acknowledgement leases.
- Choose a message encoding the consumer can decode. Check serialization and compatibility-date behavior before sending existing application objects.

See [How Queues works](https://developers.cloudflare.com/queues/reference/how-queues-works/) and [delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/) before choosing ordering or deduplication strategies.

## Read by task

| Task | Reference |
|------|-----------|
| Create queues, bind producers, and configure consumers | [configuration.md](./configuration.md) |
| Send messages and implement acknowledgement or retries | [api.md](./api.md) |
| Buffer APIs, defer jobs, or integrate with storage and orchestration | [patterns.md](./patterns.md) |
| Diagnose delivery failures, duplicates, or capacity issues | [gotchas.md](./gotchas.md) |

For a first application, fetch [Getting started](https://developers.cloudflare.com/queues/get-started/). Retrieve [limits](https://developers.cloudflare.com/queues/platform/limits/) and [pricing](https://developers.cloudflare.com/queues/platform/pricing/) before sizing throughput, retention, or cost; plan-specific values are not maintained here.
