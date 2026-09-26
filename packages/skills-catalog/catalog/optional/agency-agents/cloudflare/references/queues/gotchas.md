# Queues Gotchas & Troubleshooting

Fetch the linked documentation before changing retry policy or interpreting delivery behavior.

| Symptom or question | Documentation and decision |
|---------------------|----------------------------|
| Successful work repeats after another message fails | Read [acknowledgement and retry rules](https://developers.cloudflare.com/queues/configuration/batching-retries/); use per-message outcomes for independent work. |
| A caught failure disappears instead of retrying | Read [handler lifecycle and APIs](https://developers.cloudflare.com/queues/configuration/javascript-apis/); returning successfully can acknowledge messages. Explicitly retry failed work when continuing. |
| Duplicate processing | Read [delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/); enforce idempotency at the side-effect destination. |
| Pull consumers cannot decode payloads | Check [pull consumer encoding](https://developers.cloudflare.com/queues/configuration/pull-consumers/) and [content types](https://developers.cloudflare.com/queues/configuration/javascript-apis/) against the producer. |
| Messages stop arriving or backlog grows | Check [consumer configuration](https://developers.cloudflare.com/queues/configuration/configure-queues/), [pause state](https://developers.cloudflare.com/queues/configuration/pause-purge/), and [queue metrics](https://developers.cloudflare.com/queues/observability/metrics/). |
| Dead-letter volume rises or messages disappear after retries | Read [Dead Letter Queues](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/); inspect failures and plan recovery before increasing retries. |
| API errors, resource exhaustion, or CPU failures | Read [error codes](https://developers.cloudflare.com/queues/reference/error-codes/), [limits](https://developers.cloudflare.com/queues/platform/limits/), and [consumer concurrency](https://developers.cloudflare.com/queues/configuration/consumer-concurrency/). |
| Retention, delay, throughput, or cost assumptions no longer hold | Retrieve current [limits](https://developers.cloudflare.com/queues/platform/limits/) and [pricing](https://developers.cloudflare.com/queues/platform/pricing/) for the account's plan. |

Distinguish transient dependency failures from invalid payloads before choosing retry or recovery behavior. Acknowledging a failed message does not send it to a dead-letter queue. If handling a permanent failure separately, persist the intended recovery record successfully before acknowledging; use the documented dead-letter policy when relying on retry exhaustion.

See [patterns.md](./patterns.md) for idempotency and downstream integration decisions.
