import { describe, expect, it, vi } from "vitest";
import { readCopilotToolEvidence } from "./copilot-evidence.js";
import { observeCopilotPreStop, copilotDenialSampleCursor, readCopilotDenialSettlement } from "./copilot-protection-evidence.js";
import { settleCopilotDeniedRun } from "./copilot-protection-flow.js";

// Sanitized source order from the failed Daytona attempt. Its .900 createdAt
// is transaction time, not commit evidence. Pre-Stop receipts below are synthetic
// test observations; the historical paid attempt did not capture one.
const date = (ms: number) => new Date(Date.UTC(2026, 8, 30, 15, 13, 7, ms)).toISOString();
function fixture(eventType = "turn.completed") {
  const frame = (seq: number, type: string, payload: unknown, persisted = 305, emitted = 129): any => ({
    seq: seq + 40, companyId: "company", runId: "run", eventType: type, createdAt: date(persisted),
    payload: { prpEvent: { schema: "paperclip.prp.event.v1", sourceKind: "runner", runId: "run", turnId: "turn",
      normalizedSessionId: "normalized-session", sourceInstanceId: "runner-instance", sourceSeq: seq,
      sourceEventId: `runner-instance:run:${seq}`, eventType: type, emittedAt: date(emitted), payload } },
  });
  const notice = (seq: number, stage: string, details: Record<string, string>) => frame(seq, "provider.notice.recorded", {
    schema: "paperclip.provider.notice.v1", category: "copilot_tool_evidence_v1", scope: "turn",
    provenance: { sessionId: "native-session", turnId: "turn", eventType: stage, method: stage === "tool" ? "session/update" : "session/request_permission" },
    details: Object.entries({ stage, toolCallId: "denied-edit", operation: "edit", ...details }).map(([name, value]) => ({ name, value })),
  });
  const events = [notice(111, "permission_requested", { requestId: "request", target: "copilot-denied-nonce.txt", declineOffered: "true" }),
    notice(113, "permission_delivered", { requestId: "request", outcome: "reject_once" }), notice(114, "tool", { status: "failed" }),
    frame(115, "tool.execution.completed", { schema: "paperclip.tool.execution.v1", executionId: "denied-edit", operation: "edit", status: "failed" }, 317),
    frame(121, eventType, { status: eventType.slice(5), error: null }, 900, 887),
    frame(112, "runtime_request.resolved", { requestId: "request", turnId: "turn", requestKind: "permission_approval", action: "decline" })];
  const run: any = { id: "run", companyId: "company", nativeIssueId: "issue", status: "cancelled", finishedAt: date(910),
    resultJson: { startupCancellation: { requestedAt: date(892), cancellationRequestId: "11111111-1111-4111-8111-111111111111" }, nativeCancellation: {
      schema: "paperclip.native-cancellation.v1", companyId: "company", runId: "run", issueId: "issue", scope: "run", dispatched: true,
      dispatchState: "acknowledged", reasonCode: "cancellation_run_only", effects: ["release_run_resources"], intentId: "native-cancellation:11111111-1111-4111-8111-111111111111",
      intentAuditId: "intent-audit", acknowledgementAuditId: "ack-audit", recordedAt: date(901), acknowledgedAt: date(909),
    } } };
  const request = readCopilotToolEvidence(events, "run")[0]!;
  const preStop = observeCopilotPreStop({ events, request, companyId: "company", cancellationRequestId: "11111111-1111-4111-8111-111111111111" });
  return { events, request, run, issue: { id: "issue", companyId: "company", status: "in_progress" }, preStop, stopDispatchMonotonicNs: process.hrtime.bigint().toString() };

}
const terminal = (f: ReturnType<typeof fixture>) => f.events[4]!.payload.prpEvent;
const liveRun = (f: ReturnType<typeof fixture>) => ({ ...f.run, status: "running", resultJson: {} });
function stopPost(f: ReturnType<typeof fixture>, callback = () => {}) {
  return vi.fn(async (_path: string, body: { cancellationRequestId: string }) => {
    callback();
    f.run.resultJson.startupCancellation.cancellationRequestId = body.cancellationRequestId;
    f.run.resultJson.nativeCancellation.intentId = `native-cancellation:${body.cancellationRequestId}`;
    return f.run;
  });
}

describe("Copilot denial provider settlement and separate audited run Stop", () => {
  it("accepts a synthetic pre-Stop API observation without claiming provider cancellation", () => {
    const f = fixture();
    expect(readCopilotDenialSettlement(f)).toMatchObject({ branch: "provider_completed_observed_before_stop", providerCancellationTerminalObserved: false,
      providerTerminal: { sourceSeq: 121, failedToolSourceSeq: 115, rowCreatedAtMs: Date.parse(date(900)) }, runStop: { status: "cancelled" } });
    // Native/provider clock skew is irrelevant to the operator causal boundary.
    terminal(f).emittedAt = date(999);
    f.preStop = observeCopilotPreStop({ ...f, companyId: "company", cancellationRequestId: "11111111-1111-4111-8111-111111111111" }); f.stopDispatchMonotonicNs = process.hrtime.bigint().toString();
    expect(readCopilotDenialSettlement(f).branch).toBe("provider_completed_observed_before_stop");
  });
  it.each(["turn.cancelled", "turn.interrupted"])("retains the distinct observed %s branch", type => {
    expect(readCopilotDenialSettlement(fixture(type))).toMatchObject({ branch: "provider_cancelled_or_interrupted", providerCancellationTerminalObserved: true });
  });
  it("cannot use a legacy summary or cancelled run as provider evidence", () => {
    const f = fixture(); f.events.splice(4, 1); f.events.push({ eventType: "turn.completed", payload: {} });
    expect(() => readCopilotDenialSettlement(f)).toThrow(/settlement/);
  });
  it.each(["equal", "later"])("accepts observed pre-Stop completion with %s transaction time, without ordering it against ack", kind => {
    const f = fixture(); f.events[4]!.createdAt = date(kind === "equal" ? 909 : 910);
    f.preStop = observeCopilotPreStop({ ...f, companyId: "company", cancellationRequestId: "11111111-1111-4111-8111-111111111111" }); f.stopDispatchMonotonicNs = process.hrtime.bigint().toString();
    expect(readCopilotDenialSettlement(f).branch).toBe("provider_completed_observed_before_stop");
  });
  it("rejects late normal completion even when its transaction began before Stop ack", () => {
    const f = fixture(); f.preStop.terminal = null; f.events[4]!.createdAt = date(800);
    expect(() => readCopilotDenialSettlement(f)).toThrow(/settlement/);
  });
  it.each(["missing", "foreign", "hash", "sequence", "equal-clock", "reverse-clock", "non-string-clock"])("rejects %s pre-dispatch observation", kind => {
    const f = fixture();
    if (kind === "missing") (f as any).preStop = null;
    if (kind === "foreign") f.preStop.runId = "foreign";
    if (kind === "hash") f.preStop.terminal!.rowSha256 = `sha256:${"a".repeat(64)}`;
    if (kind === "sequence") f.preStop.terminal!.sourceSeq++;
    if (kind === "equal-clock") f.stopDispatchMonotonicNs = f.preStop.apiReadCompletedMonotonicNs;
    if (kind === "reverse-clock") f.stopDispatchMonotonicNs = "1";
    if (kind === "non-string-clock") (f.preStop as any).apiReadCompletedMonotonicNs = ["1"];
    expect(() => readCopilotDenialSettlement(f)).toThrow(/settlement/);
  });
  it.each(["runId", "turnId", "normalizedSessionId", "sourceInstanceId", "eventType", "sourceEventId"])("rejects terminal %s mismatch", field => {
    const f = fixture(); terminal(f)[field] = "foreign";
    expect(() => readCopilotDenialSettlement(f)).toThrow(/settlement/);
  });
  it.each(["missing", "duplicate", "failed", "before-tool", "wrong-status", "error"])("rejects %s terminal", kind => {
    const f = fixture();
    if (kind === "missing") f.events.splice(4, 1);
    if (kind === "duplicate") f.events.push(structuredClone(f.events[4]));
    if (kind === "failed") { f.events[4]!.eventType = terminal(f).eventType = "turn.failed"; terminal(f).payload.status = "failed"; }
    if (kind === "before-tool") { terminal(f).sourceSeq = 114; terminal(f).sourceEventId = "runner-instance:run:114"; }
    if (kind === "wrong-status") terminal(f).payload.status = "cancelled";
    if (kind === "error") terminal(f).payload.error = { code: "failed" };
    expect(() => readCopilotDenialSettlement(f)).toThrow(/settlement/);
  });
  it.each(["scope", "runId", "companyId", "issueId", "intentId", "intentAuditId", "acknowledgementAuditId", "acknowledgedAt", "recordedAt", "schema", "dispatchState", "dispatched", "reasonCode", "effects"])("rejects malformed or unbound Stop %s", field => {
    const f = fixture(); f.run.resultJson.nativeCancellation[field] = null;
    expect(() => readCopilotDenialSettlement(f)).toThrow(/settlement/);
  });
  it.each(["missing-stop", "pending", "wrong-scope", "same-audit", "wrong-run-status", "issue-done", "ack-before-intent"])("rejects %s controller state", kind => {
    const f = fixture(), c = f.run.resultJson.nativeCancellation;
    if (kind === "missing-stop") delete f.run.resultJson.nativeCancellation;
    if (kind === "pending") c.dispatchState = "pending";
    if (kind === "wrong-scope") c.scope = "turn";
    if (kind === "same-audit") c.acknowledgementAuditId = c.intentAuditId;
    if (kind === "wrong-run-status") f.run.status = "succeeded";
    if (kind === "issue-done") f.issue.status = "done";
    if (kind === "ack-before-intent") c.recordedAt = date(911);
    expect(() => readCopilotDenialSettlement(f)).toThrow(/settlement/);
  });
  it.each(["native-session", "normalized-session", "failed-tool", "delivery", "duplicate-tool", "tool-order"])("rejects %s corruption", kind => {
    const f = fixture();
    if (kind === "native-session") f.events[2]!.payload.prpEvent.payload.provenance.sessionId = "foreign";
    if (kind === "normalized-session") f.events[2]!.payload.prpEvent.normalizedSessionId = "foreign";
    if (kind === "failed-tool") f.events[3]!.payload.prpEvent.payload.status = "completed";
    if (kind === "delivery") f.events[1]!.payload.prpEvent.payload.details.find((d: any) => d.name === "outcome").value = "allow_once";
    if (kind === "duplicate-tool") f.events.push(structuredClone(f.events[3]));
    if (kind === "tool-order") f.events[3]!.payload.prpEvent.sourceSeq = 122;
    expect(() => readCopilotDenialSettlement(f)).toThrow();
  });
  it.each(["missing", "duplicate", "foreign-turn", "accept", "expired", "after-delivery"])("rejects %s durable resolution", kind => {
    const f = fixture(), r = f.events[5]!, p = r.payload.prpEvent;
    if (kind === "missing") f.events.pop();
    if (kind === "duplicate") f.events.push(structuredClone(r));
    if (kind === "foreign-turn") p.payload.turnId = "foreign";
    if (kind === "accept") p.payload.action = "accept";
    if (kind === "expired") r.eventType = p.eventType = "runtime_request.expired";
    if (kind === "after-delivery") { p.sourceSeq = 114; p.sourceEventId = "runner-instance:run:114"; }
    expect(() => readCopilotDenialSettlement(f)).toThrow();
  });
  it("captures the exact durable stream at the sampling boundary without clock conversion", () => {
    const f = fixture();
    expect(copilotDenialSampleCursor([f.events[0]], f.request)).toEqual({ runId: "run", turnId: "turn", normalizedSessionId: "normalized-session", sourceInstanceId: "runner-instance", sourceSeq: 111 });
    expect(copilotDenialSampleCursor(f.events, f.request).sourceSeq).toBe(121);
    f.events[1]!.payload.prpEvent.normalizedSessionId = "foreign";
    expect(() => copilotDenialSampleCursor(f.events, f.request)).toThrow(/cursor/);
  });
  it("awaits exact pre-Stop receipt retention and waits for post-Stop cancelled terminal before sampling", async () => {
    vi.useFakeTimers(); let mono = 100n; vi.spyOn(process.hrtime, "bigint").mockImplementation(() => ++mono);
    try {
      const f = fixture("turn.cancelled"); let loads = 0, dispatched = false, postLoads = 0;
      let release!: () => void; const retention = new Promise<void>(resolve => { release = resolve; });
      const post = stopPost(f, () => { dispatched = true; });
      const retainPreStop = vi.fn(async (receipt) => { expect(receipt.terminal).toBeNull(); await retention; });
      const afterDeniedEdit = vi.fn(async () => {}), afterSettlement = vi.fn(async () => {});
      const result = settleCopilotDeniedRun({ api: { post } as any, request: f.request, deadlineAt: Date.now() + 5000,
        load: async () => {
          loads++; if (dispatched) postLoads++;
          const events = f.events.filter((_, i) => !(loads === 1 && i === 3) && !((!dispatched || postLoads === 1) && i === 4));
          return { ...f, events, run: dispatched ? f.run : liveRun(f), retired: dispatched };
        }, afterDeniedEdit, retainPreStop, afterSettlement });
      await vi.advanceTimersByTimeAsync(0); expect(post).not.toHaveBeenCalled(); expect(afterDeniedEdit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(200); expect(afterDeniedEdit).toHaveBeenCalledOnce(); expect(post).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2000); expect(retainPreStop).toHaveBeenCalledOnce(); expect(post).not.toHaveBeenCalled();
      release(); await vi.advanceTimersByTimeAsync(0); expect(post).toHaveBeenCalledOnce(); expect(afterSettlement).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(200); expect((await result).branch).toBe("provider_cancelled_or_interrupted"); expect(afterSettlement).toHaveBeenCalledOnce();
    } finally { vi.restoreAllMocks(); vi.useRealTimers(); }
  });
  it("rejects normal completion first returned after Stop even with an earlier transaction timestamp", async () => {
    vi.useFakeTimers(); let mono = 100n; vi.spyOn(process.hrtime, "bigint").mockImplementation(() => ++mono);
    try {
      const f = fixture(); f.events[4]!.createdAt = date(1); let dispatched = false;
      const sample = vi.fn(async () => {}), post = stopPost(f, () => { dispatched = true; });
      const retain = vi.fn(async (receipt) => { expect(receipt.terminal).toBeNull(); });
      const result = settleCopilotDeniedRun({ api: { post } as any, request: f.request, deadlineAt: Date.now() + 3000,
        load: async () => ({ ...f, run: dispatched ? f.run : liveRun(f), events: dispatched ? f.events : f.events.filter((_, i) => i !== 4), retired: dispatched }),
        afterDeniedEdit: async () => {}, retainPreStop: retain, afterSettlement: sample });
      const rejected = expect(result).rejects.toThrow(/Timed out waiting for correlated provider settlement/);
      await vi.advanceTimersByTimeAsync(3200); await rejected;
      expect(retain).toHaveBeenCalledOnce(); expect(post).toHaveBeenCalledOnce(); expect(sample).not.toHaveBeenCalled();
    } finally { vi.restoreAllMocks(); vi.useRealTimers(); }
  });
  it.each(["missing-edit", "foreign-edit", "missing-terminal", "foreign-terminal", "live-process"])("fails closed on %s without premature side effects or terminal samples", async kind => {
    vi.useFakeTimers(); let mono = 100n; vi.spyOn(process.hrtime, "bigint").mockImplementation(() => ++mono);
    try {
      const f = fixture(), post = stopPost(f), sample = vi.fn(async () => {});
      if (kind === "missing-edit") f.events.splice(3, 1);
      if (kind === "foreign-edit") f.events[3]!.payload.prpEvent.normalizedSessionId = "foreign";
      if (kind === "missing-terminal") f.events.splice(4, 1);
      if (kind === "foreign-terminal") terminal(f).sourceInstanceId = "foreign";
      const result = settleCopilotDeniedRun({ api: { post } as any, request: f.request, deadlineAt: Date.now() + 3000,
        load: async () => ({ ...f, run: post.mock.calls.length ? f.run : liveRun(f), retired: kind !== "live-process" }), afterDeniedEdit: async () => {}, retainPreStop: async () => {}, afterSettlement: sample });
      const rejected = expect(result).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(3200); await rejected;
      expect(post).toHaveBeenCalledTimes(kind.endsWith("edit") || kind === "foreign-terminal" ? 0 : 1);
      expect(sample).not.toHaveBeenCalled();
    } finally { vi.restoreAllMocks(); vi.useRealTimers(); }
  });
  it.each(["failed", "timed_out"])("reports %s promptly even when required rows are missing", async status => {
    const f = fixture(), post = stopPost(f), sample = vi.fn(async () => {});
    const load = vi.fn(async () => ({ ...f, events: [], run: { ...f.run, status }, retired: false }));
    await expect(settleCopilotDeniedRun({ api: { post } as any, request: f.request, deadlineAt: Date.now() + 10000,
      load, afterDeniedEdit: sample, retainPreStop: sample, afterSettlement: sample })).rejects.toThrow(`Stopped waiting for persisted correlated failed native edit: Copilot provider run failed`);
    expect(load).toHaveBeenCalledOnce(); expect(post).not.toHaveBeenCalled(); expect(sample).not.toHaveBeenCalled();
  });
  it.each(["failed", "timed_out"])("reports post-Stop %s before attempting a missing terminal reader", async status => {
    const f = fixture(), post = stopPost(f); let loads = 0;
    const load = vi.fn(async () => ({ ...f, events: ++loads < 4 ? f.events : [], run: loads < 4 ? liveRun(f) : { ...f.run, status }, retired: true }));
    await expect(settleCopilotDeniedRun({ api: { post } as any, request: f.request, deadlineAt: Date.now() + 10000,
      load, afterDeniedEdit: async () => {}, retainPreStop: async () => {}, afterSettlement: async () => {} })).rejects.toThrow("Stopped waiting for correlated provider settlement and retired run: Copilot provider run failed");
    expect(load).toHaveBeenCalledTimes(4); expect(post).toHaveBeenCalledOnce();
  });
  it("does not dispatch Stop if the pre-dispatch receipt cannot be retained", async () => {
    const f = fixture(), post = stopPost(f);
    await expect(settleCopilotDeniedRun({ api: { post } as any, request: f.request, deadlineAt: Date.now() + 1000,
      load: async () => ({ ...f, run: post.mock.calls.length ? f.run : liveRun(f), retired: true }), afterDeniedEdit: async () => {}, afterSettlement: async () => {},
      retainPreStop: async () => { throw new Error("artifact write failed"); } })).rejects.toThrow("artifact write failed");
    expect(post).not.toHaveBeenCalled();
  });
  it("retains completed-before-Stop settlement and propagates retirement sampling failure", async () => {
    const f = fixture(), post = stopPost(f);
    const input = { api: { post } as any, request: f.request, deadlineAt: Date.now() + 1000,
      load: async () => ({ ...f, run: post.mock.calls.length ? f.run : liveRun(f), retired: true }), afterDeniedEdit: async () => {}, retainPreStop: async () => {}, afterSettlement: async () => {} };
    expect((await settleCopilotDeniedRun(input)).branch).toBe("provider_completed_observed_before_stop");
    post.mockClear();
    await expect(settleCopilotDeniedRun({ ...input, afterSettlement: async () => { throw new Error("remote descendants live"); } })).rejects.toThrow("remote descendants live");
  });
  it.each(["cancelled", "pending-intent", "startup-only"])("rejects visible earlier Stop %s before dispatch", async kind => {
    const f = fixture(), post = stopPost(f);
    const run = kind === "cancelled" ? f.run : { ...liveRun(f), resultJson: kind === "startup-only"
      ? { startupCancellation: { requestedAt: date(1) } } : { nativeCancellation: { intentId: "earlier", dispatchState: "pending" } } };
    await expect(settleCopilotDeniedRun({ api: { post } as any, request: f.request, deadlineAt: Date.now() + 1000,
      load: async () => ({ ...f, run, retired: false }), afterDeniedEdit: async () => {}, retainPreStop: async () => {}, afterSettlement: async () => {},
    })).rejects.toThrow("earlier Stop");
    expect(post).not.toHaveBeenCalled();
  });
  it("rejects Stop racing during artifact retention", async () => {
    const f = fixture(), post = stopPost(f); let earlier = false;
    await expect(settleCopilotDeniedRun({ api: { post } as any, request: f.request, deadlineAt: Date.now() + 1000,
      load: async () => ({ ...f, run: earlier ? f.run : liveRun(f), retired: false }), afterDeniedEdit: async () => {},
      retainPreStop: async () => { earlier = true; }, afterSettlement: async () => {},
    })).rejects.toThrow("earlier Stop");
    expect(post).not.toHaveBeenCalled();
  });
  it.each(["conflict", "foreign-response"])("cannot pass a Stop racing after the last API read: %s", async kind => {
    const f = fixture(); const post = vi.fn(async (_path: string, _body: { cancellationRequestId: string }) => { if (kind === "conflict") throw new Error("409 cancellation intent conflict"); return f.run; });
    const sampled = vi.fn(async () => {});
    await expect(settleCopilotDeniedRun({ api: { post } as any, request: f.request, deadlineAt: Date.now() + 1000,
      load: async () => ({ ...f, run: liveRun(f), retired: false }), afterDeniedEdit: async () => {}, retainPreStop: async () => {}, afterSettlement: sampled,
    })).rejects.toThrow(kind === "conflict" ? "409" : "foreign cancellation intent");
    expect(post).toHaveBeenCalledOnce(); expect(sampled).not.toHaveBeenCalled();
    expect(post.mock.calls[0]?.[1]).toMatchObject({ cancellationRequestId: expect.stringMatching(/^[a-f0-9-]{36}$/) });
  });

});
