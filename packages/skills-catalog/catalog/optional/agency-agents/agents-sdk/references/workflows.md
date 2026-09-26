# Workflows Integration

Use Agents for interactive communication and state management. Add a Workflow when a task needs durable multi-step execution, independent retries, or waits for external approval. Choose based on recovery needs; consult [Run Workflows](https://developers.cloudflare.com/agents/runtime/execution/run-workflows/) before implementing the integration.

## Read for the task

| Task | Documentation |
| --- | --- |
| Define a typed `AgentWorkflow`, start it from an Agent, and configure bindings | [Quick start](https://developers.cloudflare.com/agents/runtime/execution/run-workflows/#quick-start) |
| Call back into the originating Agent and understand durable versus non-durable helpers | [AgentWorkflow class](https://developers.cloudflare.com/agents/runtime/execution/run-workflows/#agentworkflow-class) |
| Send events, query instances, pause, resume, terminate, or delete tracked workflows | [Agent workflow methods](https://developers.cloudflare.com/agents/runtime/execution/run-workflows/#agent-workflow-methods) |
| Receive progress, completion, errors, and custom events | [Lifecycle callbacks](https://developers.cloudflare.com/agents/runtime/execution/run-workflows/#lifecycle-callbacks) |
| Approve or reject a waiting task | [Human-in-the-loop approval](https://developers.cloudflare.com/agents/runtime/execution/run-workflows/#human-in-the-loop-approval) |
| Persist Workflow results into Agent state | [State synchronization](https://developers.cloudflare.com/agents/runtime/execution/run-workflows/#state-synchronization) |
| Define steps, parameters, retries, and returned values | [Workers API](https://developers.cloudflare.com/workflows/build/workers-api/) |

## Design checks

Keep external side effects within durable steps, make retried operations idempotent, and persist the values needed after recovery through step results. Use the [Rules of Workflows](https://developers.cloudflare.com/workflows/build/rules-of-workflows/) to choose step boundaries.

Progress reports and client broadcasts may repeat on retry. Use the documented durable step helpers for persistent Agent state changes and completion reporting; see [bidirectional communication](https://developers.cloudflare.com/agents/runtime/execution/run-workflows/#bidirectional-communication).
