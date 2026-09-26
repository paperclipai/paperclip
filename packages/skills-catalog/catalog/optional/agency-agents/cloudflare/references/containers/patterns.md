# Containers patterns

Choose instance identity based on the workload: per-user/session or per-job identities for affinity, one shared identity for a singleton, and interchangeable instances for stateless requests. Read [scaling and routing](https://developers.cloudflare.com/containers/configuration/scaling-and-routing/) for current helpers and scaling behavior before implementing that choice.

| Task | Documentation |
| --- | --- |
| Distribute requests across stateless instances | [Stateless instances example](https://developers.cloudflare.com/containers/examples/stateless/) |
| Forward WebSocket connections | [WebSocket example](https://developers.cloudflare.com/containers/examples/websocket/) |
| React to lifecycle changes | [Status hooks example](https://developers.cloudflare.com/containers/examples/status-hooks/) |
| Handle shutdown and persist data across restarts | [Container lifecycle](https://developers.cloudflare.com/containers/concepts/architecture/) and [Container interface](https://developers.cloudflare.com/containers/reference/container-class/) |
| Keep long operations active or schedule callbacks | [Activity renewal](https://developers.cloudflare.com/containers/reference/container-class/#renewactivitytimeout) and [scheduling](https://developers.cloudflare.com/containers/reference/container-class/#scheduling) |
| Start containers on a cron schedule | [Cron container example](https://developers.cloudflare.com/containers/examples/cron/) |
| Route requests to multiple ports | [Request methods](https://developers.cloudflare.com/containers/reference/container-class/#request-methods) and [utility functions](https://developers.cloudflare.com/containers/reference/container-class/#utility-functions) |
| Access Workers bindings from the container | [Connect to Workers and bindings](https://developers.cloudflare.com/containers/configuration/workers-connections/) |

## Workflows and Queues

For multi-step orchestration, combine the [Workflows Workers API](https://developers.cloudflare.com/workflows/build/workers-api/) with the [Container API](api.md). For queue-driven jobs, read the [Queues consumer API](https://developers.cloudflare.com/queues/configuration/javascript-apis/#consumer) and [acknowledgement and retry behavior](https://developers.cloudflare.com/queues/configuration/batching-retries/#explicit-acknowledgement-and-retries) alongside the Container API. These pages document the component APIs; they are not end-to-end Container integration examples.
