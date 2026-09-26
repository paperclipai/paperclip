# Queues Patterns & Best Practices

Fetch the guide matching the task and adapt its example to the application's delivery and failure requirements.

| Task | Documentation |
|------|---------------|
| Accept requests and enqueue asynchronous tasks; publish to multiple queues | [Publish to a Queue via Workers](https://developers.cloudflare.com/queues/examples/publish-to-a-queue-via-workers/) |
| Buffer writes to an external API or defer a job | [Batching, retries, and delays](https://developers.cloudflare.com/queues/configuration/batching-retries/) |
| Handle upstream rate limits and backpressure | [Handle rate limits of external APIs](https://developers.cloudflare.com/queues/tutorials/handle-rate-limits/) and [consumer concurrency](https://developers.cloudflare.com/queues/configuration/consumer-concurrency/) |
| Isolate workloads with different latency or capacity needs | [Configure Queues](https://developers.cloudflare.com/queues/configuration/configure-queues/) |
| Retain exhausted retries for inspection and recovery | [Dead Letter Queues](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/) |
| Process R2 object events | [R2 event notifications](https://developers.cloudflare.com/r2/buckets/event-notifications/) |
| Batch output into R2 | [Use Queues to store data in R2](https://developers.cloudflare.com/queues/examples/send-errors-to-r2/) |
| Batch writes into D1 | [D1 database API](https://developers.cloudflare.com/d1/worker-api/d1-database/) |
| Start durable multi-step jobs | [Trigger Workflows](https://developers.cloudflare.com/workflows/build/trigger-workflows/) |
| Publish from a Durable Object | [Use Queues from Durable Objects](https://developers.cloudflare.com/queues/examples/use-queues-with-durable-objects/) |
| Route consumer work to a Durable Object | [Invoke Durable Object methods](https://developers.cloudflare.com/durable-objects/best-practices/create-durable-object-stubs-and-send-requests/) |

Design side effects for [at-least-once delivery](https://developers.cloudflare.com/queues/reference/delivery-guarantees/). A separate check-then-write deduplication flag is not an atomic guarantee: concurrent delivery or a crash between the side effect and recording completion can repeat work. Prefer idempotency keys or transactional enforcement at the destination.

Acknowledge after the destination confirms success. For fan-out, plan for some sends succeeding before another fails; retries must not duplicate downstream effects. Separate queues can isolate workloads, but do not imply a global priority or ordering guarantee.
