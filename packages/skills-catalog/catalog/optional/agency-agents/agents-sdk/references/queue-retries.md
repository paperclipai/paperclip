# Queue & Retries

Read the current Cloudflare documentation for queue management, retry options, defaults, and callback examples.

| Task | Documentation |
|------|---------------|
| Enqueue, inspect, and remove background work; understand sequential processing and failure handling | [Queue tasks](https://developers.cloudflare.com/agents/runtime/execution/queue-tasks/) |
| Retry an operation or configure retries for queued and scheduled callbacks | [Retries](https://developers.cloudflare.com/agents/runtime/execution/retries/) |
| Delay recovery or run work on a recurring schedule | [Schedule tasks](https://developers.cloudflare.com/agents/runtime/execution/schedule-tasks/) |

Keep these execution choices in mind when using the linked guides:

- Use the built-in queue for sequential background work. Retries block later queue items; use scheduling for long recovery waits.
- Retry delays keep the Durable Object active. Choose retry budgets with execution cost and latency in mind.
- Queued items are removed after their retry budget is exhausted; there is no built-in dead-letter queue. Record failures explicitly when the application needs recovery or auditing.
- The selective retry predicate is available on `this.retry()`, not serialized queue or schedule options. Handle non-retryable errors in those callbacks.

See [state-scheduling.md](state-scheduling.md) for choosing schedule modes and persisting application state.
