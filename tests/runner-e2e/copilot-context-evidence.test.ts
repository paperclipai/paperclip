import { createHash } from "node:crypto";
import { applyMainlineStopMetadata, stopAcknowledgementForTest } from "./copilot-stop-test-fixtures.js";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { readCopilotContextRead } from "./copilot-context-evidence.js";
import { readCopilotToolEvidence } from "./copilot-evidence.js";
import { observeActiveStopPending, readActiveStopCaller, readActiveStopSettlement } from "./copilot-active-stop-evidence.js";
import { assertCopilotProviderDeath } from "./copilot-provider-death.js";

type Row = Record<string, any>;
const retained = JSON.parse(await readFile(new URL("./fixtures/copilot-context-attached-completion-v15.json", import.meta.url), "utf8"));
const discoveryFixture = JSON.parse(await readFile(new URL("./fixtures/copilot-context-discovery-permission-v15.json", import.meta.url), "utf8"));
const pendingFixture = JSON.parse(await readFile(new URL("./fixtures/copilot-context-permission-v15.json", import.meta.url), "utf8"));
const frame = (r: Row) => r.payload.prpEvent;
const payload = (r: Row) => frame(r).payload;
const setDetail = (r: Row, name: string, value: string) => { payload(r).details.find((d: Row) => d.name === name).value = value; };
const scope = { provider: "copilot" as const, companyId: "company", issueId: "issue", runId: "run", target: "target.txt", requireContextRead: true };
const caller = readActiveStopCaller({ deploymentMode: "local_trusted" }, { session: { userId: "local-board", id: "paperclip:local_implicit:local-board" } });
const cancellationRequestId = "11111111-2222-4333-8444-555555555555";
function row(seq: number, eventType: string, p: Row): Row {
  return { companyId: "company", runId: "run", seq, eventType, protocolSchemaVersion: 1, sourceInstanceId: "source", sourceSeq: seq,
    payload: { prpEvent: { schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceKind: "runner", eventType, runId: "run", turnId: "turn",
      normalizedSessionId: "session", sourceInstanceId: "source", sourceSeq: seq, sourceEventId: `source:run:${seq}`, emittedAt: "2026-10-03T00:00:00Z", payload: p } } };
}
function notice(seq: number, toolCallId: string, stage: string, fields: Row) {
  return row(seq, "provider.notice.recorded", { schema: "paperclip.provider.notice.v1", scope: "turn", category: "copilot_tool_evidence_v1",
    provenance: { sessionId: "native-session", turnId: "turn", eventType: stage, method: stage === "tool" ? "session/update" : "session/request_permission" },
    details: Object.entries({ stage, toolCallId, ...fields }).map(([name, value]) => ({ name, value: String(value) })) });
}
function fixture() {
  // Preserve the retained successful semantic receipt and tool hashes. Add a
  // normal permission-card decision using the independently retained pending
  // card; these synthetic combinations are calibration, never live evidence.
  const context = structuredClone(retained.rows.slice(0, 5));
  const contextId = payload(context[0]).details.find((d: Row) => d.name === "toolCallId").value;
  for (const r of context) {
    if (payload(r).provenance) Object.assign(payload(r).provenance, { sessionId: "native-session", turnId: "turn" });
  }
  const request = structuredClone(payload(pendingFixture.rows[0]).request);
  Object.assign(request, { requestId: "context-request", turnId: "turn", itemId: "context-item" });
  const events = [row(1, context[0].eventType, payload(context[0])), row(2, context[1].eventType, payload(context[1])),
    row(3, "runtime_request.created", { request }), notice(4, contextId, "permission_requested", { requestId: "context-request", declineOffered: true }),
    row(5, "runtime_request.resolved", { requestId: "context-request", turnId: "turn", requestKind: "permission_approval", action: "accept" }),
    notice(6, contextId, "permission_delivered", { requestId: "context-request", outcome: "allow_once" }),
    row(7, context[2].eventType, payload(context[2])), row(8, context[3].eventType, payload(context[3])), row(9, context[4].eventType, payload(context[4])),
    notice(10, "edit-tool", "tool", { status: "pending", operation: "edit", target: "target.txt" }),
    row(11, "tool.execution.started", { schema: "paperclip.tool.execution.v1", executionId: "edit-tool", transport: "builtin", status: "running", operation: "edit", target: "target.txt" }),
    row(12, "runtime_request.created", { request: { schema: "paperclip.runtime_request.v2", requestKind: "permission_approval", type: "permission", status: "pending",
      requestId: "edit-request", turnId: "turn", itemId: "edit-item", details: { toolCallId: "edit-tool" }, origin: { adapter: "acpx-runtime-sidecar", provider: "copilot", method: "session/request_permission" } } }),
    notice(13, "edit-tool", "permission_requested", { requestId: "edit-request", declineOffered: true, operation: "edit", target: "target.txt" })];
  const run: Row = { id: "run", companyId: "company", nativeIssueId: "issue", runtimeMode: "native", status: "running", resultJson: {} };
  const issue: Row = { id: "issue", companyId: "company", status: "in_progress" };
  const origin = () => readCopilotToolEvidence(events, "run").find(n => n.toolCallId === "edit-tool" && n.stage === "tool")!;
  const pending = () => observeActiveStopPending({ events, run, issue, scope, caller, cancellationRequestId });
  return { events, run, issue, origin, pending };
}
describe("successful context read with an explicit permission decision", () => {
  it("binds the current Copilot permission origin to the same successful read receipt", () => {
    const f = fixture();
    payload(f.events[2]).request.origin.provider = "copilot";
    // Current sidecar order: native request notice, then durable permission card.
    for (const [index, seq] of [[2, 4], [3, 3]]) {
      f.events[index].seq = seq; f.events[index].sourceSeq = seq;
      frame(f.events[index]).sourceSeq = seq; frame(f.events[index]).sourceEventId = `source:run:${seq}`;
    }
    expect(readCopilotContextRead(f.events, f.origin(), true)).toMatchObject({ permissionRequestId: "context-request", receiptSeq: 7 });
    expect(f.pending()).toMatchObject({ requestId: "edit-request" });
    for (const provider of ["cursor", "pi", "claude", "codex", "unknown"]) {
      payload(f.events[2]).request.origin.provider = provider;
      expect(() => readCopilotContextRead(f.events, f.origin(), true)).toThrow();
    }
  });

  it("attests the closed context read while retaining the unanswered mutation", () => {
    const f = fixture();
    expect(readCopilotContextRead(f.events, f.origin(), true)).toMatchObject({ permissionRequestId: "context-request", pendingSeq: 1, receiptSeq: 7, completedSeq: 8 });
    expect(f.pending()).toMatchObject({ requestId: "edit-request", toolCallId: "edit-tool" });
  });
  it.each([
    ["another operation", (rows: Row[]) => { payload(rows[2]).request.prompt = "report_progress"; }],
    ["foreign company", (rows: Row[]) => { rows[4].companyId = "other"; }],
    ["foreign turn", (rows: Row[]) => { frame(rows[4]).turnId = "other"; }],
    ["foreign source", (rows: Row[]) => { frame(rows[5]).sourceInstanceId = "other"; }],
    ["foreign bridge", (rows: Row[]) => { payload(rows[2]).request.origin.adapter = "untrusted"; }],
    ["session-wide approval", (rows: Row[]) => { setDetail(rows[5], "outcome", "allow_always"); }],
    ["rejected read", (rows: Row[]) => { payload(rows[4]).action = "decline"; }],
    ["late resolution", (rows: Row[]) => { rows[4].seq = 14; }],
    ["card after resolution", (rows: Row[]) => { rows[2].seq = 14; }],
    ["native request after resolution", (rows: Row[]) => { rows[3].seq = 14; }],
    ["missing resolution", (rows: Row[]) => { rows.splice(4, 1); }],
    ["replayed delivery", (rows: Row[]) => { rows.push(structuredClone(rows[5])); }],
    ["mutation target", (rows: Row[]) => { payload(rows[3]).details.push({ name: "target", value: "target.txt" }); }],
  ] as const)("refuses %s as a bootstrap exception", (_label, mutate) => {
    const f = fixture(); mutate(f.events);
    expect(() => readCopilotContextRead(f.events, f.origin(), true)).toThrow();
    expect(f.pending).toThrow();
  });
  it("settles only the pending write after Stop, without treating the earlier context answer as a write answer", () => {
    const f = fixture(), pending = f.pending();
    f.events.push(row(14, "runtime_request.cancelled", { requestId: "edit-request", turnId: "turn", requestKind: "permission_approval", itemId: "edit-item", reason: "turn_terminal" }),
      row(15, "turn.cancelled", { status: "cancelled", error: null }));
    f.run.status = "cancelled";
    f.run.resultJson = { startupCancellation: { cancellationRequestId, requestedBy: { type: "board", userId: "local-board" } }, nativeCancellation: {
      schema: "paperclip.native-cancellation.v1", intentId: `native-cancellation:${cancellationRequestId}`, companyId: "company", runId: "run", issueId: "issue", scope: "run",
      dispatched: true, dispatchState: "acknowledged", reasonCode: "cancellation_run_only", effects: ["release_run_resources"], intentAuditId: "intent-audit", acknowledgementAuditId: "ack-audit" } };
    applyMainlineStopMetadata(f.run);
    const stopAcknowledgement = stopAcknowledgementForTest(f.run, cancellationRequestId, (BigInt(pending.observedMonotonicNs) + 1n).toString());
    expect(readActiveStopSettlement({ ...f, stopAcknowledgement, pending, dispatchMonotonicNs: (BigInt(pending.observedMonotonicNs) + 1n).toString() })).toMatchObject({ normalCompletionAccepted: false, replayAllowed: false });
    f.events.push(row(16, "runtime_request.resolved", { requestId: "edit-request", action: "accept" }));
    expect(() => readActiveStopSettlement({ ...f, stopAcknowledgement, pending, dispatchMonotonicNs: (BigInt(pending.observedMonotonicNs) + 1n).toString() })).toThrow();
  });
  it("accepts provider death after the read and rejects a late mutation answer or any other approval", () => {
    const f = fixture(), pending = f.pending();
    f.run.status = "failed"; f.issue.status = "blocked";
    f.events.push(row(14, "runtime_request.expired", { requestId: "edit-request", turnId: "turn", requestKind: "permission_approval", reason: "provider_exit" }),
      row(15, "turn.failed", { error: { code: "AGENT_DISCONNECTED", message: "Provider exited" } }));
    expect(assertCopilotProviderDeath({ ...f, pending })).toMatchObject({ expired: true, mutationReplay: false });
    for (const extra of [notice(16, "edit-tool", "permission_delivered", { requestId: "edit-request", outcome: "allow_once" }),
      notice(16, "other-tool", "permission_delivered", { requestId: "other-request", outcome: "allow_once" }),
      notice(16, "edit-tool", "tool", { operation: "edit", target: "target.txt", status: "completed" })]) {
      expect(() => assertCopilotProviderDeath({ ...f, pending, events: [...f.events, extra] })).toThrow();
    }
  });
});


function withDiscovery() {
  const f = fixture();
  for (const r of f.events) { r.seq += 9; r.sourceSeq += 9; frame(r).sourceSeq += 9; frame(r).sourceEventId = `source:run:${frame(r).sourceSeq}`; }
  const request = structuredClone(payload(discoveryFixture.rows[0]).request);
  Object.assign(request, { requestId: "discovery-request", turnId: "turn", itemId: "discovery-item" });
  const inputHash = createHash("sha256").update('{"query":"get_task_context"}').digest("hex");
  const receipt = structuredClone(payload(retained.rows[2]));
  Object.assign(receipt.provenance, { sessionId: "native-session", turnId: "turn" });
  const values = { operationId: "search_api", callIdentitySha256: "a".repeat(64), inputSha256: inputHash, resultSha256: "b".repeat(64) };
  for (const [name, value] of Object.entries(values)) receipt.details.find((d: Row) => d.name === name).value = value;
  const start = structuredClone(payload(discoveryFixture.rows[2]));
  Object.assign(start, { executionId: "discovery-tool" });
  const discovery = [row(1, "runtime_request.created", { request }), notice(2, "discovery-tool", "tool", { status: "pending" }),
    row(3, "tool.execution.started", start), notice(4, "discovery-tool", "permission_requested", { requestId: "discovery-request", declineOffered: true }),
    row(5, "runtime_request.resolved", { requestId: "discovery-request", turnId: "turn", requestKind: "permission_approval", action: "accept" }),
    notice(6, "discovery-tool", "permission_delivered", { requestId: "discovery-request", outcome: "allow_once" }),
    row(7, "provider.notice.recorded", receipt), notice(8, "discovery-tool", "tool", { status: "completed", semanticOperationId: "search_api", semanticCallIdentitySha256: values.callIdentitySha256,
      semanticInputSha256: inputHash, semanticNormalizedInputSha256: "null", semanticResultSha256: values.resultSha256, semanticOutcome: "returned" }),
    row(9, "tool.execution.completed", { ...start, status: "completed" })];
  f.events.unshift(...discovery);
  return f;
}
describe("optional exact context discovery", () => {
  it("requires a returned control-plane receipt before context and leaves the write unanswered", () => {
    const f = withDiscovery();
    expect(readCopilotContextRead(f.events, f.origin(), true)).toMatchObject({ discoveries: [{ toolCallId: "discovery-tool", permissionRequestId: "discovery-request", receiptSeq: 7 }] });
    expect(f.pending()).toMatchObject({ requestId: "edit-request" });
  });
  it.each([
    ["another query", (rows: Row[]) => { payload(rows[2]).progress = "paperclip-search_api (pending): create_task"; }],
    ["mutation projection", (rows: Row[]) => { payload(rows[2]).readOnly = false; }],
    ["missing receipt", (rows: Row[]) => { rows.splice(6, 1); }],
    ["wrong receipt operation", (rows: Row[]) => { setDetail(rows[6], "operationId", "write_document"); }],
    ["rejected discovery", (rows: Row[]) => { setDetail(rows[6], "outcome", "error"); }],
    ["native mismatch", (rows: Row[]) => { setDetail(rows[7], "semanticInputSha256", "c".repeat(64)); }],
    ["session-wide approval", (rows: Row[]) => { setDetail(rows[5], "outcome", "allow_always"); }],
    ["foreign bridge", (rows: Row[]) => { payload(rows[0]).request.origin.adapter = "untrusted"; }],
    ["late discovery", (rows: Row[]) => { rows[8].seq = 11; }],
    ["duplicate discovery", (rows: Row[]) => { rows.push(structuredClone(rows[6])); }],
    ["borrowed context identity", (rows: Row[]) => { const contextReceipt = payload(rows[15]).details.find((d: Row) => d.name === "callIdentitySha256").value;
      setDetail(rows[6], "callIdentitySha256", contextReceipt); setDetail(rows[7], "semanticCallIdentitySha256", contextReceipt); }],
  ] as const)("rejects %s", (_name, mutate) => {
    const f = withDiscovery(); mutate(f.events);
    expect(() => readCopilotContextRead(f.events, f.origin(), true)).toThrow();
    expect(f.pending).toThrow();
  });
  it("still refuses a stale mutation answer after provider death", () => {
    const f = withDiscovery(), pending = f.pending(); f.run.status = "failed"; f.issue.status = "blocked";
    f.events.push(row(23, "runtime_request.expired", { requestId: "edit-request", turnId: "turn", requestKind: "permission_approval" }), row(24, "turn.failed", { error: { code: "AGENT_DISCONNECTED" } }));
    expect(assertCopilotProviderDeath({ ...f, pending })).toMatchObject({ mutationReplay: false });
    f.events.push(notice(25, "edit-tool", "permission_delivered", { requestId: "edit-request", outcome: "allow_once" }));
    expect(() => assertCopilotProviderDeath({ ...f, pending })).toThrow();
  });
  it("settles Stop without mistaking completed discovery for an answered write", () => {
    const f = withDiscovery(), pending = f.pending(); f.run.status = "cancelled";
    f.events.push(row(23, "runtime_request.cancelled", { requestId: "edit-request", turnId: "turn", requestKind: "permission_approval", itemId: "edit-item", reason: "turn_terminal" }), row(24, "turn.cancelled", { status: "cancelled", error: null }));
    f.run.resultJson = { startupCancellation: { cancellationRequestId, requestedBy: { type: "board", userId: "local-board" } }, nativeCancellation: {
      schema: "paperclip.native-cancellation.v1", intentId: `native-cancellation:${cancellationRequestId}`, companyId: "company", runId: "run", issueId: "issue", scope: "run",
      dispatched: true, dispatchState: "acknowledged", reasonCode: "cancellation_run_only", effects: ["release_run_resources"], intentAuditId: "intent-audit", acknowledgementAuditId: "ack-audit" } };
    applyMainlineStopMetadata(f.run);
    const stopAcknowledgement = stopAcknowledgementForTest(f.run, cancellationRequestId, (BigInt(pending.observedMonotonicNs) + 1n).toString());
    expect(readActiveStopSettlement({ ...f, stopAcknowledgement, pending, dispatchMonotonicNs: (BigInt(pending.observedMonotonicNs) + 1n).toString() })).toMatchObject({ normalCompletionAccepted: false });
    f.events.push(row(25, "runtime_request.resolved", { requestId: "edit-request", action: "accept" }));
    expect(() => readActiveStopSettlement({ ...f, stopAcknowledgement, pending, dispatchMonotonicNs: (BigInt(pending.observedMonotonicNs) + 1n).toString() })).toThrow();
  });

});

function withTwoDiscoveries() {
  const f = withDiscovery();
  const second = JSON.parse(JSON.stringify(f.events.slice(0, 9)).replaceAll("discovery-", "second-discovery-")) as Row[];
  const advance = (r: Row, delta: number) => { r.seq += delta; r.sourceSeq += delta; frame(r).sourceSeq += delta; frame(r).sourceEventId = `source:run:${frame(r).sourceSeq}`; };
  for (const r of f.events.slice(9)) advance(r, 9);
  for (const r of second) {
    advance(r, 9);
    const p = payload(r);
    if (p.name === "paperclip-search_api") p.progress = "paperclip-search_api (pending): dedicated get_task_context tool";
    for (const d of p.details ?? []) {
      if (["callIdentitySha256", "semanticCallIdentitySha256"].includes(d.name)) d.value = "c".repeat(64);
      if (["inputSha256", "semanticInputSha256"].includes(d.name)) d.value = "d".repeat(64);
      if (["resultSha256", "semanticResultSha256"].includes(d.name)) d.value = "e".repeat(64);
    }
  }
  f.events.splice(9, 0, ...second);
  return f;
}
describe("multiple independently attested discovery decisions", () => {
  it("leaves only the mutation permission pending", () => {
    const f = withTwoDiscoveries();
    expect(readCopilotContextRead(f.events, f.origin(), true)?.discoveries).toHaveLength(2);
    expect(f.pending()).toMatchObject({ requestId: "edit-request" });
  });
  it.each(["stop", "provider-death"])("retains unanswered-write and no-replay guards after %s", kind => {
    const f = withTwoDiscoveries(), pending = f.pending();
    const seq = Math.max(...f.events.map(r => r.seq)) + 1;
    if (kind === "provider-death") {
      f.run.status = "failed"; f.issue.status = "blocked";
      f.events.push(row(seq, "runtime_request.expired", { requestId: "edit-request", turnId: "turn", requestKind: "permission_approval" }), row(seq + 1, "turn.failed", { error: { code: "AGENT_DISCONNECTED" } }));
      expect(assertCopilotProviderDeath({ ...f, pending })).toMatchObject({ mutationReplay: false });
    } else {
      f.run.status = "cancelled";
      applyMainlineStopMetadata(f.run);
      const dispatchMonotonicNs = (BigInt(pending.observedMonotonicNs) + 1n).toString();
      const stopAcknowledgement = stopAcknowledgementForTest(f.run, cancellationRequestId, dispatchMonotonicNs);
      f.events.push(row(seq, "runtime_request.cancelled", { requestId: "edit-request", turnId: "turn", requestKind: "permission_approval", itemId: "edit-item", reason: "turn_terminal" }), row(seq + 1, "turn.cancelled", { status: "cancelled", error: null }));
      const read = () => readActiveStopSettlement({ ...f, pending, dispatchMonotonicNs, stopAcknowledgement });
      expect(read()).toMatchObject({ normalCompletionAccepted: false });
      f.events.push(row(seq + 2, "runtime_request.resolved", { requestId: "edit-request", action: "accept" }));
      expect(read).toThrow();
      return;
    }
    f.events.push(notice(seq + 2, "edit-tool", "permission_delivered", { requestId: "edit-request", outcome: "allow_once" }));
    expect(() => assertCopilotProviderDeath({ ...f, pending })).toThrow();
  });
});
