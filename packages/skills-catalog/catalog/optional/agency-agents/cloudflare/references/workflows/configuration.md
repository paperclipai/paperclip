# Workflow Configuration

Use the current guides for configuration fields and setup commands; check the project's installed Wrangler version and generated binding types before adapting an existing project.

| Task | Documentation |
| --- | --- |
| Scaffold and deploy a Workflow class with its binding | [Build your first Workflow](https://developers.cloudflare.com/workflows/get-started/guide/) |
| Configure one or more Workflows, including a binding to a Workflow in another Worker | [Wrangler Workflows configuration](https://developers.cloudflare.com/workers/wrangler/configuration/#workflows) |
| Configure storage, AI, and other resources used by steps | [Workers bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/) |
| Choose step retry, backoff, timeout, and sleep behavior | [Sleeping and retrying](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/) |
| Schedule instances or trigger them from another Worker | [Trigger Workflows](https://developers.cloudflare.com/workflows/build/trigger-workflows/) |
| Trigger a Workflow from Pages Functions | [Call Workflows from Pages](https://developers.cloudflare.com/workflows/build/call-workflows-from-pages/) |
| Develop and inspect instances locally | [Local development](https://developers.cloudflare.com/workflows/build/local-development/) |
| Set resource budgets and inspect execution | [Limits](https://developers.cloudflare.com/workflows/reference/limits/) and [metrics and analytics](https://developers.cloudflare.com/workflows/observability/metrics-analytics/) |

Distinguish the Worker that defines the Workflow from callers that trigger it. For Pages, follow the documented intermediary Worker/service-binding approach. A step's elapsed-time timeout and the Worker's active CPU budget address different failure modes; configure them based on the actual failure.

See [api.md](./api.md), [patterns.md](./patterns.md), and [gotchas.md](./gotchas.md).
