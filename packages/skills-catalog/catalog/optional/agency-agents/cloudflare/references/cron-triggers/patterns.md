# Cron Triggers Patterns

Choose the execution boundary before writing a scheduled job; fetch the relevant integration docs for implementation.

| Need | Documentation |
| --- | --- |
| Periodic API sync, cleanup, reports, or health checks in a Worker | [Cron Triggers background](https://developers.cloudflare.com/workers/configuration/cron-triggers/#background) and [scheduled handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/) |
| Different jobs on different schedules | [Handle multiple cron triggers](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/#handle-multiple-cron-triggers) |
| Durable multi-step work started on a schedule | [Trigger Workflows](https://developers.cloudflare.com/workflows/build/trigger-workflows/) |
| Send work to a queue and implement its consumer | [Queues JavaScript APIs](https://developers.cloudflare.com/queues/configuration/javascript-apis/) |
| Coordinate state across invocations | [What are Durable Objects?](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/) |
| Inspect whether scheduled work ran | [View past events](https://developers.cloudflare.com/workers/configuration/cron-triggers/#view-past-events) |

Keep the trigger separate from the business operation so manual recovery and scheduled execution can share it. Decide how partial progress is recorded, how repeated attempts affect side effects, and who owns completion reporting. When distributing a batch, distinguish successful enqueueing from successful processing.

Use [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) to evaluate whether the job fits one invocation. If it needs durable steps, waiting, or explicit retry boundaries, inspect [Workflows](../workflows/README.md) before building those mechanisms in the handler.

See [api.md](./api.md) for tests and [gotchas.md](./gotchas.md) for operational checks.
