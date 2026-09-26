# Gotchas & Debugging

Start with the failing instance and step, then fetch the relevant guide before changing code or resource limits.

| Symptom or question | What to check |
| --- | --- |
| Step timeout or repeated failure | [Sleeping and retrying](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/) for per-attempt timeout, retry policy, and non-retryable failures |
| CPU exhaustion despite a short run | [Limits](https://developers.cloudflare.com/workflows/reference/limits/) for active CPU budgets; increasing an elapsed-time timeout does not increase CPU capacity |
| Missing event or event timeout | [Events and parameters](https://developers.cloudflare.com/workflows/build/events-and-parameters/) for instance targeting, event type/payload requirements, and timeout handling |
| State disappears or branches change after resuming | [Rules of Workflows](https://developers.cloudflare.com/workflows/build/rules-of-workflows/) for persisted step returns, deterministic names and conditionals, and awaited operations |
| Duplicate charge, write, or notification | Review the destination's idempotency guarantees and [step design](./patterns.md#design-decisions); retries can repeat an external operation even when its previous attempt committed |
| Instance ID collision or unexpected batch result | [Workers API](https://developers.cloudflare.com/workflows/build/workers-api/) for creation semantics, plus [limits](https://developers.cloudflare.com/workflows/reference/limits/) for retention |
| Oversized results, queued instances, or missing historical data | [Limits](https://developers.cloudflare.com/workflows/reference/limits/) for return/event sizes, concurrency, creation rates, and retention; export required long-term results before expiry |
| Local-only failure or failing introspection test | [Local development](https://developers.cloudflare.com/workflows/build/local-development/) and [Workflow test APIs](https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/#workflows) |
| Inspect execution and cost | [Metrics and analytics](https://developers.cloudflare.com/workflows/observability/metrics-analytics/), [Wrangler commands](https://developers.cloudflare.com/workflows/reference/wrangler-commands/), and [pricing](https://developers.cloudflare.com/workflows/reference/pricing/) |

CPU time measures active computation; waiting for network or storage I/O is elapsed time. Event waits, sleeps, and retry delays also have their own documented behavior. Check the current limits page for how these states affect concurrency and step accounting rather than treating every wait as active execution.

See [README.md](./README.md), [configuration.md](./configuration.md), [api.md](./api.md), and [patterns.md](./patterns.md).
