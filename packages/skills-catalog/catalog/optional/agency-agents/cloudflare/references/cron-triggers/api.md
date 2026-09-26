# Cron Triggers API

Fetch the handler documentation before writing code; use its current language examples and completion semantics.

| Task | Documentation |
| --- | --- |
| Implement the handler and access the cron expression, scheduled time, bindings, and context | [Scheduled handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/) |
| Route different schedules to different operations | [Handle multiple cron triggers](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/#handle-multiple-cron-triggers) |
| Await work and understand how asynchronous failures affect invocation status | [Handler methods](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/#methods) |
| Invoke a scheduled handler locally with a chosen expression or time | [Test Cron Triggers locally](https://developers.cloudflare.com/workers/configuration/cron-triggers/#test-cron-triggers-locally) |
| Build tests using runtime-backed controllers and execution contexts | [Workers test APIs](https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/) |
| Start and inspect a Workflow instance | [Trigger Workflows](https://developers.cloudflare.com/workflows/build/trigger-workflows/) |

Decide which operation establishes successful completion and make its failures observable. Test each configured schedule and partial-failure recovery. Read the local-testing documentation for the current endpoint and query parameters instead of adding a production HTTP route to imitate the development helper.

See [patterns.md](./patterns.md) for execution design and [gotchas.md](./gotchas.md) for failures.
