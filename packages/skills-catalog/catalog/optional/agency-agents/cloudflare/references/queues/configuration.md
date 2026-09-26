# Queues Configuration

Fetch the relevant guide before writing configuration or running CLI commands. Check the project's Wrangler version and compatibility date when adapting examples.

| Task | Documentation |
|------|---------------|
| Create a queue and connect producer and consumer Workers | [Getting started](https://developers.cloudflare.com/queues/get-started/) |
| Configure producer bindings, Worker consumers, retention, and concurrency settings | [Configure Queues](https://developers.cloudflare.com/queues/configuration/configure-queues/) |
| Configure an external HTTP consumer and its visibility timeout | [Pull consumers](https://developers.cloudflare.com/queues/configuration/pull-consumers/) |
| Choose batching, retry policy, or delivery delays | [Batching, retries, and delays](https://developers.cloudflare.com/queues/configuration/batching-retries/) |
| Preserve messages that exhaust retries | [Dead Letter Queues](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/) |
| Set consumer scaling for downstream capacity | [Consumer concurrency](https://developers.cloudflare.com/queues/configuration/consumer-concurrency/) |
| Choose content types and type Worker messages | [JavaScript APIs](https://developers.cloudflare.com/queues/configuration/javascript-apis/) |
| Create, update, attach, remove, or delete queues and consumers | [Wrangler commands](https://developers.cloudflare.com/queues/reference/wrangler-commands/) |
| Pause delivery, resume it, or purge messages | [Pause and purge](https://developers.cloudflare.com/queues/configuration/pause-purge/) |
| Develop and test producers and consumers locally | [Local development](https://developers.cloudflare.com/queues/configuration/local-development/) |

Choose push or pull based on where processing runs, then select an encoding supported by that consumer. Tune batching for acceptable latency and downstream write capacity. Decide how failed messages will be inspected and replayed before configuring a dead-letter queue.

Fetch [limits](https://developers.cloudflare.com/queues/platform/limits/) and [pricing](https://developers.cloudflare.com/queues/platform/pricing/) for the account's plan before selecting retention, delays, or capacity. Do not reuse numeric settings from unrelated examples.
