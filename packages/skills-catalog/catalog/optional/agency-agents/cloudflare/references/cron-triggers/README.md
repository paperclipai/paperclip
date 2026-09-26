# Cloudflare Cron Triggers

Use Cron Triggers to start periodic Worker jobs. Fetch the relevant current documentation before implementing; configuration, API signatures, examples, and limits belong in the docs.

- **Set up a recurring job:** [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/) covers scheduling, deployment, and execution history.
- **Implement the job:** [Scheduled handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/) covers controller properties, asynchronous work, and multiple schedules.
- **Schedule durable work:** [Trigger Workflows](https://developers.cloudflare.com/workflows/build/trigger-workflows/) covers direct Workflow schedules and starting instances from a Worker. Check this before introducing a Worker whose only job is to start a Workflow.
- **Check capacity:** fetch [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) for the target plan and invocation type.

## In This Reference

- [configuration.md](./configuration.md) — schedule setup, environments, removal, and Green Compute
- [api.md](./api.md) — handler implementation, asynchronous completion, and tests
- [patterns.md](./patterns.md) — choosing execution boundaries and integrations
- [gotchas.md](./gotchas.md) — investigating timing, failures, and repeated work

## See Also

- [Workflows](../workflows/README.md) — durable multi-step jobs
- [Queues](../queues/README.md) — asynchronous message processing
