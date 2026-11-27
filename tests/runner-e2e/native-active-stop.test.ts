import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { assertActiveStopRetirement, readActiveStopRemoteRetirement, type ActiveStopRemoteObservation, readActiveStopCaller, observeActiveStopPending, readActiveStopSettlement, type ActiveStopProvider } from "./native-active-stop-evidence.js";
import { stopAtPendingPermission } from "./native-active-stop-flow.js";
import { runnerMatrix, runnerSuites, suiteDefinitionHash } from "./catalog.js";
import { selectRunnerExecutions, parseRunnerSelectors } from "./selectors.js";
import { createCursorToolEvidence } from "../../packages/paperclip-runner/src/drivers/acpx/cursor-tool-evidence.js";
import { createCopilotToolEvidence } from "../../packages/paperclip-runner/src/drivers/acpx/copilot-tool-evidence.js";
import type { CanonicalProviderEvent } from "../../packages/paperclip-runner/src/provider-events.js";

import { CodexSessionState } from "../../packages/paperclip-runner/src/drivers/codex/codex-session-state.js";
import { mapTerminalTurn } from "../../packages/paperclip-runner/src/drivers/codex/codex-session-terminal.js";

const caller = readActiveStopCaller({ deploymentMode: "local_trusted" }, { session: { userId: "local-board", id: "paperclip:local_implicit:local-board" } });
const cancellationRequestId = "11111111-2222-4333-8444-555555555555";
type Row = Record<string, any>;
function fixture(provider: ActiveStopProvider = "copilot") {
  const scope = { provider, companyId: "company", issueId: "issue", runId: "run", target: "target.txt", ...(provider === "cursor" ? { commandSha256: `sha256:${"a".repeat(64)}` } : {}) };
  const row = (seq: number, eventType: string, payload: Row): Row => ({ companyId: "company", runId: "run", seq, eventType, protocolSchemaVersion: 1,
    payload: { prpEvent: { schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceKind: "runner", eventType, runId: "run", turnId: "turn",
      normalizedSessionId: "normalized-session", sourceInstanceId: "source", sourceSeq: seq, sourceEventId: `source:run:${seq}`, emittedAt: "2026-01-01T00:00:00Z", payload } } });
  const notice = (seq: number, stage: string, fields: Row) => row(seq, "provider.notice.recorded", {
    schema: "paperclip.provider.notice.v1", scope: "turn", category: `${provider}_tool_evidence_v1`,
    provenance: { sessionId: "native-session", turnId: "turn", eventType: stage, method: stage === "tool" ? "session/update" : "session/request_permission" },
    details: Object.entries({ stage, toolCallId: "tool", ...fields }).map(([name, value]) => ({ name, value: String(value) })),
  });
  const operation = provider === "cursor" ? { operation: "execute", commandSha256: scope.commandSha256 } : { operation: "edit", target: scope.target };
  const events: Row[] = [
    notice(1, "tool", { status: "pending", ...operation }),
    row(2, "tool.execution.started", { schema: "paperclip.tool.execution.v1", executionId: "tool", transport: "builtin", status: "running", ...operation }),
    notice(3, "permission_requested", { requestId: "request", declineOffered: true, ...operation }),
    row(4, "runtime_request.created", { request: { schema: "paperclip.runtime_request.v2", requestKind: "permission_approval", type: "permission", status: "pending", requestId: "request", turnId: "turn", itemId: "item-run", method: "session/request_permission",
      details: { toolCallId: "tool" }, origin: { adapter: "acpx-runtime-sidecar", provider, method: "session/request_permission" } } }),
  ];
  const run: Row = { id: "run", companyId: "company", nativeIssueId: "issue", runtimeMode: "native", status: "running", resultJson: {} };
  const issue = { id: "issue", companyId: "company", status: "in_progress" };
  const state = () => ({ events, run, issue });
  const pending = () => observeActiveStopPending({ ...state(), scope, caller, cancellationRequestId });
  const permissionResponse = vi.fn();
  const settle = (requestId = cancellationRequestId) => {
    // Exercise the actual Product terminal and pending-request producers. Only
    // the state storage/emitter and callback are test doubles; no provider runs.
    const request = events.find(event => event.eventType === "runtime_request.created")!.payload.prpEvent.payload.request;
    const state = {
      terminalTurns: new Map(), workspaceChangesByTurn: new Map(), result: null,
      conversationMode: "direct", activeTurnId: "turn", turnStarted: true,
      pendingRuntimeRequestMap: new Map([[request.requestId, { request, settle: permissionResponse }]]),
      cancelPendingRequests: CodexSessionState.prototype.cancelPendingRequests,
      emit: (eventType: string, value: Row) => events.push(row(events.length + 1, eventType, value)),
    } as unknown as CodexSessionState;
    mapTerminalTurn(state, { id: "turn", status: "cancelled", error: null }, "turn");
    run.status = "cancelled"; run.resultJson = { startupCancellation: { cancellationRequestId: requestId, requestedBy: { type: "board", userId: "local-board" } }, nativeCancellation: {
      schema: "paperclip.native-cancellation.v1", intentId: `native-cancellation:${requestId}`, companyId: "company", runId: "run", issueId: "issue", scope: "run",
      dispatched: true, dispatchState: "acknowledged", reasonCode: "cancellation_run_only", effects: ["release_run_resources"], intentAuditId: "audit-intent", acknowledgementAuditId: "audit-ack",
    } };
    return run;
  };
  return { scope, events, run, issue, row, notice, state, pending, settle, permissionResponse };
}
const frame = (row: Row) => row.payload.prpEvent;
const payload = (row: Row) => frame(row).payload;
const arrivalOrders = ["tool-first", "permission-first"] as const;
function withArrivalOrder(provider: ActiveStopProvider, order: typeof arrivalOrders[number]) {
  const f = fixture(provider);
  if (order === "permission-first") {
    // Isolate canonical card/start order in these synthetic mutation cases.
    // Actual provider-specific notice ordering is exercised by the projectors.
    f.events.unshift(f.events.pop()!);
    f.events.forEach((row, index) => {
      row.seq = frame(row).sourceSeq = index + 1;
      frame(row).sourceEventId = `source:run:${index + 1}`;
    });
  }
  return f;
}
function withProjectedArrivalOrder(provider: ActiveStopProvider, order: typeof arrivalOrders[number]) {
  const f = fixture(provider), start = payload(f.events[1]!), card = payload(f.events[3]!);
  const command = "printf MUST_NOT_EXIST > target.txt";
  if (provider === "cursor") {
    f.scope.commandSha256 = `sha256:${createHash("sha256").update(command).digest("hex")}`;
    start.commandSha256 = f.scope.commandSha256;
  }
  f.events.length = 0;
  const append = (eventType: string, value: Row) => f.events.push(f.row(f.events.length + 1, eventType, value));
  const projector = (provider === "cursor" ? createCursorToolEvidence : createCopilotToolEvidence)({
    sessionId: "native-session", turnId: "turn", workingDirectory: "/fixture", active: () => true,
    emit: (event: CanonicalProviderEvent) => { append(event.eventType, event.payload); },
  });
  const tool = { type: "tool_call", tag: "tool_call", toolCallId: "tool", status: "pending",
    ...(provider === "cursor" ? { kind: "execute", rawInput: { command } } : { kind: "edit", rawInput: { fileName: "target.txt" } }),
  };
  let delivered: ((outcome: string) => void) | undefined, beforeTool: Row[] | undefined;
  const permission = () => {
    delivered = projector.permission({ raw: { sessionId: "native-session", toolCall: provider === "cursor"
      ? { toolCallId: "tool", kind: "execute" } : { toolCallId: "tool", kind: "edit", rawInput: tool.rawInput } } }, "request", ["decline", "cancel"]);
    // Match the sidecar: invoke the evidence projector before publishing the
    // permission request; project each iterator tool before its canonical row.
    append("runtime_request.created", card);
  };
  const notification = () => { projector.tool(tool); append("tool.execution.started", start); };
  if (order === "permission-first") { permission(); beforeTool = structuredClone(f.events); notification(); }
  else { notification(); permission(); }
  if (!delivered) throw new Error("Native permission projector rejected the fixture");
  return { ...f, beforeTool, delivered, nativeStageOrder: () => f.events.filter(row => row.eventType === "provider.notice.recorded").map(row => payload(row).provenance.eventType) };
}
function settled() { const f = fixture(); const pending = f.pending(); f.settle(); return { f, pending, read: () => readActiveStopSettlement({ ...f.state(), pending, dispatchMonotonicNs: (BigInt(pending.observedMonotonicNs) + 1n).toString() }) }; }
function withSessionPrefix(provider: ActiveStopProvider = "cursor") {
  const f = fixture(provider);
  // The retained failed attempt contained v1 session.started followed by these
  // v2 session events before its v1 tool/permission events. Keep that shape;
  // this synthetic fixture supplies the otherwise required native tool proof.
  for (const row of f.events) {
    row.seq += 30; frame(row).sourceSeq += 3;
    frame(row).sourceEventId = `source:run:${frame(row).sourceSeq}`;
  }
  const prefix = [f.row(17, "session.started", {}),
    f.row(19, "session.capabilities.updated", { sessionGoals: null }),
    f.row(21, "session.goal.snapshot", { goal: null, workingNow: false })];
  prefix.forEach((row, index) => {
    const e = frame(row); e.turnId = null; e.sourceSeq = index + 1; e.sourceEventId = `source:run:${index + 1}`;
    if (index > 0) { row.protocolSchemaVersion = 2; e.schema = "paperclip.prp.event.v2"; e.schemaVersion = 2; }
  });
  f.events.unshift(...prefix);
  return f;
}

describe("definitely active native permission Stop", () => {
  describe.each(["cursor", "copilot"] as const)("%s pre-Stop arrival orders", provider => {
    it.each(arrivalOrders)("accepts %s only after both exact origins exist and retains them through settlement", order => {
      const f = withProjectedArrivalOrder(provider, order), pending = f.pending();
      expect(f.nativeStageOrder()).toEqual(provider === "copilot" && order === "permission-first"
        ? ["permission_requested", "tool"] : ["tool", "permission_requested"]);
      expect(pending.schema).toBe("paperclip.e2e.native-active-stop-pending.v2");
      expect(pending.toolOriginRowSha256).toMatch(/^sha256:[a-f0-9]{64}$/u);
      expect(pending.toolStartedRowSha256).toMatch(/^sha256:[a-f0-9]{64}$/u);
      expect(pending.toolStartedSourceSeq < pending.requestSourceSeq).toBe(order === "tool-first");
      f.settle();
      expect(readActiveStopSettlement({ ...f.state(), pending, dispatchMonotonicNs: (BigInt(pending.observedMonotonicNs) + 1n).toString() }))
        .toMatchObject({ branch: "pending_permission_cancelled", pending });
    });
    it("cannot retain permission-only projector output before its exact origin arrives", () => {
      const f = withProjectedArrivalOrder(provider, "permission-first");
      expect(() => observeActiveStopPending({ ...f.state(), events: f.beforeTool!, scope: f.scope, caller, cancellationRequestId })).toThrow();
    });
    it.each(arrivalOrders)("rejects a delivered answer in real-projector %s evidence", order => {
      const f = withProjectedArrivalOrder(provider, order); f.delivered("cancel"); expect(f.pending).toThrow("permission already answered");
    });
    it("does not accept a permission-first request for a different native origin", () => {
      const f = withProjectedArrivalOrder(provider, "permission-first");
      const tool = f.events.find(row => row.eventType === "provider.notice.recorded" && payload(row).provenance.eventType === "tool")!;
      payload(tool).details.find((d: Row) => d.name === "toolCallId").value = "another-tool";
      expect(f.pending).toThrow("native operation origin missing");
    });
    it.each([
      ["missing native origin", (f: ReturnType<typeof fixture>) => { f.events.splice(1, 1); }],
      ["missing canonical start", (f: ReturnType<typeof fixture>) => { f.events.splice(2, 1); }],
      ["wrong native tool", (f: ReturnType<typeof fixture>) => { payload(f.events[1]!).details.find((d: Row) => d.name === "toolCallId").value = "other"; }],
      ["wrong canonical tool", (f: ReturnType<typeof fixture>) => { payload(f.events[2]!).executionId = "other"; }],
      ["wrong command or path", (f: ReturnType<typeof fixture>) => { payload(f.events[1]!).details.find((d: Row) => d.name === (provider === "cursor" ? "commandSha256" : "target")).value = provider === "cursor" ? `sha256:${"b".repeat(64)}` : "other.txt"; }],
      ["wrong source", (f: ReturnType<typeof fixture>) => { frame(f.events[2]!).sourceInstanceId = "other"; frame(f.events[2]!).sourceEventId = "other:run:3"; }],
      ["wrong turn", (f: ReturnType<typeof fixture>) => { frame(f.events[2]!).turnId = "other"; }],
      ["wrong request", (f: ReturnType<typeof fixture>) => { payload(f.events[0]!).request.requestId = "other"; }],
      ["replayed canonical start", (f: ReturnType<typeof fixture>) => { f.events.push(f.row(5, "tool.execution.started", payload(f.events[2]!))); }],
      ["replayed native origin", (f: ReturnType<typeof fixture>) => { f.events.push(f.row(5, "provider.notice.recorded", payload(f.events[1]!))); }],
      ["answered permission", (f: ReturnType<typeof fixture>) => { f.events.push(f.notice(5, "permission_delivered", { requestId: "request", outcome: "cancel" })); }],
      ["terminal operation", (f: ReturnType<typeof fixture>) => { f.events.push(f.row(5, "tool.execution.completed", { schema: "paperclip.tool.execution.v1", transport: "builtin", executionId: "tool", status: "failed" })); }],
    ] as const)("rejects permission-first %s before Stop", (_label, mutate) => {
      const f = withArrivalOrder(provider, "permission-first"); mutate(f); expect(f.pending).toThrow();
    });
    it("cannot substitute a canonical start first observed after Stop", () => {
      const f = withArrivalOrder(provider, "permission-first"), pending = f.pending();
      const started = f.events.splice(2, 1)[0]!;
      // A late row has a new durable identity even when every operation field
      // is identical. Final evidence must not backfill the retained receipt.
      started.seq = frame(started).sourceSeq = 5; frame(started).sourceEventId = "source:run:5";
      f.events.push(started); f.settle();
      for (const row of f.events.slice(-2)) {
        row.seq += 1; frame(row).sourceSeq += 1; frame(row).sourceEventId = `source:run:${row.seq}`;
      }
      expect(() => readActiveStopSettlement({ ...f.state(), pending, dispatchMonotonicNs: (BigInt(pending.observedMonotonicNs) + 1n).toString() }))
        .toThrow("observed pending request changed");
    });
  });
  it("still rejects a Cursor permission notice before the origin its projector requires", () => {
    const f = withProjectedArrivalOrder("cursor", "permission-first");
    [f.events[1], f.events[2]] = [f.events[2]!, f.events[1]!];
    f.events.forEach((row, index) => {
      row.seq = frame(row).sourceSeq = index + 1; frame(row).sourceEventId = `source:run:${index + 1}`;
    });
    expect(f.pending).toThrow("duplicate native operation lifecycle");
  });
  it.each(["cursor", "copilot"] as const)("accepts the mixed v1/v2 session prefix before strict %s pending proof", provider => {
    const f = withSessionPrefix(provider);
    expect(f.pending()).toMatchObject({ requestId: "request", toolCallId: "tool", permissionSourceSeq: 6, requestSourceSeq: 7 });
  });
  it.each([
    ["schema/version mismatch", (f: ReturnType<typeof withSessionPrefix>) => { frame(f.events[1]!).schemaVersion = 1; }],
    ["row/envelope mismatch", (f: ReturnType<typeof withSessionPrefix>) => { f.events[1]!.protocolSchemaVersion = 1; }],
    ["unknown schema", (f: ReturnType<typeof withSessionPrefix>) => { frame(f.events[1]!).schema = "paperclip.prp.event.v3"; frame(f.events[1]!).schemaVersion = f.events[1]!.protocolSchemaVersion = 3; }],
    ["foreign session source", (f: ReturnType<typeof withSessionPrefix>) => { frame(f.events[1]!).sourceKind = "provider"; }],
  ] as const)("still rejects %s in a mixed-version stream", (_label, mutate) => {
    const f = withSessionPrefix(); mutate(f); expect(f.pending).toThrow("invalid/duplicate/foreign canonical row");
  });
  it("does not let a valid v2 prefix hide the retained Cursor incomplete-evidence failure", () => {
    const f = withSessionPrefix();
    const notice = f.events.find(row => row.eventType === "provider.notice.recorded")!;
    payload(notice).provenance.eventType = "evidence_incomplete";
    payload(notice).details = Object.entries({ stage: "evidence_incomplete", toolCallId: "unavailable", reason: "projection_failed" }).map(([name, value]) => ({ name, value }));
    expect(f.pending).toThrow("Cursor evidence is explicitly incomplete");
  });
  it("still requires the original native tool ID on the durable card after a valid v2 prefix", () => {
    const f = withSessionPrefix();
    delete payload(f.events.find(row => row.eventType === "runtime_request.created")!).request.details.toolCallId;
    expect(f.pending).toThrow("native notice/card identity mismatch");
  });
  it.each(["cursor", "copilot"] as const)("binds %s's unanswered callback to cancelled provider settlement and caller-owned Stop", provider => {
    const f = fixture(provider), pending = f.pending(); f.settle();
    expect(f.permissionResponse.mock.calls).toEqual([[{ action: "cancel" }]]);
    expect(readActiveStopSettlement({ ...f.state(), pending, dispatchMonotonicNs: (BigInt(pending.observedMonotonicNs) + 1n).toString() })).toMatchObject({
      schema: "paperclip.e2e.native-active-stop-settlement.v2", branch: "pending_permission_cancelled", normalCompletionAccepted: false, taskStillInProgress: true, replayAllowed: false,
      pending: { normalizedSessionId: "normalized-session", nativeSessionId: "native-session", cancellationRequestId },
    });
  });
  it("matches the retained Product closure shape with distinct native and item identities", () => {
    const { f, pending, read } = settled();
    expect(pending.toolCallId).toBe("tool");
    // Content-free shape captured from the failed Product attempt. These exact
    // payloads come from mapTerminalTurn -> cancelPendingRequests above.
    expect(payload(f.events[4]!)).toEqual({ requestId: "request", requestKind: "permission_approval",
      turnId: "turn", itemId: "item-run", reason: "turn_terminal" });
    expect(payload(f.events[5]!)).toEqual({ status: "cancelled", error: null });
    expect(read().schema).toBe("paperclip.e2e.native-active-stop-settlement.v2");
  });
  it("admits only a fully attested remote bootstrap read completed before the pending operation", () => {
    const f = fixture(), actionFile = `.paperclip-eval-action-${"a".repeat(36)}.txt`;
    const readTargetSha256 = `sha256:${createHash("sha256").update(actionFile).digest("hex")}`;
    for (const row of f.events) { row.seq += 4; frame(row).sourceSeq += 4; frame(row).sourceEventId = `source:run:${row.seq}`; }
    f.events.unshift(f.notice(1, "tool", { toolCallId: "bootstrap", operation: "read", status: "pending", readTargetSha256 }),
      f.row(2, "tool.execution.started", { schema: "paperclip.tool.execution.v1", executionId: "bootstrap", transport: "builtin", status: "running", operation: "read", target: actionFile }),
      f.notice(3, "tool", { toolCallId: "bootstrap", operation: "read", status: "completed", readTargetSha256 }),
      f.row(4, "tool.execution.completed", { schema: "paperclip.tool.execution.v1", executionId: "bootstrap", transport: "builtin", status: "completed", operation: "read", target: actionFile }));
    const bootstrap = { actionFile, events: f.events };
    expect(() => observeActiveStopPending({ ...f.state(), scope: f.scope, caller, cancellationRequestId, bootstrap })).not.toThrow();
    payload(f.events[2]!).details.find((d: Row) => d.name === "readTargetSha256").value = `sha256:${"0".repeat(64)}`;
    expect(() => observeActiveStopPending({ ...f.state(), scope: f.scope, caller, cancellationRequestId, bootstrap })).toThrow(/bootstrap/);
  });
  it("does not compare remote wall clock or transaction timestamps to the operator clock", () => {
    const f = fixture(); for (const row of f.events) { frame(row).emittedAt = "2099-01-01T00:00:00Z"; row.createdAt = "1900-01-01T00:00:00Z"; }
    const pending = f.pending(); f.settle();
    expect(() => readActiveStopSettlement({ ...f.state(), pending, dispatchMonotonicNs: (BigInt(pending.observedMonotonicNs) + 1n).toString() })).not.toThrow();
  });
  it.each([
    ["prior Stop claim", (f: ReturnType<typeof fixture>) => { f.run.resultJson.startupCancellation = { cancellationRequestId }; }],
    ["answered callback", (f: ReturnType<typeof fixture>) => { f.events.push(f.notice(5, "permission_delivered", { requestId: "request", outcome: "cancel" })); }],
    ["already settled provider", (f: ReturnType<typeof fixture>) => { f.events.push(f.row(5, "turn.completed", { status: "completed" })); }],
    ["already closed request", (f: ReturnType<typeof fixture>) => { f.events.push(f.row(5, "runtime_request.resolved", {})); }],
    ["failed operation", (f: ReturnType<typeof fixture>) => { f.events.push(f.row(5, "tool.execution.completed", { schema: "paperclip.tool.execution.v1", transport: "builtin", executionId: "tool", status: "failed" })); }],
  ] as const)("refuses %s before dispatch", (_label, mutate) => { const f = fixture(); mutate(f); expect(f.pending).toThrow(); });
  it.each([
    ["completed terminal", ({ f }: ReturnType<typeof settled>) => { f.events[5]!.eventType = frame(f.events[5]!).eventType = "turn.completed"; payload(f.events[5]!).status = "completed"; }],
    ["interrupted terminal", ({ f }: ReturnType<typeof settled>) => { f.events[5]!.eventType = frame(f.events[5]!).eventType = "turn.interrupted"; payload(f.events[5]!).status = "interrupted"; }],
    ["failed terminal", ({ f }: ReturnType<typeof settled>) => { payload(f.events[5]!).error = { code: "failure" }; }],
    ["duplicate terminal", ({ f }: ReturnType<typeof settled>) => { f.events.push(f.row(7, "turn.cancelled", payload(f.events[5]!))); }],
    ["late same-tool replay", ({ f }: ReturnType<typeof settled>) => { f.events.push(f.notice(7, "tool", { status: "in_progress" })); }],
    ["wrong closed item", ({ f }: ReturnType<typeof settled>) => { payload(f.events[4]!).itemId = "other"; }],
    ["reordered source stream", ({ f }: ReturnType<typeof settled>) => { frame(f.events[5]!).sourceSeq = 1; frame(f.events[5]!).sourceEventId = "source:run:1"; }],
    ["missing terminal", ({ f }: ReturnType<typeof settled>) => { f.events.pop(); }],
    ["wrapper type mismatch", ({ f }: ReturnType<typeof settled>) => { f.events[5]!.eventType = "turn.completed"; }],
    ["foreign normalized session", ({ f }: ReturnType<typeof settled>) => { frame(f.events[5]!).normalizedSessionId = "native-session"; }],
    ["foreign source", ({ f }: ReturnType<typeof settled>) => { frame(f.events[5]!).sourceInstanceId = "foreign"; }],
    ["foreign turn", ({ f }: ReturnType<typeof settled>) => { frame(f.events[5]!).turnId = "other-turn"; }],
    ["foreign company", ({ f }: ReturnType<typeof settled>) => { f.events[5]!.companyId = "other"; }],
    ["foreign request", ({ f }: ReturnType<typeof settled>) => { payload(f.events[4]!).requestId = "other"; }],
    ["expired rather than cancelled", ({ f }: ReturnType<typeof settled>) => { f.events[4]!.eventType = frame(f.events[4]!).eventType = "runtime_request.expired"; }],
    ["provider death", ({ f }: ReturnType<typeof settled>) => { payload(f.events[4]!).reason = "provider_process_lost"; }],
    ["raw backend closure is not the Product contract", ({ f }: ReturnType<typeof settled>) => { payload(f.events[4]!).reason = "explicit_cancellation"; }],
    ["answered closure", ({ f }: ReturnType<typeof settled>) => { payload(f.events[4]!).action = "accept"; }],
    ["resolved request", ({ f }: ReturnType<typeof settled>) => { f.events[4]!.eventType = frame(f.events[4]!).eventType = "runtime_request.resolved"; }],
    ["duplicate closure", ({ f }: ReturnType<typeof settled>) => { f.events.push(f.row(7, "runtime_request.cancelled", payload(f.events[4]!))); }],
    ["foreign closure turn", ({ f }: ReturnType<typeof settled>) => { payload(f.events[4]!).turnId = "other"; }],
    ["missing acknowledgement", ({ f }: ReturnType<typeof settled>) => { delete f.run.resultJson.nativeCancellation.acknowledgementAuditId; }],
    ["unacknowledged intent", ({ f }: ReturnType<typeof settled>) => { f.run.resultJson.nativeCancellation.dispatchState = "pending"; }],
    ["replay permitted", ({ f }: ReturnType<typeof settled>) => { payload(f.events[4]!).replayAllowed = true; }],
    ["tampered pending row", ({ f }: ReturnType<typeof settled>) => { payload(f.events[3]!).request.itemId = "changed"; }],
    ["missing pending receipt", (s: ReturnType<typeof settled>) => { s.pending.requestRowSha256 = ""; }],
    ["legacy v1 pending receipt", (s: ReturnType<typeof settled>) => { (s.pending as Row).schema = "paperclip.e2e.native-active-stop-pending.v1"; }],
    ["missing native origin binding", (s: ReturnType<typeof settled>) => { delete (s.pending as Row).toolOriginRowSha256; }],
    ["missing tool start binding", (s: ReturnType<typeof settled>) => { delete (s.pending as Row).toolStartedRowSha256; }],
    ["changed native origin", ({ f }: ReturnType<typeof settled>) => { frame(f.events[0]!).emittedAt = "2026-01-01T00:00:01Z"; }],
    ["changed tool start", ({ f }: ReturnType<typeof settled>) => { frame(f.events[1]!).emittedAt = "2026-01-01T00:00:01Z"; }],
    ["wrong origin sequence", (s: ReturnType<typeof settled>) => { s.pending.toolOriginSourceSeq += 1; }],
    ["wrong start sequence", (s: ReturnType<typeof settled>) => { s.pending.toolStartedSourceSeq += 1; }],
    ["missing caller", ({ f }: ReturnType<typeof settled>) => { delete f.run.resultJson.startupCancellation.requestedBy; }],
    ["null caller", ({ f }: ReturnType<typeof settled>) => { f.run.resultJson.startupCancellation.requestedBy.userId = null; }],
    ["foreign caller", ({ f }: ReturnType<typeof settled>) => { f.run.resultJson.startupCancellation.requestedBy.userId = "another-board-user"; }],
    ["agent caller", ({ f }: ReturnType<typeof settled>) => { f.run.resultJson.startupCancellation.requestedBy.type = "agent"; }],
    ["unbound caller receipt", (s: ReturnType<typeof settled>) => { (s.pending as Row).caller = null; }],
    ["foreign intent", ({ f }: ReturnType<typeof settled>) => { f.run.resultJson.nativeCancellation.intentId = "native-cancellation:other"; }],
    ["foreign ack scope", ({ f }: ReturnType<typeof settled>) => { f.run.resultJson.nativeCancellation.companyId = "other"; }],
    ["undispatched cancellation", ({ f }: ReturnType<typeof settled>) => { f.run.resultJson.nativeCancellation.dispatched = false; }],
    ["same audit twice", ({ f }: ReturnType<typeof settled>) => { f.run.resultJson.nativeCancellation.acknowledgementAuditId = "audit-intent"; }],
    ["finished task", ({ f }: ReturnType<typeof settled>) => { f.issue.status = "done"; }],
    ["extra semantic operation", ({ f }: ReturnType<typeof settled>) => { f.events.push(f.row(7, "tool.execution.started", { executionId: "other" })); }],
    ["extra native operation", ({ f }: ReturnType<typeof settled>) => { f.events.push(f.notice(7, "tool", { toolCallId: "other", status: "pending" })); }],
    ["native session switched", ({ f }: ReturnType<typeof settled>) => { payload(f.events[0]!).provenance.sessionId = "other"; }],
    ["target operation completed", ({ f }: ReturnType<typeof settled>) => { f.events.push(f.row(7, "tool.execution.completed", { schema: "paperclip.tool.execution.v1", transport: "builtin", executionId: "tool", status: "completed" })); }],
  ] as const)("rejects %s", (_label, mutate) => { const s = settled(); mutate(s); expect(s.read).toThrow(); });
  it.each(["closure", "terminal"] as const)("rejects missing/null envelope turn and foreign null-turn stream on %s", kind => {
    for (const turn of [null, undefined]) for (const mismatch of ["none", "session", "source"]) {
      const s = settled(), event = frame(s.f.events[kind === "closure" ? 4 : 5]!);
      event.turnId = turn;
      if (mismatch === "session") event.normalizedSessionId = "foreign-session";
      if (mismatch === "source") { event.sourceInstanceId = "foreign-source"; event.sourceEventId = `foreign-source:run:${event.sourceSeq}`; }
      expect(s.read).toThrow(/pending callback/);
    }
  });
  it.each([
    [{ deploymentMode: "authenticated" }, { session: { userId: "local-board", id: "paperclip:local_implicit:local-board" } }],
    [{ deploymentMode: "local_trusted" }, { session: { userId: null, id: "paperclip:local_implicit:local-board" } }],
    [{ deploymentMode: "local_trusted" }, { session: { userId: "another", id: "paperclip:local_implicit:another" } }],
    [{ deploymentMode: "local_trusted" }, { session: { userId: "local-board", id: "paperclip:session:local-board" } }],
  ])("rejects a non-fixture authentication context", (health, session) => expect(() => readActiveStopCaller(health, session)).toThrow());
  it("rejects a Stop dispatch not causally after the pending observation", () => {
    const { f, pending } = settled();
    expect(() => readActiveStopSettlement({ ...f.state(), pending, dispatchMonotonicNs: pending.observedMonotonicNs })).toThrow(/pre-dispatch/);
  });
});

describe("active Stop flow wiring", () => {
  it.each([
    ["cursor", "tool-first"], ["cursor", "permission-first"],
    ["copilot", "tool-first"], ["copilot", "permission-first"],
  ] as const)("awaits retention and rechecks real %s %s evidence before issuing the single caller UUID request", async (provider, arrivalOrder) => {
    const f = withProjectedArrivalOrder(provider, arrivalOrder); const order: string[] = []; let retainedId = "";
    const stop = vi.fn(async (runId: string, id: string) => { expect(runId).toBe("run"); expect(id).toBe(retainedId); order.push("stop"); return f.settle(id); });
    const result = await stopAtPendingPermission({ scope: f.scope, caller, deadlineAt: Date.now() + 1000,
      load: async () => { order.push("load"); return f.state(); },
      retain: async receipt => { order.push("retain-start"); await Promise.resolve(); retainedId = receipt.cancellationRequestId; order.push("retain-done"); }, stop });
    expect(order).toEqual(["load", "retain-start", "retain-done", "load", "stop", "load"]);
    expect(stop).toHaveBeenCalledTimes(1); expect(result.settlement.branch).toBe("pending_permission_cancelled");
  });
  it.each(["retention failed", "competing Stop", "answered after capture"])("never sends Stop when %s", async mode => {
    const f = fixture(), stop = vi.fn();
    await expect(stopAtPendingPermission({ scope: f.scope, caller, deadlineAt: Date.now() + 1000, load: async () => f.state(), stop,
      retain: async () => { if (mode === "retention failed") throw Error("disk failure"); if (mode === "competing Stop") f.run.resultJson.startupCancellation = { cancellationRequestId: "foreign" }; else f.events.push(f.row(5, "runtime_request.resolved", {})); },
    })).rejects.toThrow(); expect(stop).not.toHaveBeenCalled();
  });
  it.each(["native origin", "canonical start"])("never sends Stop when the retained %s changes before the fresh reread", async kind => {
    const f = withArrivalOrder("cursor", "permission-first"), stop = vi.fn();
    await expect(stopAtPendingPermission({ scope: f.scope, caller, deadlineAt: Date.now() + 1000, load: async () => f.state(), stop,
      retain: async () => { frame(f.events[kind === "native origin" ? 1 : 2]!).emittedAt = "2026-01-01T00:00:01Z"; },
    })).rejects.toThrow("pending boundary changed or expired");
    expect(stop).not.toHaveBeenCalled();
  });
  it("never sends Stop to make a missing tool start arrive", async () => {
    const f = withArrivalOrder("cursor", "permission-first");
    const start = f.events.splice(2, 1)[0]!, retain = vi.fn();
    const stop = vi.fn(async () => { f.events.push(start); return f.settle(); });
    await expect(stopAtPendingPermission({ scope: f.scope, caller, deadlineAt: Date.now() + 1000, load: async () => f.state(), retain, stop }))
      .rejects.toThrow("duplicate canonical operation lifecycle");
    expect(retain).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled();
  });
  it("fails promptly on a definitive provider failure before calling a throwing evidence reader", async () => {
    const f = fixture(); const started = Date.now();
    await expect(stopAtPendingPermission({ scope: f.scope, caller, deadlineAt: started + 10000, load: async () => f.state(), retain: async () => {}, stop: async (_run, id) => {
      f.settle(id); f.run.status = "failed"; f.events.length = 0; return f.run;
    } })).rejects.toThrow(/Stopped waiting.*unexpected run terminal/);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe("explicit active Stop discovery", () => {
  it("adds exactly four versioned cells without enabling them in --all", () => {
    const suite = runnerSuites.find(s => s.id === "native-active-stop")!;
    const cells = runnerMatrix.filter(e => e.suite === suite);
    expect(cells).toHaveLength(4); expect(suite.manualOnly).toBe(true);
    expect(cells.map(e => `${e.profile.qualificationCandidate}/${e.environment.id}`).sort()).toEqual(["copilot/daytona", "copilot/local", "cursor/daytona", "cursor/local"]);
    expect(cells.every(e => e.task.expectedRunCount === 1 && e.task.flow === "native_active_stop" && e.task.expectedTerminalState?.run === "cancelled")).toBe(true);
    expect(suite.definitionMetadata).toMatchObject({ version: 20, evidence: "paperclip.e2e.native-active-stop-settlement.v2", normalCompletionAccepted: false, providerDeath: "not-covered" });
    expect(suiteDefinitionHash(suite)).not.toBe(suiteDefinitionHash({ ...suite, definitionMetadata: { ...suite.definitionMetadata, version: 3 } }));
    expect(suiteDefinitionHash(suite)).not.toBe(suiteDefinitionHash({ ...suite, definitionMetadata: { ...suite.definitionMetadata, normalCompletionAccepted: true } }));
    expect(selectRunnerExecutions(parseRunnerSelectors(["--all"])).some(e => e.suite.id === suite.id)).toBe(false);
  });
});


describe("active Stop cleanup remains mandatory", () => {
  const proof = () => ({ environment: "local" as const, completed: true, identityChanged: false, processes: { captured: true, live: [] as number[] },
    watcher: { complete: true, targetMutationCount: 0 }, samples: ["before-request", "pending", "after-stop", "after-cleanup"].map(phase => ({ phase, absent: true })) });
  it("requires all causal samples plus the continuous watcher and retired owned identities", () => expect(() => assertActiveStopRetirement(proof())).not.toThrow());
  it.each([
    ["live child", (p: ReturnType<typeof proof>) => { p.processes.live.push(42); }],
    ["unobserved process", (p: ReturnType<typeof proof>) => { p.processes.captured = false; }],
    ["replaced root", (p: ReturnType<typeof proof>) => { p.identityChanged = true; }],
    ["incomplete watch", (p: ReturnType<typeof proof>) => { p.watcher.complete = false; }],
    ["transient write", (p: ReturnType<typeof proof>) => { p.watcher.targetMutationCount = 1; }],
    ["written target", (p: ReturnType<typeof proof>) => { p.samples[2]!.absent = false; }],
    ["missing final sample", (p: ReturnType<typeof proof>) => { p.samples.pop(); }],
    ["missing settlement", (p: ReturnType<typeof proof>) => { p.completed = false; }],
  ] as const)("rejects %s even after an apparent cancelled run", (_label, mutate) => { const p = proof(); mutate(p); expect(() => assertActiveStopRetirement(p)).toThrow(); });
});

function remoteRetirementProof() {
  const root = { pid: 50, ppid: 1, startTicks: "200", bootId: "12345678-1234-1234-1234-123456789abc" };
  const child = { ...root, pid: 51, ppid: 50, startTicks: "201" };
  const snapshot = (sequence: number, live: number[]) => ({
    binding: { companyId: "company", environmentId: "env", runId: "run", leaseId: "lease", sandboxId: "sandbox", image: `image@sha256:${"a".repeat(64)}`, remoteCwd: "/home/daytona/workspace" },
    observedAtMs: sequence, receivedAtMs: sequence + 1, observedMonotonicNs: String(sequence), complete: true, workspace: {},
    targets: { "target.txt": { absent: true, sha256: null, complete: true, mutationCount: 0, parent: { dev: "1", ino: "2" } } },
    watcher: { complete: true, targetMutationCount: 0, workspaceMutationCount: 0 },
    processes: { captured: true, root, journal: [root, child], live },
    setup: { path: ".action.txt", sha256: sequence === 1 ? null : `sha256:${"b".repeat(64)}`, published: sequence !== 1 }, attached: null,
  });
  const observations: ActiveStopRemoteObservation[] = [
    { phase: "before-request", source: "live-snapshot", snapshot: snapshot(1, [50, 51]) },
    { phase: "pending", source: "live-snapshot", snapshot: snapshot(2, [50, 51]) },
    { phase: "owned-process-retirement", source: "retirement-seal", snapshot: snapshot(3, []) },
  ];
  return { scope: { companyId: "company", runId: "run", target: "target.txt" }, observations };
}
describe("Daytona active Stop observation lifetime", () => {
  it("binds one continuous owned-tree retirement seal without claiming a later filesystem observation", () => {
    const remote = remoteRetirementProof(), terminal = remote.observations[2]!.snapshot;
    expect(assertActiveStopRetirement({ environment: "daytona", completed: true, identityChanged: false,
      processes: terminal.processes, watcher: terminal.watcher, remote })).toMatchObject({
      schema: "paperclip.e2e.native-active-stop-remote-retirement.v1", coverage: "continuous-through-owned-process-retirement",
      filesystemAfterRetirementObserved: false, observations: [
        { phase: "before-request", source: "live-snapshot" }, { phase: "pending", source: "live-snapshot" },
        { phase: "owned-process-retirement", source: "retirement-seal" },
      ],
    });
  });
  it.each([
    ["seal relabeled fresh", (p: ReturnType<typeof remoteRetirementProof>) => { p.observations[2]!.source = "live-snapshot"; }],
    ["seal replayed as pending", (p: ReturnType<typeof remoteRetirementProof>) => { p.observations[1]!.snapshot = p.observations[2]!.snapshot; }],
    ["after-UI seal replay", (p: ReturnType<typeof remoteRetirementProof>) => { p.observations.push({ ...p.observations[2]!, phase: "after-cleanup" as any }); }],
    ["missing pending", (p: ReturnType<typeof remoteRetirementProof>) => { p.observations.splice(1, 1); }],
    ["all foreign run snapshots", (p: ReturnType<typeof remoteRetirementProof>) => { for (const o of p.observations) o.snapshot.binding.runId = "other"; }],
    ["all foreign company snapshots", (p: ReturnType<typeof remoteRetirementProof>) => { for (const o of p.observations) o.snapshot.binding.companyId = "other"; }],
    ["foreign lease", (p: ReturnType<typeof remoteRetirementProof>) => { p.observations[2]!.snapshot.binding.leaseId = "other"; }],
    ["foreign run", (p: ReturnType<typeof remoteRetirementProof>) => { p.observations[1]!.snapshot.binding.runId = "other"; }],
    ["replacement root", (p: ReturnType<typeof remoteRetirementProof>) => { p.observations[2]!.snapshot.processes.root = { ...p.observations[2]!.snapshot.processes.root!, startTicks: "300" }; }],
    ["live child", (p: ReturnType<typeof remoteRetirementProof>) => { p.observations[2]!.snapshot.processes.live = [51]; }],
    ["lost child journal", (p: ReturnType<typeof remoteRetirementProof>) => { p.observations[2]!.snapshot.processes.journal.pop(); }],
    ["unobserved pending root", (p: ReturnType<typeof remoteRetirementProof>) => { p.observations[1]!.snapshot.processes.live = []; }],
    ["transient target mutation", (p: ReturnType<typeof remoteRetirementProof>) => { p.observations[2]!.snapshot.watcher.targetMutationCount = 1; }],
    ["workspace mutation", (p: ReturnType<typeof remoteRetirementProof>) => { p.observations[2]!.snapshot.watcher.workspaceMutationCount = 1; }],
    ["late target present", (p: ReturnType<typeof remoteRetirementProof>) => { p.observations[2]!.snapshot.targets["target.txt"]!.absent = false; }],
    ["incomplete watcher", (p: ReturnType<typeof remoteRetirementProof>) => { p.observations[2]!.snapshot.watcher.complete = false; }],
    ["changed action", (p: ReturnType<typeof remoteRetirementProof>) => { p.observations[2]!.snapshot.setup.sha256 = `sha256:${"c".repeat(64)}`; }],
  ] as const)("rejects %s", (_label, mutate) => {
    const proof = remoteRetirementProof(); mutate(proof); expect(() => readActiveStopRemoteRetirement(proof)).toThrow();
  });
});
