/**
 * A Paperclip tool call can reach a run record twice: once as the provider's
 * own tool lifecycle (`tool.execution.*`, namespace `paperclip`) and once as
 * the Paperclip bridge's call (`item.*` tool_use/tool_result, with the
 * arguments). Claude passes its tool-use id to the bridge, so both share one
 * id and already show as one row. A provider that passes none (Antigravity)
 * gets a separate bridge id. This pairs such a bridge call with the provider
 * call of the same Paperclip tool that is in flight when it starts, so the
 * thread shows one row with the arguments. Display only.
 */
export interface BridgeCallPairing {
  /** Record one `tool.execution.*` payload, in run order. */
  execution(eventType: string, payload: Record<string, unknown>): void;
  /** The provider execution a new bridge call belongs to, if one is in flight. */
  bridgeCall(callId: string, toolName: string | null | undefined): string | undefined;
  /** The provider execution an already paired bridge call belongs to. */
  pairedExecution(callId: string): string | undefined;
}

const PAPERCLIP_NAMESPACE = "paperclip";

export function createBridgeCallPairing(): BridgeCallPairing {
  const executions = new Set<string>();
  const inFlight = new Map<string, string[]>();
  const paired = new Map<string, string>();
  const nameOf = new Map<string, string>();
  const remove = (executionId: string) => {
    const name = nameOf.get(executionId);
    const queue = name === undefined ? undefined : inFlight.get(name);
    if (queue) inFlight.set(name!, queue.filter((id) => id !== executionId));
  };
  return {
    execution(eventType, payload) {
      const executionId = typeof payload.executionId === "string" ? payload.executionId : "";
      const name = typeof payload.name === "string" ? payload.name : "";
      if (!executionId) return;
      const first = !executions.has(executionId);
      executions.add(executionId);
      if (eventType === "tool.execution.completed") {
        remove(executionId);
        return;
      }
      if (!first || payload.namespace !== PAPERCLIP_NAMESPACE || !name) return;
      nameOf.set(executionId, name);
      inFlight.set(name, [...(inFlight.get(name) ?? []), executionId]);
    },
    bridgeCall(callId, toolName) {
      if (paired.has(callId)) return paired.get(callId);
      if (!toolName || executions.has(callId)) return undefined;
      const executionId = inFlight.get(toolName)?.[0];
      if (!executionId) return undefined;
      paired.set(callId, executionId);
      remove(executionId);
      return executionId;
    },
    pairedExecution(callId) {
      return paired.get(callId);
    },
  };
}
