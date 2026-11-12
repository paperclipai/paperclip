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
 * still pending from the agent's point of view.
 *
 * The backlog is not strictly ordered: after a reattach the controller
 * recovers the held calls while the Runner delivers the agent's later
 * terminal call, so the terminal call can arrive before the held calls have
 * returned (restart chaos t05). A terminal call therefore first waits, for
 * a bounded time, for earlier calls of its turn that have not returned. If
 * any is still pending after the wait the terminal call is refused too: the
 * agent decided without it, and its outcome is not known yet.
 */

const TERMINAL_OPERATIONS = new Set(["paperclip_finish", "paperclip_block"]);

type CommittedEvent = { sourceEventId: string; envelope: Record<string, unknown> };
type Command = { type: string; payload: Record<string, unknown> };

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

type TerminalCallScope = {
  terminalSourceEventId?: string | null;
  turnId?: string | null;
  refusals?: ReadonlyMap<string, readonly string[]>;
};
type ToolCallState = { name: string; returned: boolean; seen: boolean; named: boolean };

/** Names of calls that returned before the terminal call but that the agent had not yet seen. */
export function unseenReturnedToolCalls(
  events: readonly CommittedEvent[],
  commands: readonly Command[],
  input: TerminalCallScope,
): string[] {
  return callNames(unseenReturnedCalls(events, commands, input));
}

function unseenReturnedCalls(events: readonly CommittedEvent[], commands: readonly Command[], input: TerminalCallScope) {
  return [...earlierToolCalls(events, commands, input)]
    .filter(([, call]) => call.returned && !call.seen && !call.named);
}

/**
 * Names of calls made before the terminal call that have neither returned nor
 * reached the agent. After a reattach the Runner hands the controller its
 * held calls and the agent's later terminal call together, so these are
 * usually about to return (restart chaos t05: a held write_document returned
 * a few milliseconds after the paperclip_block decided without it).
 */
export function pendingEarlierToolCalls(
  events: readonly CommittedEvent[],
  commands: readonly Command[],
  input: TerminalCallScope,
): string[] {
  return callNames([...earlierToolCalls(events, commands, input)].filter(([, call]) => !call.returned && !call.seen));
}

function callNames(calls: [string, ToolCallState][]): string[] {
  return [...new Set(calls.filter(([, call]) => !TERMINAL_OPERATIONS.has(call.name)).map(([, call]) => call.name))];
}

function earlierToolCalls(
  events: readonly CommittedEvent[],
  commands: readonly Command[],
  input: TerminalCallScope,
): Map<string, ToolCallState> {
  const returnedCallIds = new Set(commands.flatMap(command => command.type === "semantic_tool.result"
    && typeof command.payload.callId === "string" ? [command.payload.callId] : []));
  const calls = new Map<string, ToolCallState>();
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
      const call = calls.get(id) ?? { name: typeof payload.name === "string" ? payload.name : "tool", returned: false, seen: false, named: false };
      if (type === "tool.execution.completed") {
        call.seen = true;
        for (const named of input.refusals?.get(id) ?? []) {
          const earlier = calls.get(named);
          if (earlier) earlier.named = true;
        }
      }
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
  return calls;
}

/** How long a terminal call waits for earlier calls of its turn to return. */
export const TERMINAL_CALL_SETTLE_TIMEOUT_MS = 30_000;

/**
 * Waits (bounded) until no call made before the terminal call is still
 * pending, then reports which earlier calls returned unseen and which are
 * still pending. `read` returns null once the session is gone.
 */
export async function settleEarlierToolCalls(
  read: () => { events: readonly CommittedEvent[]; commands: readonly Command[] } | null,
  input: TerminalCallScope,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<{ unseen: string[]; unseenCallIds: string[]; pending: string[] } | null> {
  const deadline = Date.now() + (options.timeoutMs ?? TERMINAL_CALL_SETTLE_TIMEOUT_MS);
  for (;;) {
    const state = read();
    if (!state) return null;
    const pending = pendingEarlierToolCalls(state.events, state.commands, input);
    if (pending.length === 0 || Date.now() >= deadline) {
      const unseen = unseenReturnedCalls(state.events, state.commands, input);
      return { unseen: callNames(unseen), unseenCallIds: unseen.filter(([, call]) => !TERMINAL_OPERATIONS.has(call.name)).map(([id]) => id), pending };
    }
    await new Promise(resolve => setTimeout(resolve, options.pollMs ?? 50));
  }
}

export function isTerminalOperation(operationId: string): boolean {
  return TERMINAL_OPERATIONS.has(operationId);
}

/**
 * The retryable answer to a terminal call decided before the agent saw the
 * results of `unseen` (returned) or `pending` (not returned yet).
 */
export function staleTerminalCallResult(operationId: string, unseen: readonly string[], pending: readonly string[] = []) {
  const names = [...unseen, ...pending].join(", ");
  const now = pending.length === 0
    ? "Those calls have now returned. Read their results and continue the task; "
    : `${pending.join(", ")} has not returned yet. Wait for its result (do not repeat a write until it returns), then continue the task; `;
  return {
    result: {
      error: {
        code: "terminal_call_before_results",
        retryable: true,
        message: `Paperclip did not record ${operationId}. It was decided while earlier Paperclip calls (${names}) had not returned yet: `
          + "Paperclip was briefly unreachable. " + now
          + `call ${operationId} again only if it is still the right outcome.`,
      },
    },
    isError: true,
  };
}
