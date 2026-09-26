# Cron Triggers Troubleshooting

Investigate using the current documentation rather than copied limits or assumed delivery guarantees.

| Symptom or question | Documentation and check |
| --- | --- |
| Job runs at an unexpected time | Check [UTC execution](https://developers.cloudflare.com/workers/configuration/cron-triggers/#background) and [expression syntax](https://developers.cloudflare.com/workers/configuration/cron-triggers/#supported-cron-expressions); compare with the intended business timezone. |
| Schedule is missing after deployment | Check the handler, target environment, and propagation guidance in [Add a Cron Trigger](https://developers.cloudflare.com/workers/configuration/cron-triggers/#add-a-cron-trigger). |
| Removing or preserving schedules has an unexpected result | Review [Remove a Cron Trigger](https://developers.cloudflare.com/workers/configuration/cron-triggers/#remove-a-cron-trigger) before changing empty or omitted configuration. |
| Local invocation fails | Follow [Test Cron Triggers locally](https://developers.cloudflare.com/workers/configuration/cron-triggers/#test-cron-triggers-locally) for the supported endpoint, port, and query parameters. |
| Async work fails or completion status is surprising | Read [handler methods](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/#methods) and inspect [past events](https://developers.cloudflare.com/workers/configuration/cron-triggers/#view-past-events). |
| Job exceeds its execution budget | Check [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) before choosing a smaller unit of work or [Workflows](../workflows/README.md). |
| Green Compute behavior differs from expectations | Read [Green Compute](https://developers.cloudflare.com/workers/configuration/cron-triggers/#green-compute) for its execution-location policy and account configuration. |

For repeated or partially completed business operations, decide how to identify work and recover safely before selecting storage. Test recovery after each side effect; a marker alone does not establish that the operation completed. Do not assume a particular automatic retry schedule or delivery guarantee without a documented contract.

See [patterns.md](./patterns.md) for coordination choices and [api.md](./api.md) for tests.
