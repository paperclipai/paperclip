import { describe, expect, it, vi } from "vitest";
import * as runner from "../../vendor/paperclip-runner/index.js";
import * as lifecycle from "./provider-lifecycle.js";
import { resolveQualifiedAcpxProfile, validatePrpStructuredRunResult } from "../../vendor/paperclip-runner/index.js";
import { buildQuestionResponseDeliveryEnvelope } from "../question-response-delivery.js";
import { NATIVE_COMPLETION_CONTRACT_SCHEMA, NATIVE_COMPLETION_POLICY_VERSION } from "./completion-contracts.js";
import { nativeSha256 } from "./canonical.js";
import { hasCommittedNativePlanWait, nativePlanWaitFromFacts, type PlanWaitFacts } from "./native-plan-wait.js";

function committedDb(f: PlanWaitFacts, source: unknown, result: unknown, legacy = false) {
  const sourceRecord = source as any;
  const resultJson = { result, terminal: { schema: "paperclip.prp.terminal.v1", runTerminalState: "succeeded", turnTerminalState: "completed", reportedWorkDisposition: "yielded" } };
  const canonicalSha256 = nativeSha256(resultJson);
  const identity = { resultId: "result", resultSha256: canonicalSha256 };
  const decisionJson = legacy ? { cursorPlanWait: source, cursorPlanWaitResult: identity } : { planWait: source, planWaitResult: identity };
  const rows = [
    [{ decision: { decisionJson }, result: { id: "result", canonicalSha256, completionContractId: sourceRecord.contractId, turnId: sourceRecord.turnId, resultJson } }],
    [{ run: f.run, contract: f.contract }], f.events, f.interactions,
    [{ ...f.run, createdAt: new Date(0) }], [f.interactions[0]!.interaction], [], [],
  ];
  return { select: () => {
    const result = rows.shift();
    const query: any = { from: () => query, innerJoin: () => query, where: () => query, orderBy: () => query, limit: () => Promise.resolve(result) };
    return query;
  } } as never;
}

function fixture(): PlanWaitFacts {
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
    run: { id: b.runId, companyId: b.companyId, agentId: b.agentId, nativeIssueId: b.issueId, runtimeMode: "native", runnerInstanceId: "instance", status: "running", completionContractId: "contract", completionContractSha256: contractSha, runnerProfileJson: { nativeExecutionInput: { binding: b, provider: { kind: "acpx", agent: "cursor", mode: "plan", model: "gpt-5.6-luna[context=272k,reasoning=medium,fast=false]", profile: resolveQualifiedAcpxProfile("cursor", "gpt-5.6-luna[context=272k,reasoning=medium,fast=false]") }, session: { normalizedSessionId: "session" }, completionContract: { id: "contract", sha256: contractSha, contract } } } },
    contract: { id: "contract", ...contractMetadata, canonicalSha256: contractSha, contractJson: contract },
    events: [
      event(275, "runtime_request.created", { request: { schema: "paperclip.runtime_request.v2", status: "pending", type: "input", requestKind: "runtime", requestId: "request", turnId: "turn", itemId: "native-plan-tool", origin: { provider: "cursor", method: "cursor/create_plan", adapter: "acpx-runtime-sidecar" }, input } }),
      event(294, "tool.execution.started", { schema: "paperclip.tool.execution.v1", executionId: "native-plan-tool", transport: "builtin", operation: "execute", status: "running", name: "arbitrary display name" }),
      event(300, "runtime_request.resolved", { requestId: "request", turnId: "turn", action: "submit", response: envelope.response }),
      event(303, "tool.execution.completed", { schema: "paperclip.tool.execution.v1", executionId: "native-plan-tool", transport: "builtin", operation: "execute", status: "completed" }),
      event(304, "turn.completed", { status: "completed", error: null }),
    ],
    interactions: [{ interaction: i, delivery: d }],
  } as unknown as PlanWaitFacts;
}
function editEvent(f: PlanWaitFacts, index: number, edit: (e: any) => void) {
  const row = f.events.filter(row => !row.eventType.startsWith("tool.execution."))[index]!;
  const e = (row.payload as any).prpEvent;
  edit(e); row.sourcePayloadSha256 = nativeSha256(e);
}

function resequence(f: PlanWaitFacts) {
  f.events.forEach((row, index) => {
    const sourceSeq = index + 1;
    Object.assign(row, { seq: sourceSeq, sourceSeq, sourceEventId: `instance:${sourceSeq}` });
    Object.assign((row.payload as any).prpEvent, { sourceSeq, sourceEventId: row.sourceEventId });
    row.sourcePayloadSha256 = nativeSha256((row.payload as any).prpEvent);
  });
}

function withProgress(count: number) {
  const f = fixture();
  const start = f.events.find(row => row.eventType === "tool.execution.started")!;
  const rows = Array.from({ length: count }, () => {
    const row = structuredClone(start);
    row.eventType = "tool.execution.progressed";
    (row.payload as any).prpEvent.eventType = row.eventType;
    return row;
  });
  f.events.splice(3, 0, ...rows);
  resequence(f);
  return f;
}

describe("accepted Cursor plan passive-wait authority", () => {
  it("writes and replays a provider-neutral receipt while preserving its exact authority", async () => {
    const f = fixture(); f.run.status = "succeeded";
    const proof = nativePlanWaitFromFacts(f)!;
    expect(proof.source.schema).toBe("paperclip.native_plan_wait.v1");
    expect(proof.result.continuation!.idempotencyKey).toMatch(/^native-plan-wait:/);
    expect(await hasCommittedNativePlanWait(committedDb(f, proof.source, proof.result), f.binding)).toBe(true);
    const changed = structuredClone(proof.result); changed.summary = "different result";
    expect(await hasCommittedNativePlanWait(committedDb(f, proof.source, changed), f.binding)).toBe(false);
    // A new receipt cannot opt into a historical admission by renaming a field.
    const provider = (f.run.runnerProfileJson as any).nativeExecutionInput.provider;
    provider.cursorMode = provider.mode; delete provider.mode;
    expect(await hasCommittedNativePlanWait(committedDb(f, proof.source, proof.result), f.binding)).toBe(false);
  });
  it("keeps lifecycle proof generic when an adapter supplies different native semantics", () => {
    const f = fixture();
    const provider = (f.run.runnerProfileJson as any).nativeExecutionInput.provider;
    Object.assign(provider, { kind: "test-provider", agent: "test", mode: "outline" });
    editEvent(f, 0, e => { e.payload.request.origin = { provider: "test", method: "outline/confirm" }; });
    // Unknown providers stay disabled unless the registry supplies an adapter.
    expect(nativePlanWaitFromFacts(f)).toBeNull();
    const adapter: lifecycle.NativeProviderLifecycleAdapter = {
      planWait: {
        admits: p => p.kind === "test-provider" && p.mode === "outline",
        isRequest: r => r.origin.method === "outline/confirm",
        acceptedRevision: () => "outline-revision-7",
        allowsLegacyUnboundTool: () => false,
      },
      isPermissionRequest: () => false,
    };
    const resolver = vi.spyOn(lifecycle, "nativeProviderLifecycle").mockReturnValue(adapter);
    try {
      expect(nativePlanWaitFromFacts(f)?.source.planRevision).toBe("outline-revision-7");
      f.interactions[0]!.delivery.acknowledgedAt = null;
      expect(nativePlanWaitFromFacts(f)).toBeNull();
    } finally { resolver.mockRestore(); }
  });
  it("replays only committed historical unbound-tool receipts from the exact legacy profile", async () => {
    const f = fixture(); f.run.status = "succeeded";
    const proof = nativePlanWaitFromFacts(f)!;
    const admission = (f.run.runnerProfileJson as any).nativeExecutionInput;
    Object.assign(admission.provider.profile, { agentProfileVersion: 6, commandDigest: "sha256:377dcea64a727ce799cc112458d4b40ba4bc6574cd6c6f7233b6efd5917a6c4b" });
    admission.provider.cursorMode = "plan"; delete admission.provider.mode;
    f.events = f.events.filter(e => !e.eventType.startsWith("tool.execution."));
    const payload = (type: string) => (f.events.find(e => e.eventType === type)!.payload as any).prpEvent;
    const { interaction, delivery } = f.interactions[0]!;
    const source = { ...proof.source, schema: "paperclip.native_cursor_plan_wait.v1", authoritySha256: nativeSha256({ admission, contract: f.contract,
      created: payload("runtime_request.created"), resolved: payload("runtime_request.resolved"), terminal: payload("turn.completed"),
      interaction, delivery, resolvedAt: interaction.resolvedAt!.toISOString(), acknowledgedAt: delivery.acknowledgedAt!.toISOString() }) };
    delete source.toolExecutionId; delete source.toolLifecycleSha256;
    proof.result.continuation!.idempotencyKey = proof.result.continuation!.idempotencyKey.replace("native-plan-wait:", "cursor-plan-wait:");
    expect(nativePlanWaitFromFacts(f)).toBeNull();
    expect(await hasCommittedNativePlanWait(committedDb(f, source, proof.result, true), f.binding)).toBe(true);
    admission.provider.profile.agentProfileVersion = 7;
    expect(await hasCommittedNativePlanWait(committedDb(f, source, proof.result, true), f.binding)).toBe(false);
  });
  it("settles a long plan while binding every progress event into its proof", () => {
    const f = withProgress(2_000);
    const proof = nativePlanWaitFromFacts(f);
    expect(proof).not.toBeNull();
    const progress = f.events[1_200]!;
    (progress.payload as any).prpEvent.payload.name = "updated diagnostic text";
    progress.sourcePayloadSha256 = nativeSha256((progress.payload as any).prpEvent);
    const changed = nativePlanWaitFromFacts(f);
    expect(changed).not.toBeNull();
    expect(changed!.source.toolLifecycleSha256).not.toBe(proof!.source.toolLifecycleSha256);
    expect(changed!.source.authoritySha256).not.toBe(proof!.source.authoritySha256);
  });
  it.each(["foreign tool", "foreign session", "tampered digest", "late progress"])("rejects %s beyond the first thousand events", kind => {
    const f = withProgress(2_000), row = f.events[1_200]!;
    const event = (row.payload as any).prpEvent;
    if (kind === "foreign tool") event.payload.executionId = "unrelated";
    if (kind === "foreign session") event.normalizedSessionId = "other";
    if (kind === "late progress") { f.events.splice(1_200, 1); f.events.push(row); resequence(f); }
    row.sourcePayloadSha256 = kind === "tampered digest" ? "tampered" : nativeSha256(event);
    expect(nativePlanWaitFromFacts(f)).toBeNull();
  });
  it("fails closed only at the separate progress and control-event budgets", () => {
    expect(nativePlanWaitFromFacts(withProgress(20_000))).not.toBeNull();
    expect(nativePlanWaitFromFacts(withProgress(20_001))).toBeNull();
    const f = withProgress(1_200);
    const turnStart = structuredClone(f.events[0]!);
    turnStart.eventType = "turn.started";
    Object.assign((turnStart.payload as any).prpEvent, { eventType: "turn.started", payload: {} });
    f.events.unshift(...Array.from({ length: 995 }, () => structuredClone(turnStart)));
    resequence(f);
    expect(nativePlanWaitFromFacts(f)).not.toBeNull();
    f.events.unshift(structuredClone(turnStart)); resequence(f);
    expect(nativePlanWaitFromFacts(f)).toBeNull();
  });
  it("preserves an exact committed wait using the pre-release field without admitting new legacy waits", async () => {
    const f = fixture();
    f.run.status = "succeeded";
    const proof = nativePlanWaitFromFacts(f)!;
    const admission = (f.run.runnerProfileJson as any).nativeExecutionInput;
    admission.provider.cursorMode = admission.provider.mode;
    delete admission.provider.mode;
    expect(nativePlanWaitFromFacts(f)).toBeNull();
    const payload = (type: string) => (f.events.find(e => e.eventType === type)!.payload as any).prpEvent;
    const { interaction, delivery } = f.interactions[0]!;
    const toolBinding = { toolExecutionId: proof.source.toolExecutionId, toolLifecycleSha256: proof.source.toolLifecycleSha256 };
    const source = { ...proof.source, schema: "paperclip.native_cursor_plan_wait.v1", authoritySha256: nativeSha256({ admission, contract: f.contract,
      created: payload("runtime_request.created"), resolved: payload("runtime_request.resolved"), terminal: payload("turn.completed"),
      interaction, delivery, resolvedAt: interaction.resolvedAt!.toISOString(), acknowledgedAt: delivery.acknowledgedAt!.toISOString(), toolBinding }) };
    proof.result.continuation!.idempotencyKey = proof.result.continuation!.idempotencyKey.replace("native-plan-wait:", "cursor-plan-wait:");
    const resultJson = { result: proof.result, terminal: { schema: "paperclip.prp.terminal.v1", runTerminalState: "succeeded", turnTerminalState: "completed", reportedWorkDisposition: "yielded" } };
    const canonicalSha256 = nativeSha256(resultJson);
    const db = () => {
      const rows = [
        [{ decision: { decisionJson: { cursorPlanWait: source, cursorPlanWaitResult: { resultId: "result", resultSha256: canonicalSha256 } } },
          result: { id: "result", canonicalSha256, completionContractId: source.contractId, turnId: source.turnId, resultJson } }],
        [{ run: f.run, contract: f.contract }], f.events, f.interactions,
        [{ ...f.run, createdAt: new Date(0) }], [interaction], [], [],
      ];
      return { select: () => {
        const result = rows.shift();
        const query: any = { from: () => query, innerJoin: () => query, where: () => query, orderBy: () => query, limit: () => Promise.resolve(result) };
        return query;
      } } as never;
    };
    expect(await hasCommittedNativePlanWait(db(), f.binding)).toBe(true);
    // History is immutable: neither changing the old mode nor rewriting its
    // field name may preserve the original acceptance authority.
    admission.provider.cursorMode = "agent";
    expect(await hasCommittedNativePlanWait(db(), f.binding)).toBe(false);
    delete admission.provider.cursorMode;
    admission.provider.mode = "plan";
    expect(await hasCommittedNativePlanWait(db(), f.binding)).toBe(false);
  });

  it("records the accepted revision and explicitly unfinished Plan-mode continuation", () => {
    const value = nativePlanWaitFromFacts(fixture());
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
    expect(nativePlanWaitFromFacts(f)).toBeNull();
  });
  it("rejects an additional same-title tool while the real plan tool remains correlated", () => {
    const f = fixture();
    const extra = structuredClone(f.events.find(row => row.eventType === "tool.execution.started")!);
    extra.seq = 295; extra.sourceSeq = 295; extra.sourceEventId = "instance:295";
    const e = (extra.payload as any).prpEvent;
    Object.assign(e, { sourceSeq: 295, sourceEventId: extra.sourceEventId });
    Object.assign(e.payload, { executionId: "unrelated", name: "Create Plan" });
    extra.sourcePayloadSha256 = nativeSha256(e); f.events.splice(2, 0, extra);
    expect(nativePlanWaitFromFacts(f)).toBeNull();
  });
  it("binds actual callback-before-tool-start order without trusting display names", () => {
    const f = fixture(); const original = nativePlanWaitFromFacts(f)!;
    expect(original.source.toolLifecycleSha256).toMatch(/^[a-f0-9]{64}$/);
    const start = f.events.find(row => row.eventType === "tool.execution.started")!;
    (start.payload as any).prpEvent.payload.name = "changed display text";
    start.sourcePayloadSha256 = nativeSha256((start.payload as any).prpEvent);
    const changed = nativePlanWaitFromFacts(f)!;
    expect(changed).not.toBeNull();
    expect(changed.source.authoritySha256).not.toBe(original.source.authoritySha256);
    expect(changed.source.toolLifecycleSha256).not.toBe(original.source.toolLifecycleSha256);
  });
  it("preserves a valid v11 plan wait saved before production promotion", () => {
    const facts = fixture();
    (facts.run.runnerProfileJson as any).nativeExecutionInput.provider.profile.qualificationStatus = "pending";
    const saved = nativePlanWaitFromFacts(facts);
    expect(saved).not.toBeNull();
    expect(saved!.result.reportedWorkDisposition).toBe("yielded");
    expect(saved!.result.completionClaim.objectiveSatisfied).toBe(false);
  });
  it("does not create a new wait from an earlier profile after the catalog advances", () => {
    const facts = fixture();
    expect(nativePlanWaitFromFacts(facts)).not.toBeNull();
    const current = resolveQualifiedAcpxProfile("cursor", "gpt-5.6-luna[context=272k,reasoning=medium,fast=false]");
    // Model a future catalog revision without tying this test to today's version.
    const next = { ...current, agentProfileVersion: (current.agentProfileVersion + 1) as typeof current.agentProfileVersion, commandDigest: `sha256:${"b".repeat(64)}` } satisfies typeof current;
    expect(next.agentProfileVersion).toBeGreaterThan(current.agentProfileVersion);
    const resolver = vi.spyOn(runner, "resolveQualifiedAcpxProfile").mockReturnValue(next);
    try { expect(nativePlanWaitFromFacts(facts)).toBeNull(); }
    finally { resolver.mockRestore(); }
  });
  it("projects only declared scope keys from a wider typed caller binding", () => {
    const f = fixture(); Object.assign(f.binding, { wakeupRequestId: "unrelated-caller-metadata" });
    const proof = nativePlanWaitFromFacts(f);
    expect(proof).not.toBeNull();
    expect(proof!.source).not.toHaveProperty("wakeupRequestId");
  });
  it.each([
    ["foreign runner", (f: PlanWaitFacts) => { f.run.runnerInstanceId = "other"; }],
    ["changed admission binding", (f: PlanWaitFacts) => { (f.run.runnerProfileJson as any).nativeExecutionInput.binding = { ...f.binding, runId: "other" }; }],
    ["wrong company", (f: PlanWaitFacts) => { f.run.companyId = "other"; }],
    ["wrong task", (f: PlanWaitFacts) => { f.run.nativeIssueId = "other"; }],
    ["failed run", (f: PlanWaitFacts) => { f.run.status = "failed"; }],
    ["cancelled run", (f: PlanWaitFacts) => { f.run.status = "cancelled"; }],
    ["Agent mode", (f: PlanWaitFacts) => { (f.run.runnerProfileJson as any).nativeExecutionInput.provider.mode = "agent"; }],
    ["stale profile", (f: PlanWaitFacts) => { (f.run.runnerProfileJson as any).nativeExecutionInput.provider.profile = { ...resolveQualifiedAcpxProfile("cursor", "gpt-5.6-luna[context=272k,reasoning=medium,fast=false]"), commandDigest: "old" }; }],
    ["changed contract policy", (f: PlanWaitFacts) => { f.contract.policyVersion = "tampered-policy"; }],
    ["changed completion authority", (f: PlanWaitFacts) => { f.contract.completionAuthority = "server_arbiter"; }],
    ["changed contract hash", (f: PlanWaitFacts) => { f.contract.canonicalSha256 = "f".repeat(64); }],
    ["changed contract", (f: PlanWaitFacts) => { f.contract.contractJson.revision = "new"; }],
    ["unknown origin", (f: PlanWaitFacts) => editEvent(f, 0, e => { e.payload.request.origin.provider = "acpx"; })],
    ["wrong method", (f: PlanWaitFacts) => editEvent(f, 0, e => { e.payload.request.origin.method = "cursor/ask_question"; })],
    ["untrusted adapter", (f: PlanWaitFacts) => editEvent(f, 0, e => { e.payload.request.origin.adapter = "other"; })],
    ["cross turn", (f: PlanWaitFacts) => editEvent(f, 1, e => { e.turnId = "other"; })],
    ["cross session", (f: PlanWaitFacts) => editEvent(f, 1, e => { e.normalizedSessionId = "other"; })],
    ["native error", (f: PlanWaitFacts) => editEvent(f, 2, e => { e.payload.error = { message: "failure" }; })],
    ["changed plan", (f: PlanWaitFacts) => editEvent(f, 0, e => { e.payload.request.input.description = "other"; })],
    ["rejection", (f: PlanWaitFacts) => editEvent(f, 1, e => { e.payload.response.answers[`plan-${"a".repeat(64)}`].selectedOptionIds = ["reject"]; })],
    ["cancellation", (f: PlanWaitFacts) => editEvent(f, 1, e => { e.payload.response.answers[`plan-${"a".repeat(64)}`].selectedOptionIds = ["cancel"]; })],
    ["missing delivery", (f: PlanWaitFacts) => { f.interactions = []; }],
    ["unacknowledged delivery", (f: PlanWaitFacts) => { f.interactions[0]!.delivery.acknowledgedAt = null; }],
    ["fallback wake", (f: PlanWaitFacts) => { f.interactions[0]!.delivery.deliveryMode = "wake_fallback"; }],
    ["wrong target", (f: PlanWaitFacts) => { f.interactions[0]!.delivery.targetRunId = "other"; }],
    ["changed answer digest", (f: PlanWaitFacts) => { f.interactions[0]!.delivery.payloadSha256 = "other"; }],
    ["missing resolution time", (f: PlanWaitFacts) => { f.interactions[0]!.interaction.resolvedAt = null; }],
    ["agent resolved", (f: PlanWaitFacts) => { f.interactions[0]!.interaction.resolvedByAgentId = "agent"; }],
    ["duplicate receipt", (f: PlanWaitFacts) => { f.events.splice(1, 0, structuredClone(f.events[0]!)); }],
    ["duplicate delivery", (f: PlanWaitFacts) => { f.interactions.push(structuredClone(f.interactions[0]!)); }],
    ["uncommitted event", (f: PlanWaitFacts) => { f.events[1]!.sourcePayloadSha256 = null; }],
    ["changed row identity", (f: PlanWaitFacts) => { f.events[1]!.sourceEventId = "other"; }],
    ["terminal before answer", (f: PlanWaitFacts) => { f.events.reverse(); }],
  ] as const)("rejects %s", (_name, mutate) => {
    const f = fixture(); mutate(f); expect(nativePlanWaitFromFacts(f)).toBeNull();
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
      expect(nativePlanWaitFromFacts(f)).toBeNull();
    }
  });
});
