# Queues API Reference

Fetch the current API documentation for the operation being implemented; do not infer signatures, payloads, or acknowledgement rules from old examples.

| Task | Documentation |
|------|---------------|
| Send individual messages or batches; choose encoding; implement a typed Worker queue handler; dispatch by queue name | [JavaScript APIs](https://developers.cloudflare.com/queues/configuration/javascript-apis/) |
| Understand automatic acknowledgement, explicit per-message and batch actions, precedence, delivery failures, delays, and backoff | [Batching, retries, and delays](https://developers.cloudflare.com/queues/configuration/batching-retries/) |
| Pull over HTTP and acknowledge or retry using leases | [Pull consumers](https://developers.cloudflare.com/queues/configuration/pull-consumers/) |
| Publish from outside Workers | [Publish to a Queue via HTTP](https://developers.cloudflare.com/queues/examples/publish-to-a-queue-via-http/) |

Acknowledge only after the intended work succeeds. For independently processed messages, use per-message outcomes to avoid replaying successful work when another message fails. If catching an error and continuing, explicitly request a retry for work that still needs processing; a successful handler return can acknowledge messages automatically. Fetch the linked acknowledgement rules before mixing message-level and batch-level actions.

Await required work, including downstream writes or sends, before acknowledging it. Check the JavaScript API's handler lifecycle rules before using `waitUntil()`; background work is not independent of delivery success.

See [configuration.md](./configuration.md) for bindings and consumer setup, and [gotchas.md](./gotchas.md) for delivery diagnostics.
