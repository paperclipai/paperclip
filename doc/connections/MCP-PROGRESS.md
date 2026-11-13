# Progress for long MCP tool calls

When an agent run calls a connected app's tool and the app reports progress,
the task chat shows it on the tool's row while the call runs: a bar that fills
when the app knows the total (a quiet sweep when it does not), the app's latest
status line, and elapsed time. The row drops it when the call finishes.

Spec: [MCP 2026-07-28, Progress](https://modelcontextprotocol.io/specification/2026-07-28/basic/utilities/progress).

## How it works

1. **Request.** For a `tools/call` made by an agent run, the gateway adds a
   per-call `_meta.progressToken` (`paperclip-progress-<uuid>`). This applies to
   remote (Streamable HTTP) and local stdio connections, under every protocol
   version. Calls not made by a run (board test calls, MCP Apps views) send no
   token.
2. **Response stream.** The app sends `notifications/progress` (`progress`,
   optional `total`, optional `message`) on the call's own response stream: SSE
   events on the POST response for HTTP, stdout lines for stdio. Under
   2026-07-28, request-scoped notifications always stay on that stream.
   `readMcpHttpResponse` hands each notification to an observer before it
   reaches the result, and the observer can never fail or delay the call.
3. **Reporter** (`server/src/services/tool-call-progress.ts`). Each update is
   checked (finite, non-negative, increasing; `total` kept only when positive and
   at least `progress`) and its message reduced to plain single-line text of at
   most 200 characters. The reporter then:
   - publishes a `heartbeat.run.tool_progress` live event at most every 250 ms
     (the latest update wins);
   - saves the latest update on the `tool_invocations.progress` column at most
     every second, and never onto a finished call;
   - publishes a final event with `done: true` when the call ends.
   Nothing the reporter does is awaited by the call.
4. **Delivery.** The event goes to the run's company only. The live socket
   treats it like transcript output: a client receives it only for runs it
   asked to follow, after the same run read check.
5. **Task chat.** `ToolCallProgressProvider` (one per chat) keeps the latest
   update per call. A running tool row subscribes to it and finds its call by
   run and tool name. Each update carries both the gateway name and the name
   native runners give the tool (`assignedToolName`: shortened, with a hash),
   since native transcripts show the latter. When a running row first mounts, the chat reads
   `GET /api/issues/:issueId/tool-call-progress` (again on mount and on tab
   focus), so a reload mid-call shows the latest saved state. The read also
   marks recently finished calls `done`; a call is never dropped just because
   the read does not list it, since its first save may still be in flight. Finished rows never fetch or re-render for
   progress.

## Speed

The token adds a few bytes to the request. Parsing happens on the stream that
was already being read. Publishing and saving are throttled, fire-and-forget,
and stop when the call ends. Agent boot and time to first token are untouched:
the code runs only while a tool call is in flight.

## Trying it

`packages/kv-demo-mcp-server` has a `slow_with_progress` tool
(`steps`, `stepMs`, `withTotal`). Connect the demo server, then ask an agent to
call it with, say, `{ "steps": 20, "stepMs": 1000 }`; the tool row fills over
20 seconds. `withTotal: false` shows the indeterminate state.

## Not covered

- Matching uses the run and the tool name. If one run calls the same tool
  twice at once, both rows show the newer call's progress.
- Progress from a call that became an MCP Task (see `MCP-TASKS.md`) is not shown.
- Progress is not forwarded to the agent's own MCP client.
