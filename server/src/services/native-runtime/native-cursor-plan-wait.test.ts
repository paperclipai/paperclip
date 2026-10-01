import { describe, expect, it, vi } from "vitest";
import * as runner from "../../vendor/paperclip-runner/index.js";
import { resolveQualifiedAcpxProfile, validatePrpStructuredRunResult } from "../../vendor/paperclip-runner/index.js";
import { buildQuestionResponseDeliveryEnvelope } from "../question-response-delivery.js";
import { NATIVE_COMPLETION_CONTRACT_SCHEMA, NATIVE_COMPLETION_POLICY_VERSION } from "./completion-contracts.js";
import { nativeSha256 } from "./canonical.js";
import { nativeCursorPlanWaitFromFacts, type CursorPlanWaitFacts } from "./native-cursor-plan-wait.js";

function fixture(): CursorPlanWaitFacts {
  const b = { companyId: "company", issueId: "issue", agentId: "agent", runId: "run" };
  const contract = { revision: "revision", criteria: [{ id: "criterion" }] };
  const contractMetadata = { schemaVersion: NATIVE_COMPLETION_CONTRACT_SCHEMA, policyVersion: NATIVE_COMPLETION_POLICY_VERSION, risk: "low", completionAuthority: "agent_claim_policy" };
  const contractSha = nativeSha256({ ...contractMetadata, contract });
  const planId = `plan-${"a".repeat(64)}`;
  const input = { schema: "paperclip.question_set.v1", title: "Plan", description: "Exact revised plan text", questions: [{ id: planId, prompt: "Proceed?", required: true, answerMode: "single_select", options: [{ id: "accept", label: "Accept" }, { id: "reject", label: "Reject" }, { id: "cancel", label: "Cancel" }] }] };
  const i = { id: "interaction", ...b, sourceRunId: b.runId, createdByAgentId: b.agentId, resolvedByUserId: "board", resolvedByAgentId: null, resolvedAt: new Date(0),
    kind: "ask_user_questions", status: "answered", continuationPolicy: "none", idempotencyKey: "paperclip-runner-question:run:request",
    payload: { runtimeRequestId: "request", questionSet: input }, result: { version: 1, answers: [{ questionId: planId, optionIds: ["accept"] }] } };
  const envelope = buildQuestionResponseDeliveryEnvelope(i as never);
  const d = { id: "delivery", ...b, interactionId: i.id, sourceRunId: b.runId, targetRunId: b.runId, targetTurnId: null, status: "delivered", deliveryMode: "steered", acknowledgedAt: new Date(1), payloadSha256: nativeSha256(envelope) };
  const event = (sourceSeq: number, eventType: string, payload: Record<string, unknown>) => {
    const e = { schema: "paperclip.prp.event.v1", runId: b.runId, normalizedSessionId: "session", turnId: "turn", sourceInstanceId: "instance", sourceEventId: `instance:${sourceSeq}`, sourceSeq, sourceKind: "runner", schemaVersion: 1, eventType, payload };
    return { ...b, seq: sourceSeq, eventType, payload: { prpEvent: e }, sourceInstanceId: e.sourceInstanceId, sourceEventId: e.sourceEventId, sourceSeq, sourcePayloadSha256: nativeSha256(e), protocolSchemaVersion: 1 };
  };
  return {
    binding: b,
    run: { id: b.runId, companyId: b.companyId, agentId: b.agentId, nativeIssueId: b.issueId, runtimeMode: "native", runnerInstanceId: "instance", status: "running", completionContractId: "contract", completionContractSha256: contractSha, runnerProfileJson: { nativeExecutionInput: { binding: b, provider: { kind: "acpx", agent: "cursor", cursorMode: "plan", model: "gpt-5.6-luna[context=272k,reasoning=medium,fast=false]", profile: resolveQualifiedAcpxProfile("cursor", "gpt-5.6-luna[context=272k,reasoning=medium,fast=false]") }, session: { normalizedSessionId: "session" }, completionContract: { id: "contract", sha256: contractSha, contract } } } },
    contract: { id: "contract", ...contractMetadata, canonicalSha256: contractSha, contractJson: contract },
    events: [
      event(275, "runtime_request.created", { request: { schema: "paperclip.runtime_request.v2", status: "pending", type: "input", requestKind: "runtime", requestId: "request", turnId: "turn", itemId: "native-plan-tool", origin: { provider: "cursor", method: "cursor/create_plan", adapter: "acpx-runtime-sidecar" }, input } }),
      event(294, "tool.execution.started", { schema: "paperclip.tool.execution.v1", executionId: "native-plan-tool", transport: "builtin", operation: "execute", status: "running", name: "arbitrary display name" }),
      event(300, "runtime_request.resolved", { requestId: "request", turnId: "turn", action: "submit", response: envelope.response }),
      event(303, "tool.execution.completed", { schema: "paperclip.tool.execution.v1", executionId: "native-plan-tool", transport: "builtin", operation: "execute", status: "completed" }),
      event(304, "turn.completed", { status: "completed", error: null }),
    ],
    interactions: [{ interaction: i, delivery: d }],
  } as unknown as CursorPlanWaitFacts;
}
function editEvent(f: CursorPlanWaitFacts, index: number, edit: (e: any) => void) {
  const row = f.events.filter(row => !row.eventType.startsWith("tool.execution."))[index]!;
  const e = (row.payload as any).prpEvent;
  edit(e); row.sourcePayloadSha256 = nativeSha256(e);
}

describe("accepted Cursor plan passive-wait authority", () => {
  it("records the accepted revision and explicitly unfinished Plan-mode continuation", () => {
    const value = nativeCursorPlanWaitFromFacts(fixture());
    expect(value?.source).toMatchObject({ requestId: "request", planRevision: `plan-${"a".repeat(64)}`, terminalEventId: "instance:304", toolExecutionId: "native-plan-tool" });
    expect(value?.result).toMatchObject({ reportedWorkDisposition: "yielded", completionClaim: { objectiveSatisfied: false, remainingWork: [{ blocksCompletion: true }] }, continuation: { kind: "response_wake" } });
    expect(value?.result.summary).toContain("next message");
    const validated = validatePrpStructuredRunResult(value!.result);
    expect(validated.ok).toBe(true);
    if (validated.ok) expect(validated.result).toEqual(value!.result);
  });
  it.each(["unrelated same-title tool", "cross turn", "cross session", "duplicate start", "duplicate completion", "missing start", "missing completion", "failed completion", "changed request tool", "uncommitted tool row"])("rejects correlated lifecycle corruption: %s", kind => {
    const f = fixture();
    const start = f.events.find(row => row.eventType === "tool.execution.started")!;
    const end = f.events.find(row => row.eventType === "tool.execution.completed")!;
    const event = (start.payload as any).prpEvent;
    if (kind === "unrelated same-title tool") event.payload.executionId = "unrelated-tool";
    if (kind === "cross turn") event.turnId = "other";
    if (kind === "cross session") event.normalizedSessionId = "other";
    if (kind === "duplicate start") f.events.splice(2, 0, structuredClone(start));
    if (kind === "duplicate completion") f.events.splice(4, 0, structuredClone(end));
    if (kind === "missing start") f.events = f.events.filter(row => row !== start);
    if (kind === "missing completion") f.events = f.events.filter(row => row !== end);
    if (kind === "failed completion") { (end.payload as any).prpEvent.payload.status = "failed"; end.sourcePayloadSha256 = nativeSha256((end.payload as any).prpEvent); }
    if (kind === "changed request tool") editEvent(f, 0, e => { e.payload.request.itemId = "unrelated-tool"; });
    start.sourcePayloadSha256 = kind === "uncommitted tool row" ? null : nativeSha256(event);
    expect(nativeCursorPlanWaitFromFacts(f)).toBeNull();
  });
  it("rejects an additional same-title tool while the real plan tool remains correlated", () => {
    const f = fixture();
    const extra = structuredClone(f.events.find(row => row.eventType === "tool.execution.started")!);
    extra.seq = 295; extra.sourceSeq = 295; extra.sourceEventId = "instance:295";
    const e = (extra.payload as any).prpEvent;
    Object.assign(e, { sourceSeq: 295, sourceEventId: extra.sourceEventId });
    Object.assign(e.payload, { executionId: "unrelated", name: "Create Plan" });
    extra.sourcePayloadSha256 = nativeSha256(e); f.events.splice(2, 0, extra);
    expect(nativeCursorPlanWaitFromFacts(f)).toBeNull();
  });
  it("binds actual callback-before-tool-start order without trusting display names", () => {
    const f = fixture(); const original = nativeCursorPlanWaitFromFacts(f)!;
    expect(original.source.toolLifecycleSha256).toMatch(/^[a-f0-9]{64}$/);
    const start = f.events.find(row => row.eventType === "tool.execution.started")!;
    (start.payload as any).prpEvent.payload.name = "changed display text";
    start.sourcePayloadSha256 = nativeSha256((start.payload as any).prpEvent);
    const changed = nativeCursorPlanWaitFromFacts(f)!;
    expect(changed).not.toBeNull();
    expect(changed.source.authoritySha256).not.toBe(original.source.authoritySha256);
    expect(changed.source.toolLifecycleSha256).not.toBe(original.source.toolLifecycleSha256);
  });
  it("does not create a new wait from an earlier profile after the catalog advances", () => {
    const facts = fixture();
    expect(nativeCursorPlanWaitFromFacts(facts)).not.toBeNull();
    const current = resolveQualifiedAcpxProfile("cursor", "gpt-5.6-luna[context=272k,reasoning=medium,fast=false]");
    // Model a future catalog revision without tying this test to today's version.
    const next = { ...current, agentProfileVersion: (current.agentProfileVersion + 1) as typeof current.agentProfileVersion, commandDigest: `sha256:${"b".repeat(64)}` } satisfies typeof current;
    expect(next.agentProfileVersion).toBeGreaterThan(current.agentProfileVersion);
    const resolver = vi.spyOn(runner, "resolveQualifiedAcpxProfile").mockReturnValue(next);
    try { expect(nativeCursorPlanWaitFromFacts(facts)).toBeNull(); }
    finally { resolver.mockRestore(); }
  });
  it("projects only declared scope keys from a wider typed caller binding", () => {
    const f = fixture(); Object.assign(f.binding, { wakeupRequestId: "unrelated-caller-metadata" });
    const proof = nativeCursorPlanWaitFromFacts(f);
    expect(proof).not.toBeNull();
    expect(proof!.source).not.toHaveProperty("wakeupRequestId");
  });
  it.each([
    ["foreign runner", (f: CursorPlanWaitFacts) => { f.run.runnerInstanceId = "other"; }],
    ["changed admission binding", (f: CursorPlanWaitFacts) => { (f.run.runnerProfileJson as any).nativeExecutionInput.binding = { ...f.binding, runId: "other" }; }],
    ["wrong company", (f: CursorPlanWaitFacts) => { f.run.companyId = "other"; }],
    ["wrong task", (f: CursorPlanWaitFacts) => { f.run.nativeIssueId = "other"; }],
    ["failed run", (f: CursorPlanWaitFacts) => { f.run.status = "failed"; }],
    ["cancelled run", (f: CursorPlanWaitFacts) => { f.run.status = "cancelled"; }],
    ["Agent mode", (f: CursorPlanWaitFacts) => { (f.run.runnerProfileJson as any).nativeExecutionInput.provider.cursorMode = "agent"; }],
    ["stale profile", (f: CursorPlanWaitFacts) => { (f.run.runnerProfileJson as any).nativeExecutionInput.provider.profile = { ...resolveQualifiedAcpxProfile("cursor", "gpt-5.6-luna[context=272k,reasoning=medium,fast=false]"), commandDigest: "old" }; }],
    ["changed contract policy", (f: CursorPlanWaitFacts) => { f.contract.policyVersion = "tampered-policy"; }],
    ["changed completion authority", (f: CursorPlanWaitFacts) => { f.contract.completionAuthority = "server_arbiter"; }],
    ["changed contract hash", (f: CursorPlanWaitFacts) => { f.contract.canonicalSha256 = "f".repeat(64); }],
    ["changed contract", (f: CursorPlanWaitFacts) => { f.contract.contractJson.revision = "new"; }],
    ["unknown origin", (f: CursorPlanWaitFacts) => editEvent(f, 0, e => { e.payload.request.origin.provider = "acpx"; })],
    ["wrong method", (f: CursorPlanWaitFacts) => editEvent(f, 0, e => { e.payload.request.origin.method = "cursor/ask_question"; })],
    ["untrusted adapter", (f: CursorPlanWaitFacts) => editEvent(f, 0, e => { e.payload.request.origin.adapter = "other"; })],
    ["cross turn", (f: CursorPlanWaitFacts) => editEvent(f, 1, e => { e.turnId = "other"; })],
    ["cross session", (f: CursorPlanWaitFacts) => editEvent(f, 1, e => { e.normalizedSessionId = "other"; })],
    ["native error", (f: CursorPlanWaitFacts) => editEvent(f, 2, e => { e.payload.error = { message: "failure" }; })],
    ["changed plan", (f: CursorPlanWaitFacts) => editEvent(f, 0, e => { e.payload.request.input.description = "other"; })],
    ["rejection", (f: CursorPlanWaitFacts) => editEvent(f, 1, e => { e.payload.response.answers[`plan-${"a".repeat(64)}`].selectedOptionIds = ["reject"]; })],
    ["cancellation", (f: CursorPlanWaitFacts) => editEvent(f, 1, e => { e.payload.response.answers[`plan-${"a".repeat(64)}`].selectedOptionIds = ["cancel"]; })],
    ["missing delivery", (f: CursorPlanWaitFacts) => { f.interactions = []; }],
    ["unacknowledged delivery", (f: CursorPlanWaitFacts) => { f.interactions[0]!.delivery.acknowledgedAt = null; }],
    ["fallback wake", (f: CursorPlanWaitFacts) => { f.interactions[0]!.delivery.deliveryMode = "wake_fallback"; }],
    ["wrong target", (f: CursorPlanWaitFacts) => { f.interactions[0]!.delivery.targetRunId = "other"; }],
    ["changed answer digest", (f: CursorPlanWaitFacts) => { f.interactions[0]!.delivery.payloadSha256 = "other"; }],
    ["missing resolution time", (f: CursorPlanWaitFacts) => { f.interactions[0]!.interaction.resolvedAt = null; }],
    ["agent resolved", (f: CursorPlanWaitFacts) => { f.interactions[0]!.interaction.resolvedByAgentId = "agent"; }],
    ["duplicate receipt", (f: CursorPlanWaitFacts) => { f.events.splice(1, 0, structuredClone(f.events[0]!)); }],
    ["duplicate delivery", (f: CursorPlanWaitFacts) => { f.interactions.push(structuredClone(f.interactions[0]!)); }],
    ["uncommitted event", (f: CursorPlanWaitFacts) => { f.events[1]!.sourcePayloadSha256 = null; }],
    ["changed row identity", (f: CursorPlanWaitFacts) => { f.events[1]!.sourceEventId = "other"; }],
    ["terminal before answer", (f: CursorPlanWaitFacts) => { f.events.reverse(); }],
  ] as const)("rejects %s", (_name, mutate) => {
    const f = fixture(); mutate(f); expect(nativeCursorPlanWaitFromFacts(f)).toBeNull();
  });
  it("does not reuse an older acceptance after a new request, later work, or conflicting terminal", () => {
    for (const kind of ["runtime_request.created", "tool.execution.started", "turn.failed", "turn.cancelled", "turn.completed"]) {
      const f = fixture(); const row = structuredClone(f.events[0]!);
      row.seq = 2.5; row.sourceSeq = 3; row.sourceEventId = "instance:later"; row.eventType = kind;
      const e = (row.payload as any).prpEvent; Object.assign(e, { sourceSeq: 3, sourceEventId: row.sourceEventId, eventType: kind });
      if (kind === "runtime_request.created") e.payload.request.requestId = "new-plan";
      row.sourcePayloadSha256 = nativeSha256(e);
      editEvent(f, 2, e => { e.sourceSeq = 4; }); f.events[2]!.sourceSeq = 4;
      f.events.splice(2, 0, row);
      expect(nativeCursorPlanWaitFromFacts(f)).toBeNull();
    }
  });
});
