# Cloudflare Workflows

Use Workflows for durable, multi-step jobs that must retry, wait, and resume without losing completed work. An instance is one execution; steps define persistence and retry boundaries.

Fetch the relevant current documentation before implementing. API shapes, configuration, testing helpers, limits, and examples belong in the docs rather than in this reference.

- **Start a project:** [Build your first Workflow](https://developers.cloudflare.com/workflows/get-started/guide/) covers scaffolding, configuration, deployment, and a first instance.
- **Design durable execution:** [Rules of Workflows](https://developers.cloudflare.com/workflows/build/rules-of-workflows/) covers step boundaries, replay, state, and idempotency.
- **Implement or manage an instance:** [Workers API](https://developers.cloudflare.com/workflows/build/workers-api/) covers steps, instance operations, parameters, and return types.
- **Check capacity and cost:** fetch [limits](https://developers.cloudflare.com/workflows/reference/limits/) and [pricing](https://developers.cloudflare.com/workflows/reference/pricing/) for the target plan.

## In This Reference

- [configuration.md](./configuration.md) — setup, bindings, retry configuration, and local development
- [api.md](./api.md) — steps, instance lifecycle, events, CLI, and REST operations
- [patterns.md](./patterns.md) — design decisions, examples, orchestration, and tests
- [gotchas.md](./gotchas.md) — failures, timeouts, replay, and capacity investigation

## See Also

- [Durable Objects](https://developers.cloudflare.com/durable-objects/) — stateful coordination
- [Queues](../queues/README.md) — asynchronous message delivery
- [Workers](https://developers.cloudflare.com/workers/) — application entry points that trigger instances
