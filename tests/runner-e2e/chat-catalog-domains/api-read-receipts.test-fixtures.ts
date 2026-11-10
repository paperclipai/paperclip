import { redactRunnerApiEvent } from "../../../server/src/services/native-runtime/runner-api-log-redaction.js";

/**
 * One call_api (or dedicated API-backed tool) use and its result, as the runner
 * emits them, passed through the same redactor PaperclipControlPlanePort applies
 * before saving run events.
 */
export function savedCall(input: Record<string, unknown>, status: number, itemId = "7", runId = "run-1", data: unknown = { id: "response-body" }, tool = "call_api", operationId = input.operationId): Record<string, unknown>[] {
  const row = (eventType: string, item: Record<string, unknown>) => {
    const event = redactRunnerApiEvent({ eventType, sourceKind: "runner", payload: { item } });
    return { runId, eventType, payload: { prpEvent: { runId, sourceKind: "runner", payload: event.payload } } };
  };
  return [
    row("item.started", { id: itemId, name: tool, type: "tool_use", input }),
    row("item.completed", { id: itemId, type: "tool_result", tool_use_id: itemId,
      result: { ok: status >= 200 && status < 300, status, contentType: "application/json; charset=utf-8", apiOperationId: operationId, data } }),
  ];
}
