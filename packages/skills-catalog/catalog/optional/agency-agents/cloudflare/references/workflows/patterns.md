# Workflow Patterns

## Design Decisions

Read [Rules of Workflows](https://developers.cloudflare.com/workflows/build/rules-of-workflows/) before choosing step boundaries or concurrency patterns.

- Separate work into steps that can be retried independently. Persist results through step returns and keep side effects inside steps.
- Make side effects safe to repeat. A retry can happen after an external write succeeds; use the destination's idempotency mechanism or atomic deduplication. A separate check followed by a write does not itself guarantee idempotency.
- Base step names, loops, and branches on stable input or persisted results. In-memory state and fresh time/random values cannot serve as durable replay state.
- Await step operations, and check the documented replay behavior before combining steps in parallel or racing them.
- Keep large data in external storage when appropriate and pass references between steps; consult current return-type and size constraints.

## Examples and Orchestration

| Task | Documentation |
| --- | --- |
| Process images with human approval; handle approval events and timeouts | [Human-in-the-loop image tagging](https://developers.cloudflare.com/workflows/examples/wait-for-event/) |
| Implement a payment and notification sequence | [Pay cart and send invoice](https://developers.cloudflare.com/workflows/examples/send-invoices/) |
| Export data to object storage | [Export and save D1 database](https://developers.cloudflare.com/workflows/examples/backup-d1/) |
| Delay lifecycle follow-ups or retry transient failures | [Sleeping and retrying](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/) |
| Schedule jobs or start child Workflows | [Trigger Workflows](https://developers.cloudflare.com/workflows/build/trigger-workflows/) |
| Design parallel work, races, conditional steps, and batch creation | [Rules of Workflows](https://developers.cloudflare.com/workflows/build/rules-of-workflows/) |

## Testing Workflows

Fetch [Vitest setup](https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/) for current dependencies and configuration, then use the [Workflow test APIs](https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/#workflows) for introspection, step/event mocks, sleep controls, and cleanup.

Test retry behavior, event arrival and timeout paths, and duplicate external effects. Use documented introspection waits to observe completion rather than assuming a newly created instance has finished.

See [configuration.md](./configuration.md), [api.md](./api.md), and [gotchas.md](./gotchas.md).
