# FirstMate Manual Heartbeat Dispatch Fix

## Problem

Paperclip on-demand heartbeats may have no task context. The FirstMate gateway currently forwards a null task ID, while the relay requires a non-empty task ID. The relay returns a rejected dispatch acknowledgement, but the adapter ignores negative acknowledgements and waits until its 1800-second execution timeout.

## Design

Keep the fix inside the custom `firstmate_gateway` adapter.

- Resolve the dispatch task ID from `context.task.id` when present.
- For taskless runs, use the stable synthetic identifier `heartbeat:<runId>`.
- Treat every matching `paperclip.dispatch_ack` as terminal for acknowledgement handling.
- Continue normally when `accepted` is `true`.
- When `accepted` is not `true`, fail immediately with `FIRSTMATE_REJECTED` and a safe message that includes the relay's non-sensitive error code when present.
- Preserve all existing lifecycle-event identity checks and the 1800-second execution timeout.

No relay, Coding agent, database, or Paperclip core behavior changes are required. The Coding agent does not consume `taskId`, so the synthetic value is only a relay-valid correlation field.

## Data Flow

1. Paperclip starts a heartbeat run.
2. The adapter authenticates to the relay and receives `hello`.
3. The adapter sends `paperclip.dispatch` with either the real task ID or `heartbeat:<runId>`.
4. A positive acknowledgement records the existing accepted log event and waits for the matching terminal lifecycle event.
5. A negative acknowledgement ends the run immediately with `FIRSTMATE_REJECTED`.

## Tests

Add regression tests that first fail against the current adapter:

- A context with no task dispatches `taskId: heartbeat:<runId>` and can complete.
- A matching negative acknowledgement returns promptly with `FIRSTMATE_REJECTED` rather than timing out.
- The existing successful task-backed dispatch test remains green.

Run the focused Node test, adapter typecheck, and a prospective adapter environment test. After deployment, invoke one fresh taskless heartbeat and verify relay acceptance plus terminal run state.

## Deployment and Rollback

Build a new Paperclip image from the tested source and recreate only the Paperclip application container. Do not restart PostgreSQL, MCP relay, nginx, or the Coding relay agent. Preserve the prior image identifier so rollback is a single application-container redeploy if the new heartbeat verification fails.
