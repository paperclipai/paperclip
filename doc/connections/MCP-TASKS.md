# MCP Tasks: long provider calls that survive timeouts, restarts, and deploys

Some provider actions take minutes: a CI run, a deploy, a batch job. An MCP
server that supports **Tasks** answers such a `tools/call` with a durable task
handle instead of the result. Paperclip stores that handle, waits on it, and
hands the agent the final result exactly as a quick call would return it. If
the call outlives its timeout, or Paperclip restarts or deploys mid-call, the
work is not lost and is never started a second time.

## Turning it on

MCP Tasks are behind the experimental setting **Durable app actions (MCP
Tasks)** (`enableMcpTasks`), off by default. Find it under Instance settings →
Experimental.

- **Off:** Paperclip never declares `io.modelcontextprotocol/tasks`, so servers
  never return a task and every call behaves as before. Nothing polls, attaches
  to, or wakes for stored tasks, and they do not keep an idle host awake.
- **On:** everything below applies. Turning it off later stops new tasks;
  stored ones resume if it is turned on again before they expire.

## The standard

- Specification: [MCP Tasks extension, 2026-07-28](https://github.com/modelcontextprotocol/ext-tasks)
  ([overview](https://modelcontextprotocol.io/extensions/tasks/overview)).
- Extension id: `io.modelcontextprotocol/tasks`. It is defined for stateless MCP
  (2026-07-28), so Paperclip uses it only with servers on that version. See
  [MCP-PROTOCOL-VERSIONS.md](./MCP-PROTOCOL-VERSIONS.md).
- Input requests use the multi round-trip shape
  ([MRTR](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr)).

The protocol works like this:

1. **The client declares the extension per request** in
   `_meta["io.modelcontextprotocol/clientCapabilities"].extensions`. A server
   must never return a task to a request that did not declare it.
2. **`tools/call` may return a task** (`resultType: "task"`, with `taskId`,
   `status`, `ttlMs`, `pollIntervalMs`). The server decides per call.
3. **`tasks/get {taskId}`** returns the task: `working`, `input_required` (with
   `inputRequests`), `completed` (with `result`, the normal tool result),
   `failed` (with a JSON-RPC `error`), or `cancelled`.
4. **`tasks/update {taskId, inputResponses}`** answers input requests.
5. **`tasks/cancel {taskId}`** asks the server to stop. Cancellation is cooperative.
6. Over HTTP, `Mcp-Name` carries the task ID on every `tasks/*` request so load
   balancers route it to the instance holding the task.

Optional `notifications/tasks` over `subscriptions/listen` are not used;
Paperclip polls, which the specification makes the default.

## How Paperclip implements it

| Step | What happens | Code |
| --- | --- | --- |
| Declare | Only the HTTP `tools/call` and `tasks/*` requests declare the extension. Discovery, listings, and local (stdio) servers do not, so no other path can receive a task it cannot handle. | `mcpHttpRequestInit(..., { declareTasks })` in `server/src/services/mcp-http.ts` |
| Record | A returned task is stored before Paperclip waits on it: a `tool_mcp_tasks` row linked to the call, run, task, connection, and grant. | `createMcpTaskRecord` in `server/src/services/tool-gateway.ts` |
| Wait | The live call polls `tasks/get` at the server's `pollIntervalMs` (kept between 0.2 s and 5 s) until the normal tool timeout. A completed task's `result` then goes through the same validation, redaction, and recording as a direct result. | `waitForMcpTask` |
| Hand off | If the timeout passes or the caller disconnects, the agent is told the app is still working and to call the tool again with the same arguments. The row keeps the task and background polling takes over. | `provider_task_pending` |
| Attach | A call with the same endpoint, tool, full arguments, grant, agent, task, and actor attaches to the undelivered task instead of sending `tools/call` again. So does a retry with the same idempotency key, including after a crash mid-wait; the same key with other arguments is refused and leaves the original retry intact. One holder at a time (a lease): a second simultaneous caller is told to call again. | `findAttachableMcpTask`, `mcpTaskForKeyedRetry`, `claimMcpTask` |
| Deliver | A completed task counts as delivered only once its result is recorded on the call. A crash in between leaves it collectable again. | `markMcpTaskDelivered` |
| Restart | Background work reads pending rows at startup and polls each at its next deadline, with each request bounded to 30 s. It rechecks the same access a live call needs (grant, audience, delegation). When a task settles, or asks a new question, after its run has ended, the assignee is woken once; the agent's repeated call collects the result or shows the question. | `pollDueMcpTasks`, `server/src/services/mcp-task-work.ts` |
| Input | URL requests show the provider link, as for a direct request; Paperclip never answers them for the person. Form requests become a question card on the task; only the person's answer is sent with `tasks/update`. Other requests (sampling, roots) stop with a clear "needs input" error. | `planMcpTaskInput` |
| Cancel | Stopping the run sends `tasks/cancel` and marks the row cancelled. Closing the task or stopping its run does the same for a task in the background; a later call reports the cancellation and never revives it. A caller that only disconnects keeps the task. | `cancelMcpTaskRecord`, `mcpTaskStopReason` |
| Finish | `failed` becomes a tool error with the provider's message. An unknown task (`-32602`) or a passed TTL becomes a clear error telling the agent to run the action again. Nothing waits forever: every task stops being tracked after its TTL, and seven days after Paperclip first saw it at most. | `provider_task_failed`, `provider_task_expired` |

### What is stored

- The provider's task ID is sealed at rest (AES-256-GCM, a key derived from the
  instance's tool-action secret, bound to the company and connection). The
  specification lets servers treat task IDs as bearer tokens. Uniqueness uses a
  keyed hash, never the ID.
- No provider result is stored in the task row. The result stays with the
  provider until it is delivered, and the delivered result is recorded on the
  call exactly as a direct result is.
- A task is read only with the grant that created it, after the same access
  check a live call makes. If that access is removed, the connection is
  disabled, or its endpoint changes, background polling stops and the task is
  reported as no longer available.
- A provider's error body is read only up to 64 KiB.

### Agent-facing errors

| Reason code | When | What the agent should do |
| --- | --- | --- |
| `provider_task_pending` | Still working at the timeout, or the caller left | Call the same tool again with the same arguments |
| `provider_interaction_required` | The app needs the person to open a link | Wait for the person, then call again |
| `elicitation_required` | The app asked a question; a card is on the task | Wait for the answer, then call again |
| `provider_input_required` | The app needs input Paperclip cannot collect | Ask the person to finish in the app |
| `provider_task_failed` | The app reported a failure | Treat as a tool error |
| `provider_task_cancelled` | The app cancelled, or the run was stopped | Run again if still needed |
| `provider_task_expired` | The app no longer has the task | Run the action again |

## Background work

`registerMcpTaskWork` uses the shared deadline scheduler
(`registerDeadlineWork`). It is quiet when nothing is pending:

- **Trigger:** writing or releasing a task row notifies the `mcp-tasks` queue;
  startup runs once and rebuilds from the rows.
- **Deadline:** the earliest `next_poll_at`, never earlier than a live call's lease.
- **Cadence:** the server's `pollIntervalMs`, kept between 5 s and 5 min, with
  backoff after failures. A task waiting for a person is checked every 5 min:
  the person's answer wakes the agent, whose call checks immediately.
- **Quiet:** once every task is delivered, settled and woken, cancelled, or
  expired, no row has a next poll and no query or provider request runs.

This is the narrow exception in `rules/sleep-aware-background-work.mdc`: the
provider offers no wake Paperclip can receive, so an active task is polled.
Polling stops with the task. A pending task is an idle-sleep blocker
(`tool_mcp_tasks` in `idle-sleep-safety.ts`), so a host that sleeps when idle
stays awake until every task is settled. Recovery runs even when heartbeat
scheduling is off; only the agent wake needs the scheduler.

An approved action whose task outlives the wait keeps its approval: the action
returns to approved, and its next execution attaches to the same task.

## Follow-ups

- `notifications/tasks` over `subscriptions/listen`, to replace polling where
  servers support it.
- Sampling and roots input requests.
- Showing a long-running provider action's progress (`statusMessage`) in the
  task chat.
- Validating question-card answers against the provider's form schema (types,
  required fields) and letting the person correct them before `tasks/update`.

## Tests

`server/src/__tests__/mcp-tasks.test.ts` runs a fake 2026-07-28 server that
returns tasks. It covers polling to completion, a timeout followed by an
attaching call, a keyed retry, a restart mid-task (fresh gateway, no second
`tools/call`, one wake, one delivery), URL and form input, cancellation by the
run and by closing the task, failure, an unknown task, TTL expiry, another
agent never attaching, and synchronous calls left unchanged.
