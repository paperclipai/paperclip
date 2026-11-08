/**
 * Whether a terminal Paperclip call (paperclip_finish or paperclip_block) was
 * decided before the agent saw results that had already returned.
 *
 * Codex keeps a dynamic tool call pending while its client is silent and
 * samples the model again about once a minute. When the controller is down
 * (a restart or a long hold) the Runner keeps Codex's tool requests until
 * Paperclip is back, so the model can conclude "Paperclip is not answering"
 * and call paperclip_block while its earlier calls are still pending. After
 * the reattach the Runner delivers that backlog in order: the earlier calls
 * run and return (for example the document is saved), then the stale block
 * arrives and would end a task that is no longer blocked (restart chaos t03).
 *
 * The evidence:
 * - committed `tool.execution.started` with transport `dynamic`: the provider
 *   made a call (its `executionId` is the provider call id);
 * - the controller's `semantic_tool.result` command for that `callId`:
 *   Paperclip returned a result to the Runner (an `item.completed` tool_result,
 *   which some drivers commit, counts the same);
 * - committed `tool.execution.completed` for that call: the provider received it.
 * A call with a result but no provider completion before the terminal call was
 * still pending from the agent's point of view. A call with no result yet (a
 * long-running tool) does not count: the agent's decision is still its own.
 */

const TERMINAL_OPERATIONS = new Set(["paperclip_finish", "paperclip_block"]);

type CommittedEvent = { sourceEventId: string; envelope: Record<string, unknown> };
type Command = { type: string; payload: Record<string, unknown> };

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Names of calls that returned before the terminal call but that the agent had not yet seen. */
export function unseenReturnedToolCalls(
  events: readonly CommittedEvent[],
  commands: readonly Command[],
  input: { terminalSourceEventId?: string | null; turnId?: string | null },
): string[] {
  const returnedCallIds = new Set(commands.flatMap(command => command.type === "semantic_tool.result"
    && typeof command.payload.callId === "string" ? [command.payload.callId] : []));
  const calls = new Map<string, { name: string; returned: boolean; seen: boolean }>();
  for (const saved of events) {
    if (input.terminalSourceEventId && saved.sourceEventId === input.terminalSourceEventId) break;
    const event = record(saved.envelope.payload);
    if (input.turnId && typeof event.turnId === "string" && event.turnId !== input.turnId) continue;
    const payload = record(event.payload);
    const type = event.eventType;
    if (type === "turn.started") {
      calls.clear();
      continue;
    }
    if ((type === "tool.execution.started" || type === "tool.execution.completed") && payload.transport === "dynamic") {
      const id = typeof payload.executionId === "string" ? payload.executionId : null;
      if (!id) continue;
      const call = calls.get(id) ?? { name: typeof payload.name === "string" ? payload.name : "tool", returned: false, seen: false };
      if (type === "tool.execution.completed") call.seen = true;
      calls.set(id, call);
      continue;
    }
    const item = record(payload.item);
    if (type === "item.completed" && item.type === "tool_result") {
      const id = typeof item.tool_use_id === "string" ? item.tool_use_id : typeof item.id === "string" ? item.id : null;
      const call = id ? calls.get(id) : undefined;
      if (call) call.returned = true;
    }
  }
  for (const [id, call] of calls) if (returnedCallIds.has(id)) call.returned = true;
  return [...new Set([...calls.values()]
    .filter(call => call.returned && !call.seen && !TERMINAL_OPERATIONS.has(call.name))
    .map(call => call.name))];
}

export function isTerminalOperation(operationId: string): boolean {
  return TERMINAL_OPERATIONS.has(operationId);
}

/** The retryable answer to a terminal call decided before the agent saw `unseen`. */
export function staleTerminalCallResult(operationId: string, unseen: readonly string[]) {
  const names = unseen.join(", ");
  return {
    result: {
      error: {
        code: "terminal_call_before_results",
        retryable: true,
        message: `Paperclip did not record ${operationId}. It was decided while earlier Paperclip calls (${names}) had not returned yet: `
          + "Paperclip was briefly unreachable. Those calls have now returned. Read their results and continue the task; "
          + `call ${operationId} again only if it is still the right outcome.`,
      },
    },
    isError: true,
  };
}
