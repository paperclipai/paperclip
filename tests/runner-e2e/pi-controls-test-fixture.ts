import { CodexSessionState } from "../../packages/paperclip-runner/src/drivers/codex/codex-session-state.js";
import { mapTerminalTurn } from "../../packages/paperclip-runner/src/drivers/codex/codex-session-terminal.js";
import { observePiControlPending } from "./pi-controls-evidence.js";
import { readActiveStopCaller } from "./native-active-stop-evidence.js";

type Row = Record<string, any>;
export const piControlCaller = readActiveStopCaller({ deploymentMode: "local_trusted" }, { session: { userId: "local-board", id: "paperclip:local_implicit:local-board" } });
export const piCancellationId = "11111111-2222-4333-8444-555555555555";
export function piControlFixture(target = "target.txt") {
  const scope = { companyId: "company", issueId: "issue", runId: "run", target };
  const events: Row[] = [];
  const row = (eventType: string, payload: Row, extra: Row = {}) => {
    const seq = events.length + 1;
    return { companyId: "company", runId: "run", seq, eventType, protocolSchemaVersion: 1,
      payload: { prpEvent: { schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceKind: "runner", eventType, runId: "run", turnId: "turn", normalizedSessionId: "session", sourceInstanceId: "source", sourceSeq: seq,
        sourceEventId: `source:run:${seq}`, emittedAt: "2026-10-01T00:00:00Z", payload, ...extra } } };
  };
  const append = (eventType: string, payload: Row, extra: Row = {}) => events.push(row(eventType, payload, extra));
  const tool = { schema: "paperclip.tool.execution.v1", executionId: "pi-tool", transport: "builtin", name: "write", operation: "edit", target, status: "running" };
  append("tool.execution.started", tool);
  const request = { schema: "paperclip.runtime_request.v2", type: "permission", requestKind: "permission_approval", method: "session/request_permission", status: "pending", requestId: "request", turnId: "turn", itemId: "permission-item",
    origin: { adapter: "acpx-runtime-sidecar", provider: "pi", method: "session/request_permission" }, details: { toolCallId: "pi-tool" }, choices: [{ key: "decline", label: "Deny" }] };
  append("runtime_request.created", { request });
  const run: Row = { id: "run", companyId: "company", nativeIssueId: "issue", runtimeMode: "native", status: "running", resultJson: {}, processPid: 123, processGroupId: 123, processStartedAt: "2026-10-01T00:00:00Z" };
  const issue: Row = { id: "issue", companyId: "company", identifier: "PI-1", status: "in_progress" };
  const state = () => ({ events, run, issue });
  const pending = () => observePiControlPending({ ...state(), scope });
  const responses: unknown[] = [];
  function cancel(cancellationRequestId = piCancellationId) {
    // Exercise the real Product terminal mapper and callback cancellation, not
    // just a fabricated terminal whose payload mirrors the matcher.
    const session = {
      terminalTurns: new Map(), workspaceChangesByTurn: new Map(), result: null, conversationMode: "direct", activeTurnId: "turn", turnStarted: true,
      pendingRuntimeRequestMap: new Map([[request.requestId, { request, settle: (value: unknown) => responses.push(value) }]]),
      cancelPendingRequests: CodexSessionState.prototype.cancelPendingRequests,
      emit: (eventType: string, payload: Row) => append(eventType, payload),
    } as unknown as CodexSessionState;
    mapTerminalTurn(session, { id: "turn", status: "cancelled", error: null }, "turn");
    run.status = "cancelled";
    run.resultJson = { startupCancellation: { cancellationRequestId, requestedBy: { type: "board", userId: "local-board" } }, nativeCancellation: {
      schema: "paperclip.native-cancellation.v1", intentId: `native-cancellation:${cancellationRequestId}`, companyId: "company", runId: "run", issueId: "issue", scope: "run",
      dispatched: true, dispatchState: "acknowledged", reasonCode: "cancellation_run_only", effects: ["release_run_resources"], intentAuditId: "intent-audit", acknowledgementAuditId: "ack-audit",
    } };
    return run;
  }
  const marker = `PI-STEER-${"a".repeat(32)}`, commentId = "comment", queueId = "queue";
  function steer() {
    run.resultJson.queuedSteeringAcknowledgements = { [commentId]: { status: "acknowledged", queueId, turnId: "turn", acknowledgedAt: "2026-10-01T00:00:01Z" } };
    append("item.completed", { kind: "steering_acknowledgement", status: "acknowledged", mode: "steer", text: "Steering acknowledged for the active turn." }, { itemId: `turn:steer:${commentId}` });
  }
  function finish(finalMarker = marker) {
    append("runtime_request.resolved", { requestId: "request", turnId: "turn", action: "decline" });
    append("tool.execution.completed", { ...tool, status: "failed", output: "Pi operation was denied or cancelled" });
    append("turn.completed", { status: "completed", error: null });
    run.status = "succeeded"; issue.status = "done";
    append("run.result.accepted", { result: { schema: "paperclip.run_result.v1", reportedWorkDisposition: "done", summary: finalMarker } }, {
      sourceKind: "control_plane", sourceInstanceId: "source:control", sourceSeq: 1, sourceEventId: "source:control:run:1",
    });
    append("run.terminal", { schema: "paperclip.prp.terminal.v1", runTerminalState: "succeeded", turnTerminalState: "completed", reportedWorkDisposition: "done" }, {
      sourceKind: "control_plane", sourceInstanceId: "source:control", sourceSeq: 2, sourceEventId: "source:control:run:2",
    });
  }
  return { scope, events, run, issue, state, pending, row, append, request, tool, cancel, responses, steer, finish, marker, commentId, queueId };
}
